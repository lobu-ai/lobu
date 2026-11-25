import { createHash } from "node:crypto";
import type { Context } from "hono";
import { type ConnectorPolicyKind, canonicalConnectorPolicyScope } from "../authz/connector-policy";
import {
  automationIdFromPrincipalId,
  deleteEntityApprovalPolicy,
  type EntityApprovalPolicy,
  type EntityApprovalPolicyInput,
  listEntityApprovalPolicies,
  upsertEntityApprovalPolicy,
  validatePolicyKindAndNote,
  withConnectorPolicyTransaction,
} from "../authz/entity-policy";
import { parsePolicyConditions, policyConditionsKey } from "../authz/policy-conditions";
import { appKeyProblem, resolvePolicyPrincipal } from "../authz/policy-principal";
import { POLICY_WRITE_SCOPE } from "../auth/oauth/scopes";
import { type DbClient, getDb } from "../db/client";
import * as invalidationEmitter from "../events/emitter";
import { parsePolicy, requireHumanWorkspaceAdmin, serializeEntityApprovalPolicy, validateConnectorPolicyTarget } from "./permission-policy-write";

function scopeKey(policy: EntityApprovalPolicyInput) {
  const scope = canonicalConnectorPolicyScope(policy);
  // A grant and a guardrail may share one scope; kind, audience and conditions are part of the rule's identity.
  return JSON.stringify([scope.connectorKey, scope.connectionId, policy.operationKey ?? null, scope.operationCategory, policy.kind ?? "grant", policy.audience ?? null,
    policyConditionsKey(policy.condition ?? null)]);
}

function serializeRule(policy: EntityApprovalPolicy) {
  return {
    id: policy.id,
    ...(policy.connectorKey === null ? {} : { connector_key: policy.connectorKey }),
    ...(policy.connectionId === null ? {} : { connection_id: policy.connectionId }),
    ...(policy.operationKey === null ? {} : { operation_key: policy.operationKey }),
    ...(policy.operationCategory === null ? {} : { operation_category: policy.operationCategory }),
    effect: policy.effects.execute,
    ...(policy.kind === "grant" ? {} : { kind: policy.kind }),
    ...(policy.note === null ? {} : { note: policy.note }),
    ...(policy.audience === null ? {} : { audience: policy.audience }),
    ...(policy.condition === null ? {} : { when: policy.condition }),
  };
}

/**
 * No query = the org rules; `principal_kind=app` or `automation` (optionally
 * with one app key or `automation:<id>`) = rules for connected apps or Automations.
 */
type CollectionPrincipal = { principalKind: "app" | "automation" | null; principalId: string | null };


function collectionPrincipal(c: Context): CollectionPrincipal | string {
  const kind = c.req.query("principal_kind");
  const id = c.req.query("principal_id");
  if (kind === undefined) return id === undefined ? { principalKind: null, principalId: null } : "principal_id requires principal_kind=app or automation.";
  if (kind !== "app" && kind !== "automation") return "principal_kind must be 'app' or 'automation'; agent rules are managed on the agent.";
  if (id === undefined) return { principalKind: kind, principalId: null };
  if (kind === "automation") {
    return automationIdFromPrincipalId(id) === null ? "principal_id must be automation:<id>." : { principalKind: "automation", principalId: id };
  }
  const problem = appKeyProblem(id, "principal_id");
  return problem ?? { principalKind: "app", principalId: id };
}

/**
 * An app or Automation may hold one kind of grant: Always allow for one action
 * on one connection, named by its own id. Anything else it is given only tightens.
 */
function callerGrantProblem(principal: CollectionPrincipal, policy: EntityApprovalPolicyInput) {
  const noun = principal.principalKind === "app" ? "an app" : "an Automation";
  if (policy.effects?.execute !== "auto" || principal.principalId === null) {
    throw new Error(`A rule for ${noun} must be a guardrail; use a workspace grant to allow.`);
  }
  // A local client names itself, so any local tool could claim the name.
  if (principal.principalId.startsWith("local:")) {
    throw new Error("An app that only names itself (local:) can't be allowed; add a workspace rule instead.");
  }
  if (policy.connectionId === null || !policy.operationKey || policy.operationCategory !== null) {
    throw new Error("An app or Automation can only be allowed one action on one connection.");
  }
}

async function automationExists(org: string, principalId: string) {
  const id = automationIdFromPrincipalId(principalId);
  const rows = await getDb()`SELECT 1 FROM automations WHERE organization_id = ${org} AND id = ${id} LIMIT 1`;
  return rows.length > 0;
}

function snapshotOf(all: readonly EntityApprovalPolicy[], principal: CollectionPrincipal) {
  const policies = all
    .filter(p => p.principalKind === principal.principalKind && (principal.principalKind === null || p.principalId === principal.principalId) &&
      p.effects.execute !== undefined)
    .sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  // Include stored identity and delivery: changing either invalidates a previously reviewed plan.
  // An app collection also binds its principal, so a plan cannot move between collections.
  const reviewed = JSON.stringify(policies.map(serializeEntityApprovalPolicy));
  const revision = createHash("sha256").update(principal.principalKind === null ? reviewed : JSON.stringify([principal, reviewed])).digest("hex");
  return { policies, revision, rules: policies.map(serializeRule) };
}

async function readSnapshot(org: string, principal: CollectionPrincipal, tx?: DbClient) {
  return snapshotOf(await listEntityApprovalPolicies(org, "connector_action", tx), principal);
}

/** Saved rules only: catalog metadata belongs to the existing inspection endpoint. */
export async function readConnectorPolicyCollection(c: Context) {
  const denied = requireHumanWorkspaceAdmin(c, { acceptScopedToken: POLICY_WRITE_SCOPE });
  if (denied) return denied;
  const principal = collectionPrincipal(c);
  if (typeof principal === "string") return c.json({ error: "invalid_request", message: principal }, 400);
  const { revision, rules } = await readSnapshot(c.get("organizationId")!, principal);
  return c.json({ revision, rules });
}

/**
 * Every app and Automation with rules of its own. Each entry is exactly what that
 * caller's collection GET returns, so edits go through the collection PUT.
 */
export async function readConnectorPolicyCallers(c: Context) {
  const denied = requireHumanWorkspaceAdmin(c, { acceptScopedToken: POLICY_WRITE_SCOPE });
  if (denied) return denied;
  if (Object.keys(c.req.queries()).length) return c.json({ error: "invalid_request", message: "This endpoint takes no query parameters." }, 400);
  const org = c.get("organizationId")!;
  const all = await listEntityApprovalPolicies(org, "connector_action");
  const principals = new Map<string, { principalKind: "app" | "automation"; principalId: string }>();
  for (const policy of all) {
    const { principalKind, principalId } = policy;
    if ((principalKind === "app" || principalKind === "automation") && principalId !== null && policy.effects.execute !== undefined) {
      principals.set(JSON.stringify([principalKind, principalId]), { principalKind, principalId });
    }
  }
  const sql = getDb();
  const callers = await Promise.all([...principals.values()].map(async principal => {
    const { revision, rules } = snapshotOf(all, principal);
    const { label } = await resolvePolicyPrincipal(sql, org, { kind: principal.principalKind, id: principal.principalId });
    return { principal_kind: principal.principalKind, principal_id: principal.principalId, label, revision, rules };
  }));
  // A caller that is gone has no label; it is still listed so its rules can be cleared.
  const sortName = (caller: { label: string | null; principal_id: string }) => (caller.label ?? caller.principal_id).toLowerCase();
  callers.sort((a, b) => a.principal_kind.localeCompare(b.principal_kind) || sortName(a).localeCompare(sortName(b)) ||
    a.principal_id.localeCompare(b.principal_id));
  return c.json({ callers });
}

/** Replace the org's connector rules as one compare-and-swap, preserving every other policy class/principal. */
export async function replaceConnectorPolicyCollection(c: Context) {
  const denied = requireHumanWorkspaceAdmin(c, { acceptScopedToken: POLICY_WRITE_SCOPE });
  if (denied) return denied;
  const org = c.get("organizationId")!;
  const principal = collectionPrincipal(c);
  if (typeof principal === "string") return c.json({ error: "invalid_request", message: principal }, 400);
  let revision: string;
  let policies: EntityApprovalPolicyInput[];
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["revision", "rules"].includes(key)) ||
      typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision) || !Array.isArray(body.rules)) {
      throw new Error("Expected { revision, rules }; revision must come from the current policy collection.");
    }
    revision = body.revision;
    const scopes = new Set<string>();
    policies = body.rules.map((rule: unknown, index: number) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        Object.keys(rule).some(key => !["id", "connector_key", "connection_id", "operation_key", "operation_category", "effect", "kind", "note", "audience", "when"].includes(key))) {
        throw new Error("A rule accepts only id, connector_key, connection_id, operation_key, operation_category, effect, kind, note, audience, and when.");
      }
      // `id` is read-only: clients echo it back, but scope, kind and conditions identify the rule.
      const { id, effect, kind, note, when, ...scope } = rule as Record<string, unknown>;
      if (id !== undefined && !(Number.isSafeInteger(id) && (id as number) > 0)) throw new Error("id must be a positive integer.");
      const parsed = parsePolicy({ ...scope, resource_class: "connector_action", effects: { execute: effect } }, false);
      // The collection is the whole desired state, so an omitted note clears it.
      const checked = validatePolicyKindAndNote({ ...parsed, kind: kind as ConnectorPolicyKind | undefined, note: (note ?? null) as string | null });
      if (principal.principalKind !== null && checked.kind !== "guardrail") callerGrantProblem(principal, parsed);
      const condition = when == null ? null : parsePolicyConditions(when, `rules[${index}].when`);
      const policy = { ...parsed, ...principal, kind: checked.kind, note: checked.note ?? null, condition };
      const key = scopeKey(policy);
      if (scopes.has(key)) throw new Error("Duplicate policy scope.");
      scopes.add(key);
      return policy;
    });
  } catch (error) {
    return c.json({ error: "invalid_request", message: (error as Error).message }, 400);
  }
  // Clearing the rules of a deleted Automation stays possible.
  if (principal.principalKind === "automation" && principal.principalId !== null && policies.length &&
    !(await automationExists(org, principal.principalId))) {
    return c.json({ error: "invalid_request", message: "Automation not found in this workspace." }, 400);
  }
  const current = await readSnapshot(org, principal);
  if (revision !== current.revision) return c.json({ error: "policy_conflict", message: "Policies changed. Reload and review the current rules before applying." }, 409);
  const unchanged = new Map(current.policies.map(policy => [scopeKey(policy), policy.effects.execute]));
  // Retained rules survive catalog removal; new grants still need a live target.
  // Discovery may contact connector providers; never hold a database lock during it.
  for (const policy of policies) {
    if (unchanged.get(scopeKey(policy)) === policy.effects?.execute) continue;
    const targetError = await validateConnectorPolicyTarget(org, policy, c.get("user")!.id);
    if (targetError) return c.json({ error: "invalid_request", message: targetError }, 400);
  }
  const result = await withConnectorPolicyTransaction(org, async tx => {
    const before = await readSnapshot(org, principal, tx);
    if (revision !== before.revision) return c.json({ error: "policy_conflict", message: "Policies changed. Reload and review the current rules before applying." }, 409);
    const desired = new Set(policies.map(scopeKey));
    for (const policy of policies) await upsertEntityApprovalPolicy(org, policy, tx);
    for (const old of before.policies) {
      if (!desired.has(scopeKey(old))) await deleteEntityApprovalPolicy({ ...old, organizationId: org }, tx);
    }
    const { revision: nextRevision, rules } = await readSnapshot(org, principal, tx);
    return c.json({ revision: nextRevision, rules });
  });
  if (result.status === 200) invalidationEmitter.emit(org, { keys: ["write-permissions", "agent-permissions"] });
  return result;
}
