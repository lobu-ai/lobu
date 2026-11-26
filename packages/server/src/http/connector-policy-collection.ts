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
import { classifyConditionProblem, withClassifyModel } from "../authz/policy-classify";
import { type PolicyCondition, parsePolicyConditions, policyConditionsKey } from "../authz/policy-conditions";
import { isPolicyHook, loopPolicyCutoverComplete, parsePolicyToolPatterns, type PolicyHook } from "../authz/policy-hooks";
import { appKeyProblem, resolvePolicyPrincipal } from "../authz/policy-principal";
import { POLICY_WRITE_SCOPE } from "../auth/oauth/scopes";
import { type DbClient, getDb } from "../db/client";
import * as invalidationEmitter from "../events/emitter";
import { agentExists, parsePolicy, requireHumanWorkspaceAdmin, serializeEntityApprovalPolicy, validateConnectorPolicyTarget } from "./permission-policy-write";

function scopeKey(policy: EntityApprovalPolicyInput) {
  const scope = canonicalConnectorPolicyScope(policy);
  // A grant and a guardrail may share one scope; kind, audience and conditions are part of the rule's identity.
  const key = [scope.connectorKey, scope.connectionId, policy.operationKey ?? null, scope.operationCategory, policy.kind ?? "grant", policy.audience ?? null,
    policyConditionsKey(policy.condition ?? null)];
  return JSON.stringify(policy.hook && policy.hook !== "operation" ? [...key, policy.hook, policy.toolPatterns ?? null] : key);
}

function serializeRule(policy: EntityApprovalPolicy) {
  return {
    id: policy.id,
    ...(policy.connectorKey === null ? {} : { connector_key: policy.connectorKey }),
    ...(policy.connectionId === null ? {} : { connection_id: policy.connectionId }),
    ...(policy.operationKey === null ? {} : { operation_key: policy.operationKey }),
    ...(policy.operationCategory === null ? {} : { operation_category: policy.operationCategory }),
    effect: policy.effects.execute,
    ...(policy.hook === "operation" ? {} : { hook: policy.hook }),
    ...(policy.toolPatterns === null ? {} : { tools: policy.toolPatterns }),
    ...(policy.kind === "grant" ? {} : { kind: policy.kind }),
    ...(policy.note === null ? {} : { note: policy.note }),
    ...(policy.audience === null ? {} : { audience: policy.audience }),
    ...(policy.condition === null ? {} : { when: policy.condition }),
  };
}

type CollectionPrincipal = { principalKind: "app" | "automation" | "agent" | null; principalId: string | null };

function collectionPrincipal(c: Context, hook: PolicyHook): CollectionPrincipal | string {
  const kind = c.req.query("principal_kind");
  const id = c.req.query("principal_id");
  if (kind === undefined) return id === undefined ? { principalKind: null, principalId: null } : "principal_id requires principal_kind.";
  if (kind !== "app" && kind !== "automation" && !(kind === "agent" && hook !== "operation")) {
    return hook === "operation" ? "principal_kind must be 'app' or 'automation'; agent rules are managed on the agent."
      : "principal_kind must be 'app', 'automation', or 'agent'.";
  }
  if (id === undefined) return { principalKind: kind, principalId: null };
  if (kind === "agent") {
    return id.length > 0 && id.length <= 128 && id === id.trim() && !id.includes("\0")
      ? { principalKind: kind, principalId: id } : "principal_id must be an agent ID.";
  }
  if (kind === "automation") {
    return automationIdFromPrincipalId(id) === null ? "principal_id must be automation:<id>." : { principalKind: "automation", principalId: id };
  }
  const problem = appKeyProblem(id, "principal_id");
  return problem ?? { principalKind: "app", principalId: id };
}

async function collectionSelection(c: Context) {
  const org = c.get("organizationId")!;
  const hook = c.req.query("hook") ?? "operation";
  const requireSession = hook !== "operation" && c.req.query("principal_kind") === "agent";
  const denied = requireHumanWorkspaceAdmin(c, requireSession ? {} : { acceptScopedToken: POLICY_WRITE_SCOPE });
  if (denied) return denied;
  if (!isPolicyHook(hook)) return c.json({ error: "invalid_request", message: "Invalid policy hook." }, 400);
  const principal = collectionPrincipal(c, hook);
  if (typeof principal === "string") return c.json({ error: "invalid_request", message: principal }, 400);
  if (principal.principalKind === "agent" && principal.principalId !== null && !(await agentExists(org, principal.principalId))) {
    return c.json({ error: "invalid_request", message: "Agent not found in this workspace." }, 400);
  }
  if (hook !== "operation" && !(await loopPolicyCutoverComplete(getDb()))) {
    return c.json({ error: "not_found", message: "Loop policies are not available yet." }, 404);
  }
  return { org, hook, principal };
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

function snapshotOf(all: readonly EntityApprovalPolicy[], principal: CollectionPrincipal, hook: PolicyHook = "operation") {
  const policies = all
    .filter(p => p.principalKind === principal.principalKind && (principal.principalKind === null || p.principalId === principal.principalId) &&
      p.effects.execute !== undefined)
    .sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  // Include stored identity and delivery: changing either invalidates a previously reviewed plan.
  // An app collection also binds its principal, so a plan cannot move between collections.
  const reviewed = JSON.stringify(policies.map(policy => hook === "operation" ? serializeEntityApprovalPolicy(policy)
    : [serializeEntityApprovalPolicy(policy), policy.toolPatterns]));
  const fingerprint = hook === "operation" && principal.principalKind === null ? reviewed
    : JSON.stringify(hook === "operation" ? [principal, reviewed] : [hook, principal, reviewed]);
  const revision = createHash("sha256").update(fingerprint).digest("hex");
  return { policies, revision, rules: policies.map(serializeRule) };
}

async function readSnapshot(org: string, principal: CollectionPrincipal, hook: PolicyHook, tx?: DbClient) {
  return snapshotOf(await listEntityApprovalPolicies(org, "connector_action", tx, hook), principal, hook);
}

/** Saved rules only: catalog metadata belongs to the existing inspection endpoint. */
export async function readConnectorPolicyCollection(c: Context) {
  const selection = await collectionSelection(c);
  if (selection instanceof Response) return selection;
  const { org, principal, hook } = selection;
  const { revision, rules } = await readSnapshot(org, principal, hook);
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
  const selection = await collectionSelection(c);
  if (selection instanceof Response) return selection;
  const { org, principal, hook } = selection;
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
    policies = [];
    const commonKeys = ["id", "effect", "kind", "note", "when"];
    const acceptedKeys = hook === "operation"
      ? [...commonKeys, "connector_key", "connection_id", "operation_key", "operation_category", "audience"]
      : [...commonKeys, "hook", ...(hook === "tool_call" ? ["tools"] : [])];
    for (const [index, rule] of (body.rules as unknown[]).entries()) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        Object.keys(rule).some(key => !acceptedKeys.includes(key))) {
        throw new Error(`rules[${index}] accepts only ${acceptedKeys.join(", ")}.`);
      }
      // `id` is read-only: clients echo it back, but scope, kind and conditions identify the rule.
      const { id, effect, kind, note, when, hook: ruleHook, tools, ...scope } = rule as Record<string, unknown>;
      if (id !== undefined && !(Number.isSafeInteger(id) && (id as number) > 0)) throw new Error("id must be a positive integer.");
      if (ruleHook !== undefined && ruleHook !== hook) throw new Error(`rules[${index}].hook must match ${hook}.`);
      if (hook !== "operation" && (effect !== "log" && effect !== "deny" || kind !== undefined && kind !== "guardrail")) {
        throw new Error(`rules[${index}] must be a Log only or Block guardrail.`);
      }
      const toolPatterns = parsePolicyToolPatterns(hook, tools);
      const parsed = parsePolicy({ ...scope, resource_class: "connector_action", effects: { execute: effect } }, false);
      // The collection is the whole desired state, so an omitted note clears it.
      const checked = validatePolicyKindAndNote({ ...parsed, kind: hook === "operation" ? kind as ConnectorPolicyKind | undefined : "guardrail", note: (note ?? null) as string | null });
      if (principal.principalKind !== null && checked.kind !== "guardrail") callerGrantProblem(principal, parsed);
      // A classify condition runs on the model that was the workspace default when it was written.
      const condition = when == null ? null : await withClassifyModel(org, parsePolicyConditions(when, `rules[${index}].when`));
      const policy = { ...parsed, ...principal, kind: checked.kind, note: checked.note ?? null, condition, hook, toolPatterns };
      const key = scopeKey(policy);
      if (scopes.has(key)) throw new Error("Duplicate policy scope.");
      scopes.add(key);
      policies.push(policy);
    }
  } catch (error) {
    return c.json({ error: "invalid_request", message: (error as Error).message }, 400);
  }
  // Clearing the rules of a deleted Automation stays possible.
  if (principal.principalKind === "automation" && principal.principalId !== null && policies.length &&
    !(await automationExists(org, principal.principalId))) {
    return c.json({ error: "invalid_request", message: "Automation not found in this workspace." }, 400);
  }
  const current = await readSnapshot(org, principal, hook);
  if (revision !== current.revision) return c.json({ error: "policy_conflict", message: "Policies changed. Reload and review the current rules before applying." }, 409);
  const unchanged = new Map(current.policies.map(policy => [scopeKey(policy), policy.effects.execute]));
  // Retained rules survive catalog removal; new grants still need a live target.
  // Discovery may contact connector providers; never hold a database lock during it.
  for (const [index, policy] of policies.entries()) {
    if (unchanged.get(scopeKey(policy)) === policy.effects?.execute) continue;
    for (const [at, condition] of ((policy.condition ?? []) as PolicyCondition[]).entries()) {
      if (!("classify" in condition)) continue;
      const problem = await classifyConditionProblem(org, condition, `rules[${index}].when[${at}]`);
      if (problem) return c.json({ error: "invalid_request", message: problem }, 400);
    }
    if (hook === "operation") {
      const targetError = await validateConnectorPolicyTarget(org, policy, c.get("user")!.id);
      if (targetError) return c.json({ error: "invalid_request", message: targetError }, 400);
    }
  }
  const result = await withConnectorPolicyTransaction(org, async tx => {
    const before = await readSnapshot(org, principal, hook, tx);
    if (revision !== before.revision) return c.json({ error: "policy_conflict", message: "Policies changed. Reload and review the current rules before applying." }, 409);
    const desired = new Set(policies.map(scopeKey));
    for (const policy of policies) await upsertEntityApprovalPolicy(org, policy, tx);
    for (const old of before.policies) {
      if (!desired.has(scopeKey(old))) await deleteEntityApprovalPolicy({ ...old, organizationId: org }, tx);
    }
    const { revision: nextRevision, rules } = await readSnapshot(org, principal, hook, tx);
    return c.json({ revision: nextRevision, rules });
  });
  if (result.status === 200) invalidationEmitter.emit(org, { keys: ["write-permissions", "agent-permissions"] });
  return result;
}
