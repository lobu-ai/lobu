import { afterEach, describe, expect, it } from "vitest";
import type { EntityDiscoverDuplicatesResult } from "@lobu/core/contracts/tools/manage-entity";
import type { ReactionContext } from "@lobu/connector-sdk";
import { compileReactionScript, executeAutomationScript } from "../../../automations/reaction-executor";
import { AUTOMATION_CATALOG_TEMPLATES } from "../../../catalog/automation-templates";
import { createAutomationRun } from "../../../runs/queue-service";
import { buildClientSDK } from "../../../sandbox/client-sdk";
import { runScript } from "../../../sandbox/run-script";
import type { Env } from "../../../index";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAccessToken, createTestAgent, createTestEntity, createTestOAuthClient, ownerToolContext } from "../../setup/test-fixtures";
import { TestMcpClient, TestWorkspace } from "../../setup/test-mcp-client";

afterEach(cleanupTestDatabase);

async function setup() {
  const workspace = await TestWorkspace.create({ name: "Synthetic Discovery" });
  const sql = getTestDb();
  const seed = await createTestEntity({
    name: "Seed", entity_type: "asset",
    organization_id: workspace.org.id, created_by: workspace.users.owner.id,
  });
  const [type] = await sql`SELECT entity_type_id FROM entities WHERE id = ${seed.id}`;
  await sql`UPDATE entity_types SET metadata_schema = ${sql.json({
    "x-lobu-resolution": { rules: [{ fields: ["serial"], normalizer: "exact", onMatch: "review" }] },
  })} WHERE id = ${type.entity_type_id}`;
  const context = ownerToolContext(workspace.org.id, workspace.users.owner.id);
  const sdk = buildClientSDK(context, {} as Env);
  let sequence = 0;
  const entity = async (metadata: Record<string, unknown>) => {
    const row = await createTestEntity({
      name: "Fixture " + ++sequence, entity_type: "asset",
      organization_id: workspace.org.id, created_by: workspace.users.owner.id,
    });
    await sql`UPDATE entities SET metadata = ${sql.json(metadata as never)} WHERE id = ${row.id}`;
    return row.id;
  };
  const discover = (cursor?: string, limit = 50) =>
    sdk.entities.discoverDuplicates({ entity_type: "asset", cursor, limit });
  const state = () => sql`SELECT
    (SELECT count(*)::int FROM entities WHERE organization_id = ${workspace.org.id}) AS entities,
    (SELECT count(*)::int FROM entity_identities WHERE organization_id = ${workspace.org.id}) AS identities,
    (SELECT count(*)::int FROM events WHERE organization_id = ${workspace.org.id}) AS events,
    (SELECT count(*)::int FROM runs WHERE organization_id = ${workspace.org.id}) AS runs,
    (SELECT count(*)::int FROM entity_merge_operations WHERE organization_id = ${workspace.org.id}) AS merges`;
  const automation = async () => {
    const agent = await createTestAgent({
      organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id,
      agentId: "synthetic-discovery-agent",
    });
    const created = await workspace.owner.automations.create({
      slug: "synthetic-discovery", name: "Synthetic discovery",
      managed_agent_id: agent.agentId, prompt: "Explain only",
      sources: [{ name: "people", query: "@entity:asset" }],
      triggers: [{ kind: "schedule", cron: "0 3 * * *", skip_if_unchanged: false }],
    });
    const id = Number(created.automation_id);
    const run = await createAutomationRun({
      organizationId: workspace.org.id, automationId: id, agentId: agent.agentId,
      windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z", dispatchSource: "manual",
    });
    const reactionContext: ReactionContext = {
      organization_id: workspace.org.id, organization_slug: workspace.org.slug,
      automation: { id, slug: "synthetic-discovery", name: "Synthetic discovery", version: 1 },
      window: { automation_id: id, run_id: run.runId, window_start: "2026-01-01T00:00:00Z", window_end: "2026-01-02T00:00:00Z", content_analyzed: 0 },
      entities: [], extracted_data: { analysis_summary: "", uncertain_groups: [] },
    };
    const agentSdk = buildClientSDK({
      ...context, userId: null, agentId: agent.agentId,
      actingAutomationId: id, actingRunId: run.runId,
    }, {} as Env);
    return { id, reactionContext, agentSdk };
  };
  return { workspace, sql, seed, typeId: Number(type.entity_type_id), context, sdk, entity, discover, state, automation };
}

describe("complete duplicate discovery", () => {
  it("finds a pair separated by more than 5000 entities through the read-only sandbox", async () => {
    const h = await setup();
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, ${h.typeId}, 'Asset ' || n, 'asset-' || n,
        jsonb_build_object('serial', CASE WHEN n IN (1, 5002) THEN 'shared' ELSE 'unique-' || n END),
        ${h.workspace.users.owner.id}
      FROM generate_series(1, 5002) n`;
    const before = await h.state();
    const result = await runScript({
      source: 'export default async (_, client) => client.entities.discoverDuplicates({ entity_type: "asset", limit: 1 });',
      sdk: h.sdk, sdkMode: "read", maxAccessLevel: "read",
    });
    expect(result.success, result.error?.message).toBe(true);
    expect(result.returnValue).toMatchObject({
      action: "discover_duplicates", candidates_scanned: 5003,
      components: [{ candidate_count: 2, oversized: false }], next_cursor: null,
    });
    expect(await h.state()).toEqual(before);
    const page = result.returnValue as EntityDiscoverDuplicatesResult;
    expect(page.components[0].candidate_entity_ids[1] - page.components[0].candidate_entity_ids[0]).toBe(5001);
    const oauth = await createTestOAuthClient();
    const token = await createTestAccessToken(h.workspace.users.member.id, h.workspace.org.id, oauth.client_id, { scope: "mcp:read" });
    const wire = new TestMcpClient({ token: token.token, orgSlug: h.workspace.org.slug });
    const response = await wire.querySdk<{ success: boolean; return_value: unknown }>(
      'export default async (_, client) => client.entities.discoverDuplicates({ entity_type: "asset", limit: 1 });',
    );
    expect(response.success).toBe(true);
    expect(response.return_value).toEqual(page);
  });

  it("pages whole 26-record components within the 199-decision budget and reports 27-record components", async () => {
    const h = await setup();
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, ${h.typeId}, 'Asset ' || n, 'sized-' || n,
        jsonb_build_object('serial', CASE WHEN n > 234 THEN 'oversized' ELSE 'group-' || ((n - 1) / 26) END),
        ${h.workspace.users.owner.id}
      FROM generate_series(1, 261) n`;
    const first = await h.discover(undefined, 100);
    expect(first.components).toHaveLength(7);
    expect(first.components.reduce((n, c) => n + c.decisions.length, 0)).toBe(175);
    const second = await h.discover(first.next_cursor!, 100);
    expect(second.components.map((c) => c.candidate_count)).toEqual([26, 26, 27]);
    expect(second.components[2]).toMatchObject({ oversized: true, candidate_entity_ids: [], decisions: [], deferred_candidates: 27 });
    expect(second.next_cursor).toBeNull();
    const all = [...first.components, ...second.components];
    expect(new Set(all.flatMap((c) => c.candidate_entity_ids)).size).toBe(234);
    expect(all.map((c) => c.component_id)).toEqual([...all.map((c) => c.component_id)].sort((a, b) => a - b));
    expect(all.every((c) => c.oversized || c.candidate_entity_ids.length === 26)).toBe(true);
    const other = await TestWorkspace.create({ name: "Other discovery tenant" });
    await expect(other.owner.entities.discoverDuplicates({ entity_type: "asset", cursor: first.next_cursor! })).rejects.toThrow(/cursor/);
    await expect(h.sdk.entities.discoverDuplicates({ entity_type: "another", cursor: first.next_cursor! })).rejects.toThrow(/cursor/);
    await expect(h.discover("not-a-cursor")).rejects.toThrow(/cursor/);
    await expect(h.discover(undefined, 101)).rejects.toThrow(/limit/);
  });

  it("reuses multi-field matching and exposes transitively deferred candidates without splitting them", async () => {
    const h = await setup();
    await h.sql`UPDATE entity_types SET metadata_schema = ${h.sql.json({
      "x-lobu-resolution": { rules: [
        { fields: ["serial"], normalizer: "exact", onMatch: "review" },
        { fields: ["rack", "slot"], normalizer: "exact", onMatch: "review" },
      ] },
    })} WHERE id = ${h.typeId}`;
    const a = await h.entity({ serial: "one", extra1: "x", extra2: "y", extra3: "z" });
    const b = await h.entity({ serial: "one", rack: "R", slot: "1" });
    const c = await h.entity({ serial: "two", rack: "R", slot: "1" });
    await h.entity({ rack: "R", slot: "2" });
    const page = await h.discover();
    expect(page.components).toHaveLength(1);
    expect(page.components[0]).toMatchObject({
      candidate_entity_ids: [a, b, c], deferred_candidates: 1,
      decisions: [{ winner_entity_id: a, loser_entity_id: b }],
    });
  });

  it("loads scoped custom claims, excluding deleted claims, deleted entities, and forwarded entities", async () => {
    const h = await setup();
    const ids = await Promise.all(Array.from({ length: 7 }, () => h.entity({})));
    for (let n = 0; n < ids.length; n++) {
      await h.sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key, deleted_at)
        VALUES (${h.workspace.org.id}, ${ids[n]}, 'serial', ${' '.repeat(n) + 'claim'},
          ${n === 2 ? "scope-b" : "scope-a"}, ${n === 3 ? new Date() : null})`;
    }
    await h.sql`UPDATE entities SET deleted_at = now() WHERE id = ${ids[4]}`;
    await h.sql`UPDATE entities SET merged_into = ${ids[0]} WHERE id = ${ids[5]}`;
    await h.sql`UPDATE entity_identities SET namespace = 'unrelated' WHERE entity_id = ${ids[6]}`;
    const page = await h.discover();
    expect(page.components).toHaveLength(1);
    expect(page.components[0].candidate_entity_ids).toEqual(ids.slice(0, 2).sort((a, b) => a - b));
    const before = page.components[0].decisions[0].fingerprint;
    await h.sql`UPDATE entity_identities SET identifier = identifier || ' ' WHERE entity_id = ${ids[1]}`;
    expect((await h.discover()).components[0].decisions[0].fingerprint).toBe(before);
    await h.sql`UPDATE entity_identities SET scope_key = 'scope-b' WHERE entity_id = ${ids[1]}`;
    expect((await h.discover()).components[0].candidate_entity_ids).toEqual(ids.slice(1, 3).sort((a, b) => a - b));
  });

  it("preserves reserved member visibility and the acting agent's entity read policy", async () => {
    const h = await setup();
    await expect(h.workspace.member.entities.discoverDuplicates({ entity_type: "$member" })).rejects.toThrow(/administrator/);
    await expect(h.workspace.asAnonymous().entities.discoverDuplicates({ entity_type: "asset" })).rejects.toThrow();
    for (const tokenType of ["oauth", "pat"] as const) {
      const userless = buildClientSDK({
        ...h.context, userId: null, memberRole: null, isAuthenticated: true, tokenType,
      }, {} as Env);
      await expect(userless.entities.discoverDuplicates({ entity_type: "asset" })).rejects.toThrow(/membership/);
    }
    await expect(h.sdk.entities.discoverDuplicates({ entity_type: "missing-type" })).rejects.toMatchObject({ httpStatus: 404 });
    const { agentSdk } = await h.automation();
    const [policy] = await h.sql`INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, entity_type_slug)
      VALUES (${h.workspace.org.id}, 'entity', NULL, 'asset') RETURNING id`;
    await h.sql`INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${policy.id}, 'read', 'deny')`;
    await expect(agentSdk.entities.discoverDuplicates({ entity_type: "asset" })).rejects.toThrow(/Policy denies reading/);
  });

  it("reconsiders changes behind the cursor in the next current-state sweep", async () => {
    const h = await setup();
    const a = await h.entity({});
    const b = await h.entity({});
    await h.entity({ serial: "first" });
    await h.entity({ serial: "first" });
    await h.entity({ serial: "last" });
    await h.entity({ serial: "last" });
    const first = await h.discover(undefined, 1);
    await h.sql`UPDATE entities SET metadata = '{"serial":"new-earlier"}'::jsonb WHERE id IN (${a}, ${b})`;
    const continuation = await h.discover(first.next_cursor!, 1);
    expect(continuation.components).toHaveLength(1);
    expect(continuation.next_cursor).toBeNull();
    const nextSweep = await h.discover();
    expect(nextSweep.components).toHaveLength(3);
    expect(nextSweep.components[0].candidate_entity_ids).toEqual([a, b]);
  });

  it("keeps rejected work suppressed until normalized claims or policy change", async () => {
    const h = await setup();
    const a = await h.entity({});
    const b = await h.entity({});
    for (const [id, identifier] of [[a, "claim"], [b, " claim "]] as const) {
      await h.sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
        VALUES (${h.workspace.org.id}, ${id}, 'serial', ${identifier})`;
    }
    const { agentSdk } = await h.automation();
    const resolve = async () => {
      const page = await h.discover();
      const result = await agentSdk.entities.manage({ action: "resolve_duplicates", candidate_entity_ids: page.components[0].candidate_entity_ids });
      return { fingerprint: page.components[0].decisions[0].fingerprint, result };
    };
    const rejectLatest = async () => {
      const [pending] = await h.sql`SELECT id, action_input FROM runs WHERE organization_id = ${h.workspace.org.id}
        AND action_key = 'entity_change' AND approval_status = 'pending' ORDER BY id DESC LIMIT 1`;
      await h.workspace.owner.operations.reject({ run_id: Number(pending.id) });
      return pending.action_input.resolution_fingerprint;
    };
    const first = await resolve();
    expect(first.result).toMatchObject({ approvals_queued: 1 });
    expect(await rejectLatest()).toBe(first.fingerprint);
    expect((await resolve()).result).toMatchObject({ approvals_suppressed: 1, approvals_queued: 0 });
    await h.sql`UPDATE entity_identities SET identifier = identifier || ' ' WHERE entity_id = ${b}`;
    expect((await resolve()).fingerprint).toBe(first.fingerprint);
    expect((await resolve()).result).toMatchObject({ approvals_suppressed: 1 });
    await h.sql`UPDATE entity_identities SET identifier = replace(identifier, 'claim', 'changed')
      WHERE entity_id IN (${a}, ${b})`;
    const changed = await resolve();
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(changed.result).toMatchObject({ approvals_queued: 1 });
    expect(await rejectLatest()).toBe(changed.fingerprint);
    await h.sql`UPDATE entity_types SET metadata_schema = ${h.sql.json({
      "x-lobu-resolution": { rules: [{ fields: ["serial"], normalizer: "exact", onMatch: "auto_merge" }] },
    })} WHERE id = ${h.typeId}`;
    const policyChanged = await resolve();
    expect(policyChanged.fingerprint).not.toBe(changed.fingerprint);
    expect(policyChanged.result).toMatchObject({ auto_merged: 1 });
  });

  it("runs the compiled catalog sweep for a pair beyond the source context page", async () => {
    const h = await setup();
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, ${h.typeId}, 'Asset ' || n, 'distant-' || n,
        jsonb_build_object('serial', CASE WHEN n IN (1, 5002) THEN 'shared' ELSE 'unique-' || n END),
        ${h.workspace.users.owner.id}
      FROM generate_series(1, 5002) n`;
    const { id, reactionContext } = await h.automation();
    await h.sql`UPDATE automations SET sources = '[{"name":"people","query":"@entity:asset"}]'::jsonb WHERE id = ${id}`;
    const template = AUTOMATION_CATALOG_TEMPLATES.find((entry) => entry.id === "duplicate-merge")!;
    const compiled = await compileReactionScript(String(template.detail.reaction_script));
    const result = await executeAutomationScript({ compiledScript: compiled, context: reactionContext, env: { JWT_SECRET: "synthetic-discovery-test-secret" } });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const [counts] = await h.sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${h.workspace.org.id}
      AND action_key = 'entity_change' AND approval_status = 'pending'`;
    expect(counts.n).toBe(1);
  });

  it("runs the compiled catalog sweep beyond 199 decisions using current assignment sources", async () => {
    const h = await setup();
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, ${h.typeId}, 'Asset ' || n, 'catalog-' || n,
        jsonb_build_object('serial', 'pair-' || ((n - 1) / 2)), ${h.workspace.users.owner.id}
      FROM generate_series(1, 402) n`;
    const { id, reactionContext } = await h.automation();
    // Legacy version snapshots do not own this assignment's current sources.
    await h.sql`UPDATE automation_versions SET version_sources = '[{"name":"legacy","query":"@entity:wrong-type"}]'::jsonb
      WHERE id = (SELECT current_version_id FROM automations WHERE id = ${id})`;
    const template = AUTOMATION_CATALOG_TEMPLATES.find((entry) => entry.id === "duplicate-merge")!;
    const compiled = await compileReactionScript(String(template.detail.reaction_script));
    const result = await executeAutomationScript({ compiledScript: compiled, context: reactionContext, env: { JWT_SECRET: "synthetic-discovery-test-secret" } });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const [counts] = await h.sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${h.workspace.org.id}
      AND action_key = 'entity_change' AND approval_status = 'pending'`;
    expect(counts.n).toBe(201);
    const [merged] = await h.sql`SELECT count(*)::int AS n FROM entities
      WHERE organization_id = ${h.workspace.org.id} AND merged_into IS NOT NULL`;
    expect(merged.n).toBe(0);
    expect(result.returnValue).toEqual({ oversized_groups: 0, deferred_candidates: 0 });
  }, 120_000);
});
