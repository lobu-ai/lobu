import { createHash } from "node:crypto";
import type { Context } from "hono";
import { type ConnectorPolicyKind, canonicalConnectorPolicyScope } from "../authz/connector-policy";
import {
  deleteEntityApprovalPolicy,
  type EntityApprovalPolicy,
  type EntityApprovalPolicyInput,
  listEntityApprovalPolicies,
  upsertEntityApprovalPolicy,
  validatePolicyKindAndNote,
  withConnectorPolicyTransaction,
} from "../authz/entity-policy";
import type { DbClient } from "../db/client";
import * as invalidationEmitter from "../events/emitter";
import { parsePolicy, requireHumanWorkspaceAdmin, serializeEntityApprovalPolicy, validateConnectorPolicyTarget } from "./permission-policy-write";

function scopeKey(policy: EntityApprovalPolicyInput) {
  const scope = canonicalConnectorPolicyScope(policy);
  // A grant and a guardrail may share one scope; kind is part of the rule's identity.
  return JSON.stringify([scope.connectorKey, scope.connectionId, policy.operationKey ?? null, scope.operationCategory, policy.kind ?? "grant"]);
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
  };
}

/** No query = the org rules; `principal_kind=app` (optionally with one app key) = rules for connected apps. */
type CollectionPrincipal = { principalKind: "app" | null; principalId: string | null };

const APP_KEY_PREFIXES = ["web:", "client:", "local:", "pat:"];

function collectionPrincipal(c: Context): CollectionPrincipal | string {
  const kind = c.req.query("principal_kind");
  const id = c.req.query("principal_id");
  if (kind === undefined) return id === undefined ? { principalKind: null, principalId: null } : "principal_id requires principal_kind=app.";
  if (kind !== "app") return "principal_kind must be 'app'; agent rules are managed on the agent.";
  if (id === undefined) return { principalKind: "app", principalId: null };
  if (id.length > 255 || id.trim() !== id || !APP_KEY_PREFIXES.some(prefix => id.startsWith(prefix) && id.length > prefix.length)) {
    return "principal_id must be an app key: web:<domain>, client:<id>, local:<name> or pat:<id>.";
  }
  // Derived web keys are lowercase; a mixed-case rule would never match a caller.
  if (id.startsWith("web:") && id !== id.toLowerCase()) return "A web: app key must be lowercase.";
  return { principalKind: "app", principalId: id };
}

async function readSnapshot(org: string, principal: CollectionPrincipal, tx?: DbClient) {
  const policies = (await listEntityApprovalPolicies(org, "connector_action", tx))
    .filter(p => p.principalKind === principal.principalKind && (principal.principalKind === null || p.principalId === principal.principalId) &&
      p.effects.execute !== undefined)
    .sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  // Include stored identity and delivery: changing either invalidates a previously reviewed plan.
  // An app collection also binds its principal, so a plan cannot move between collections.
  const reviewed = JSON.stringify(policies.map(serializeEntityApprovalPolicy));
  const revision = createHash("sha256").update(principal.principalKind === null ? reviewed : JSON.stringify([principal, reviewed])).digest("hex");
  return { policies, revision, rules: policies.map(serializeRule) };
}

/** Saved rules only: catalog metadata belongs to the existing inspection endpoint. */
export async function readConnectorPolicyCollection(c: Context) {
  const denied = requireHumanWorkspaceAdmin(c, { acceptPolicyToken: true });
  if (denied) return denied;
  const principal = collectionPrincipal(c);
  if (typeof principal === "string") return c.json({ error: "invalid_request", message: principal }, 400);
  const { revision, rules } = await readSnapshot(c.get("organizationId")!, principal);
  return c.json({ revision, rules });
}

/** Replace the org's connector rules as one compare-and-swap, preserving every other policy class/principal. */
export async function replaceConnectorPolicyCollection(c: Context) {
  const denied = requireHumanWorkspaceAdmin(c, { acceptPolicyToken: true });
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
    policies = body.rules.map((rule: unknown) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        Object.keys(rule).some(key => !["id", "connector_key", "connection_id", "operation_key", "operation_category", "effect", "kind", "note"].includes(key))) {
        throw new Error("A rule accepts only id, connector_key, connection_id, operation_key, operation_category, effect, kind, and note.");
      }
      // `id` is read-only: clients echo it back, but scope and kind identify the rule.
      const { id, effect, kind, note, ...scope } = rule as Record<string, unknown>;
      if (id !== undefined && !(Number.isSafeInteger(id) && (id as number) > 0)) throw new Error("id must be a positive integer.");
      const parsed = parsePolicy({ ...scope, resource_class: "connector_action", effects: { execute: effect } }, false);
      // The collection is the whole desired state, so an omitted note clears it.
      const checked = validatePolicyKindAndNote({ ...parsed, kind: kind as ConnectorPolicyKind | undefined, note: (note ?? null) as string | null });
      // An app rule can only tighten what the app's user may do, so it is always a guardrail.
      if (principal.principalKind === "app" && checked.kind !== "guardrail") throw new Error("A rule for an app must be a guardrail; use a workspace grant to allow.");
      const policy = { ...parsed, ...principal, kind: checked.kind, note: checked.note ?? null };
      const key = scopeKey(policy);
      if (scopes.has(key)) throw new Error("Duplicate policy scope.");
      scopes.add(key);
      return policy;
    });
  } catch (error) {
    return c.json({ error: "invalid_request", message: (error as Error).message }, 400);
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
