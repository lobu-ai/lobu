import { createHash } from "node:crypto";
import type { Context } from "hono";
import { POLICY_WRITE_SCOPE } from "../auth/oauth/scopes";
import { canonicalConnectorPolicyScope } from "../authz/connector-policy";
import {
  deleteEntityApprovalPolicy,
  type EntityApprovalPolicy,
  type EntityApprovalPolicyInput,
  listEntityApprovalPolicies,
  upsertEntityApprovalPolicy,
  withConnectorPolicyTransaction,
} from "../authz/entity-policy";
import type { DbClient } from "../db/client";
import * as invalidationEmitter from "../events/emitter";
import { parsePolicy, serializeEntityApprovalPolicy, validateConnectorPolicyTarget } from "./permission-policy-write";

function authorize(c: Context) {
  const org = c.get("organizationId");
  if (!org || !c.get("user")?.id) return c.json({ error: "unauthorized" }, 401);
  if (!["owner", "admin"].includes(c.get("memberRole") ?? "")) return c.json({ error: "forbidden" }, 403);
  const auth = c.get("mcpAuthInfo");
  if (c.get("authSource") === "session" && !auth) return null;
  if (c.get("authSource") === "pat" && auth?.organizationId === org &&
    auth.scopes.includes(POLICY_WRITE_SCOPE) && !auth.agentId && !auth.workerId &&
    !auth.scopes.includes("device_worker:run")) return null;
  return c.json({ error: "forbidden", message: "Use an owner/admin web session or an explicitly granted policies:write token." }, 403);
}

function scopeKey(policy: EntityApprovalPolicyInput) {
  const scope = canonicalConnectorPolicyScope(policy);
  return JSON.stringify([scope.connectorKey, scope.connectionId, policy.operationKey ?? null, scope.operationCategory]);
}

function serializeRule(policy: EntityApprovalPolicy) {
  return {
    ...(policy.connectorKey === null ? {} : { connector_key: policy.connectorKey }),
    ...(policy.connectionId === null ? {} : { connection_id: policy.connectionId }),
    ...(policy.operationKey === null ? {} : { operation_key: policy.operationKey }),
    ...(policy.operationCategory === null ? {} : { operation_category: policy.operationCategory }),
    effect: policy.effects.execute,
  };
}

async function readSnapshot(org: string, tx: DbClient) {
  const policies = (await listEntityApprovalPolicies(org, "connector_action", tx))
    .filter(p => p.principalKind === null && p.effects.execute !== undefined)
    .sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  // Include stored identity and delivery: changing either invalidates a previously reviewed plan.
  const revision = createHash("sha256").update(JSON.stringify(policies.map(serializeEntityApprovalPolicy))).digest("hex");
  return { policies, revision, rules: policies.map(serializeRule) };
}

/** Saved rules only: catalog metadata belongs to the existing inspection endpoint. */
export async function readConnectorPolicyCollection(c: Context) {
  const denied = authorize(c);
  if (denied) return denied;
  return withConnectorPolicyTransaction(c.get("organizationId")!, async tx => {
    const { revision, rules } = await readSnapshot(c.get("organizationId")!, tx);
    return c.json({ revision, rules });
  });
}

/** Replace the org's connector rules as one compare-and-swap, preserving every other policy class/principal. */
export async function replaceConnectorPolicyCollection(c: Context) {
  const denied = authorize(c);
  if (denied) return denied;
  const org = c.get("organizationId")!;
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
        Object.keys(rule).some(key => !["connector_key", "connection_id", "operation_key", "operation_category", "effect"].includes(key))) {
        throw new Error("A rule accepts only connector_key, connection_id, operation_key, operation_category, and effect.");
      }
      const { effect, ...scope } = rule as Record<string, unknown>;
      const policy = parsePolicy({ ...scope, resource_class: "connector_action", effects: { execute: effect } }, false);
      const key = scopeKey(policy);
      if (scopes.has(key)) throw new Error("Duplicate policy scope.");
      scopes.add(key);
      return policy;
    });
  } catch (error) {
    return c.json({ error: "invalid_request", message: (error as Error).message }, 400);
  }
  // Discovery may contact connector providers; never hold a database lock during it.
  for (const policy of policies) {
    const targetError = await validateConnectorPolicyTarget(org, policy, c.get("user")!.id);
    if (targetError) return c.json({ error: "invalid_request", message: targetError }, 400);
  }
  const result = await withConnectorPolicyTransaction(org, async tx => {
    const before = await readSnapshot(org, tx);
    if (revision !== before.revision) return c.json({ error: "policy_conflict", message: "Policies changed. Reload and review the current rules before applying." }, 409);
    const desired = new Set(policies.map(scopeKey));
    for (const policy of policies) await upsertEntityApprovalPolicy(org, policy, tx);
    for (const old of before.policies) {
      if (!desired.has(scopeKey(old))) await deleteEntityApprovalPolicy({ ...old, organizationId: org }, tx);
    }
    const { revision: nextRevision, rules } = await readSnapshot(org, tx);
    return c.json({ revision: nextRevision, rules });
  });
  if (result.status === 200) invalidationEmitter.emit(org, { keys: ["write-permissions", "agent-permissions"] });
  return result;
}
