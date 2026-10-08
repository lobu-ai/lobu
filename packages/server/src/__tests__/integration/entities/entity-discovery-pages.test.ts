import { afterEach, describe, expect, it } from "vitest";
import type { EntityDiscoverDuplicatesResult } from "@lobu/core/contracts/tools/manage-entity";
import { createAutomationRun } from "../../../runs/queue-service";
import { buildClientSDK } from "../../../sandbox/client-sdk";
import { runScript } from "../../../sandbox/run-script";
import type { Env } from "../../../index";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAccessToken, createTestAgent, createTestEntity, createTestOAuthClient, ownerToolContext } from "../../setup/test-fixtures";
import { TestMcpClient, TestWorkspace } from "../../setup/test-mcp-client";

import { registerMutationInterceptor, __resetMutationGateForTests } from "../../../authz/entity-mutation-gate";
import { lockIdentityOrganization } from "../../../utils/relationship-validation";
afterEach(async () => { __resetMutationGateForTests(); await cleanupTestDatabase(); });

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
  const human = workspace.withAuth({ tokenType: "session" });
  await human.entity_schema.createRelType({ slug: "same_asset", name: "Same asset", purpose: "identity" });
  await human.entity_schema.addRule({ slug: "same_asset", source_entity_type_slug: "asset", target_entity_type_slug: "asset" });
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
    (SELECT count(*)::int FROM entity_relationships WHERE organization_id = ${workspace.org.id}) AS relationships`;
  const automation = async () => {
    const agent = await createTestAgent({
      organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id,
      agentId: "synthetic-discovery-agent",
    });
    const created = await workspace.owner.automations.create({
      slug: "synthetic-discovery", name: "Synthetic discovery",
      managed_agent_id: agent.agentId, prompt: "Explain only",
      sources: [{ name: "assets", query: "@entity:asset" }],
      triggers: [{ kind: "schedule", cron: "0 3 * * *", skip_if_unchanged: false }],
    });
    const id = Number(created.automation_id);
    const run = await createAutomationRun({
      organizationId: workspace.org.id, automationId: id, agentId: agent.agentId,
      windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z", dispatchSource: "manual",
    });
    const agentSdk = buildClientSDK({
      ...context, userId: null, memberRole: null, tokenType: "session", agentId: agent.agentId,
      actingAutomationId: id, actingRunId: run.runId,
    }, {} as Env);
    return { agentSdk };
  };
  const readClient = async () => {
    const oauth = await createTestOAuthClient();
    const token = await createTestAccessToken(workspace.users.member.id, workspace.org.id, oauth.client_id, { scope: "mcp:read" });
    return new TestMcpClient({ token: token.token, orgSlug: workspace.org.slug });
  };
  return { workspace, human, sql, seed, typeId: Number(type.entity_type_id), context, sdk, entity, discover, state, automation, readClient };
}

describe("complete duplicate discovery", () => {
  it("proposes current roots with member evidence and no public fingerprint", async () => {
    const h = await setup();
    const a = await h.entity({ serial: "same" });
    const b = await h.entity({});
    const c = await h.entity({ serial: "same" });
    const d = await h.entity({});
    await h.human.entities.link({ from_entity_id: a, to_entity_id: b, relationship_type_slug: "same_asset" });
    await h.human.entities.link({ from_entity_id: c, to_entity_id: d, relationship_type_slug: "same_asset" });
    const page = await h.discover();
    expect(page.components).toHaveLength(1);
    expect(page.components[0].candidate_entity_ids).toEqual([a, b, c, d]);
    expect(page.components[0].decisions).toEqual([{ from_entity_id: d, to_entity_id: b, relationship_type_slug: "same_asset" }]);
    await h.human.entities.link(page.components[0].decisions[0]);
    expect((await h.discover()).components).toEqual([]);
  });

  it("emits one disjoint proposal per matching component and rediscovery advances after each join", async () => {
    const h = await setup();
    const ids = await Promise.all(Array.from({length: 4}, () => h.entity({ serial: "same" })));
    const first = await h.discover();
    expect(first.components[0].decisions).toHaveLength(1);
    expect(first.components[0].deferred_candidates).toBe(2);
    await h.human.entities.link(first.components[0].decisions[0]);
    const second = await h.discover();
    expect(second.components[0].decisions).toHaveLength(1);
    expect(second.components[0].decisions[0].to_entity_id).toBe(Math.min(...ids));
    expect(second.components[0].decisions[0]).not.toHaveProperty("fingerprint");
  });

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
    const wire = await h.readClient();
    const response = await wire.querySdk<{ success: boolean; return_value: unknown }>(
      'export default async (_, client) => client.entities.discoverDuplicates({ entity_type: "asset", limit: 1 });',
    );
    expect(response.success).toBe(true);
    expect(response.return_value).toEqual(page);
  });

  it("pages whole components, proposes one join each, and withholds 27-record components", async () => {
    const h = await setup();
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, ${h.typeId}, 'Asset ' || n, 'sized-' || n,
        jsonb_build_object('serial', CASE WHEN n > 234 THEN 'oversized' ELSE 'group-' || ((n - 1) / 26) END),
        ${h.workspace.users.owner.id}
      FROM generate_series(1, 261) n`;
    const first = await h.discover(undefined, 7);
    expect(first.components).toHaveLength(7);
    expect(first.components.reduce((n, c) => n + c.decisions.length, 0)).toBe(7);
    const second = await h.discover(first.next_cursor!, 7);
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
      decisions: [{ to_entity_id: a, from_entity_id: b, relationship_type_slug: "same_asset" }],
    });
  });

  it("loads scoped custom claims and excludes deleted claims and records", async () => {
    const h = await setup();
    const ids = await Promise.all(Array.from({ length: 7 }, () => h.entity({})));
    for (let n = 0; n < ids.length; n++) {
      await h.sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key, deleted_at)
        VALUES (${h.workspace.org.id}, ${ids[n]}, 'serial', ${' '.repeat(n) + 'claim'},
          ${n === 2 ? "scope-b" : "scope-a"}, ${n === 3 ? new Date() : null})`;
    }
    await h.sql`UPDATE entities SET deleted_at = now() WHERE id = ${ids[4]}`;
    await h.sql`UPDATE entities SET deleted_at = now() WHERE id = ${ids[5]}`;
    await h.sql`UPDATE entity_identities SET namespace = 'unrelated' WHERE entity_id = ${ids[6]}`;
    const page = await h.discover();
    expect(page.components).toHaveLength(1);
    expect(page.components[0].candidate_entity_ids).toEqual(ids.slice(0, 2).sort((a, b) => a - b));
    const before = page.components[0].decisions[0];
    await h.sql`UPDATE entity_identities SET identifier = identifier || ' ' WHERE entity_id = ${ids[1]}`;
    expect((await h.discover()).components[0].decisions[0]).toEqual(before);
    await h.sql`UPDATE entity_identities SET scope_key = 'scope-b' WHERE entity_id = ${ids[1]}`;
    expect((await h.discover()).components[0].candidate_entity_ids).toEqual(ids.slice(1, 3).sort((a, b) => a - b));
  });

  it("keeps distinct composite rules separate when field names contain the old delimiter", async () => {
    const h = await setup();
    await h.sql`UPDATE entity_types SET metadata_schema = ${h.sql.json({
      "x-lobu-resolution": { rules: [
        { fields: ["a\u001fb", "c"], normalizer: "exact", onMatch: "review" },
        { fields: ["a", "b\u001fc"], normalizer: "exact", onMatch: "review" },
      ] },
    })} WHERE id = ${h.typeId}`;
    const first = [await h.entity({ "a\u001fb": "x", c: "y" }), await h.entity({ "a\u001fb": "x", c: "y" })];
    const second = [await h.entity({ a: "x", "b\u001fc": "y" }), await h.entity({ a: "x", "b\u001fc": "y" })];
    const page = await h.discover();
    expect(page.components.map(component => component.candidate_entity_ids)).toEqual([first, second]);
    expect(page.components.map(component => component.decisions)).toEqual([first, second].map(ids => [{
      from_entity_id: ids[1], to_entity_id: ids[0], relationship_type_slug: "same_asset",
    }]));
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
    await expect(agentSdk.entities.discoverDuplicates({ entity_type: "asset" })).resolves.toMatchObject({ action: "discover_duplicates" });
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
    const proposal = { from_entity_id: b, to_entity_id: a, relationship_type_slug: "same_asset" };
    const first = await agentSdk.entities.link(proposal);
    expect(first).toMatchObject({ approval_queued: true });
    await h.human.operations.reject({ run_id: Number((first as {approval_run_id:number}).approval_run_id) });
    const discover = () => agentSdk.entities.discoverDuplicates({ entity_type: "asset" });
    expect((await discover()).components[0].decisions).toEqual([]);
    await h.sql`UPDATE entity_identities SET identifier = identifier || ' ' WHERE entity_id = ${b}`;
    expect((await discover()).components[0].decisions).toEqual([]);
    await h.sql`UPDATE entity_identities SET identifier = replace(identifier, 'claim', 'changed') WHERE entity_id IN (${a}, ${b})`;
    expect((await discover()).components[0].decisions).toEqual([proposal]);
    const changed = await agentSdk.entities.link(proposal);
    expect(changed).toMatchObject({ approval_queued: true });
    await h.human.operations.reject({ run_id: Number((changed as {approval_run_id:number}).approval_run_id) });
    await h.sql`UPDATE entity_types SET metadata_schema = ${h.sql.json({
      "x-lobu-resolution": { rules: [{ fields: ["serial"], normalizer: "exact", onMatch: "auto_link" }] },
    })} WHERE id = ${h.typeId}`;
    expect((await discover()).components[0].decisions).toEqual([proposal]);
    expect(await agentSdk.entities.link(proposal)).toMatchObject({ approval_queued: true });

  });

  it("bounds denied-component policy checks by records and does not wait on mutation locks", async () => {
    const h = await setup();
    const ids = (await Promise.all(Array.from({ length: 26 }, () => h.entity({ serial: "same" })))).sort((a, b) => a - b);
    const { agentSdk } = await h.automation();
    let checks = 0;
    registerMutationInterceptor({ name: "synthetic-denied-discovery", evaluate: async request => {
      if (request.action === "link") { checks++; return { outcome: "deny", reason: "Synthetic denial" }; }
      return null;
    } });
    await h.sql.begin(async tx => {
      await lockIdentityOrganization(tx, h.workspace.org.id);
      await tx`SELECT id FROM entities WHERE id = ${ids[0]} FOR UPDATE`;
      let timer: ReturnType<typeof setTimeout>;
      try {
        const page = await Promise.race([
          agentSdk.entities.discoverDuplicates({ entity_type: "asset" }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Discovery waited on mutation lock")), 2000); }),
        ]);
        expect(page.components[0].decisions).toEqual([]);
        expect(checks).toBe(26);
      } finally { clearTimeout(timer!); }
    });
  });

  it("batches a fully suppressed 26-root component and finds a later unsuppressed pair", async () => {
    const h = await setup();
    const ids = (await Promise.all(Array.from({ length: 26 }, () => h.entity({ serial: "same" })))).sort((a, b) => a - b);
    const { agentSdk } = await h.automation();
    const proposal = await agentSdk.entities.link({ from_entity_id: ids[1], to_entity_id: ids[0], relationship_type_slug: "same_asset" });
    const runId = Number((proposal as { approval_run_id: number }).approval_run_id);
    await h.human.operations.reject({ run_id: runId });
    const [run] = await h.sql`SELECT action_input FROM runs WHERE id = ${runId}`;
    const original = Object.values(run.action_input.member_support)[0] as { pair: number[]; keys: string[] };
    const supports: Record<string, unknown> = {};
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const pair = [ids[a], ids[b]];
      supports[JSON.stringify(pair)] = { ...original, pair, keys: original.keys.map(key => {
        const parsed = JSON.parse(key); parsed[0] = parsed[0] === original.pair[0] ? pair[0] : pair[1]; return JSON.stringify(parsed);
      }) };
    }
    await h.sql`UPDATE runs SET action_input = action_input || ${h.sql.json({ member_support: supports })}::jsonb WHERE id = ${runId}`;
    let checks = 0;
    registerMutationInterceptor({ name: "synthetic-count-discovery", evaluate: async request => {
      if (request.action === "link") checks++; return null;
    } });
    const page = await agentSdk.entities.discoverDuplicates({ entity_type: "asset" });
    expect(page.components[0].decisions).toEqual([]);
    expect(checks).toBe(26);
    delete supports[JSON.stringify(ids.slice(-2))];
    await h.sql`UPDATE runs SET action_input = action_input || ${h.sql.json({ member_support: supports })}::jsonb WHERE id = ${runId}`;
    expect((await agentSdk.entities.discoverDuplicates({ entity_type: "asset" })).components[0].decisions).toEqual([
      { from_entity_id: ids.at(-1), to_entity_id: ids.at(-2), relationship_type_slug: "same_asset" },
    ]);
  });

  it("traverses more than 199 decisions through member read-only MCP calls without domain writes", async () => {
    const h = await setup();
    await h.sql`INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${h.workspace.org.id}, ${h.typeId}, 'Asset ' || n, 'paged-' || n,
        jsonb_build_object('serial', 'pair-' || ((n - 1) / 2)), ${h.workspace.users.owner.id}
      FROM generate_series(1, 402) n`;
    const wire = await h.readClient();
    const before = await h.state();
    const readPage = async (cursor?: string) => {
      const input = JSON.stringify({ entity_type: "asset", limit: 100, cursor });
      const response = await wire.querySdk<{ success: boolean; return_value: EntityDiscoverDuplicatesResult }>(
        "export default async (_, client) => client.entities.discoverDuplicates(" + input + ");",
      );
      expect(response.success).toBe(true);
      return response.return_value;
    };
    const pages: EntityDiscoverDuplicatesResult[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await readPage(cursor);
      pages.push(page);
      cursor = page.next_cursor ?? undefined;
      if (cursor) {
        expect(seenCursors.has(cursor)).toBe(false);
        seenCursors.add(cursor);
      }
    } while (cursor);
    expect(pages.map((page) => page.components.length)).toEqual([100, 100, 1]);
    const components = pages.flatMap((page) => page.components);
    expect(components.flatMap((component) => component.decisions)).toHaveLength(201);
    const ids = components.flatMap((component) => component.candidate_entity_ids);
    expect(ids).toHaveLength(402);
    expect(new Set(ids).size).toBe(402);
    expect(components.every((component) => component.candidate_entity_ids.length === 2)).toBe(true);
    expect(await readPage()).toEqual(pages[0]);
    // The MCP transport records every query_sdk call, including read-only calls.
    const audit = await h.sql`SELECT id FROM events WHERE organization_id = ${h.workspace.org.id}
      AND semantic_type = 'audit' AND origin_type = 'tool_invocation'
      AND metadata->>'tool_name' = 'query_sdk'`;
    expect(audit).toHaveLength(pages.length + 1);
    expect(await h.state()).toEqual([{ ...before[0], events: before[0].events + audit.length }]);
  });
});
