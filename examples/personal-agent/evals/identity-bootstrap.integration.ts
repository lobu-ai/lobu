import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestEntity,
  ownerToolContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import type { Env } from "../../../packages/server/src/index";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { runScript } from "../../../packages/server/src/sandbox/run-script";
import { contactIdentity, identityRelationships } from "../identity.schema";
import {
  buildManifest,
  type Observation,
  observationKey,
} from "../identity-bootstrap";
import {
  type IdentityClient,
  runIdentityChunk,
} from "../identity-import.script";

afterEach(cleanupTestDatabase);

test.each([
  "direct",
  "MCP",
])("fresh workspace setup, retained alias lookup, interrupted import and replay through real governed SDK (%s)", async (transport) => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic Identity Bootstrap",
  });
  const context = {
    ...ownerToolContext(workspace.org.id, workspace.users.owner.id),
    tokenType: "oauth" as const,
    scopedToOrg: false,
    allowCrossOrg: true,
    grantedOrganizationIds: [workspace.org.id],
  };
  const sdk = buildClientSDK(context, {} as Env);
  const person = await createTestEntity({
    name: "Synthetic contact",
    entity_type: "person",
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const sql = getTestDb();
  await sql`UPDATE entities SET metadata = '{"phone":"441234567890"}'::jsonb WHERE id = ${person.id}`;
  await installIdentitySchema(sdk);
  const client = sdk as unknown as IdentityClient;
  const ref = {
    feed_id: 101,
    connection_id: 202,
    origin_id: "provider-message-1",
    observed_at: "2026-01-01T00:00:00Z",
  };
  const a: Observation = {
    provider: "whatsapp",
    account_scope: "test-owner-account",
    namespace: "whatsapp:jid",
    native_key: "441234567890@c.us",
    source_refs: [ref],
  };
  const b: Observation = {
    ...a,
    namespace: "whatsapp:phone",
    native_key: "441234567890",
    person_ids: [person.id],
  };
  const plan = buildManifest({
    observations: [a, b],
    aliases: [
      {
        left: observationKey(a),
        right: observationKey(b),
        kind: "same_row",
        source_ref: ref,
      },
    ],
  });
  if (transport === "MCP") {
    // Exact published asset in the production V8 bridge: no Node/Bun/filesystem
    // globals in the guest, and real governed SDK writes/readback on fresh PG.
    const bundle = readFileSync(
      new URL("../identity-bootstrap.mcp.js", import.meta.url),
      "utf8"
    );
    const request = {
      workspace: workspace.org.slug,
      mode: "preview",
      input: {
        observations: [a, b],
        aliases: [
          {
            left: observationKey(a),
            right: observationKey(b),
            kind: "same_row",
            source_ref: ref,
          },
        ],
      },
    };
    const mcp = async (input: unknown, access: "read" | "write") => {
      const result = await runScript({
        source: `${bundle}\nexport default async (_ctx, client) => runMcpIdentity(client, ${JSON.stringify(input)});`,
        sdk,
        maxAccessLevel: access,
        allowCrossOrg: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      return result.returnValue as {
        continuation: { digest: string; next: number };
      };
    };
    const preview = await mcp(request, "read");
    const mcpImported = await mcp(
      { ...request, mode: "import", continuation: preview.continuation },
      "write"
    );
    expect(mcpImported).toMatchObject({ done: true, changed: 2, linked: 2 });
    const mcpReplay = await mcp(
      { ...request, mode: "import", continuation: preview.continuation },
      "write"
    );
    expect(mcpReplay).toMatchObject({ done: true, changed: 0, linked: 0 });
    const verified = await mcp(
      { ...request, mode: "verify", continuation: preview.continuation },
      "read"
    );
    expect(verified).toMatchObject({ done: true, changed: 0, linked: 0 });
  } else {
    // Crash boundary after first record, then replay the full intended chunk.
    await runIdentityChunk(
      client,
      { items: [plan.items[0]], aliases: [] },
      false
    );
    const imported = await runIdentityChunk(client, plan, false);
    expect(imported.records).toHaveLength(2);
    expect(
      imported.edges.filter((edge) => edge.action === "linked")
    ).toHaveLength(2);
    const replay = await runIdentityChunk(client, plan, false);
    expect(replay.records.every((row) => row.action === "adopted")).toBe(true);
    expect(replay.edges.every((row) => row.action === "adopted")).toBe(true);
    await runIdentityChunk(client, plan, true);
  }
  const records =
    await sql`SELECT id, metadata FROM entities WHERE organization_id = ${workspace.org.id} AND entity_type_id = (SELECT id FROM entity_types WHERE organization_id = ${workspace.org.id} AND slug = 'contact-identity')`;
  expect(records).toHaveLength(2);
  expect(
    records.every(
      (row) => !JSON.stringify(row.metadata).includes("payload_text")
    )
  ).toBe(true);
  const persons =
    await sql`SELECT id FROM entities WHERE organization_id = ${workspace.org.id} AND entity_type_id = (SELECT id FROM entity_types WHERE organization_id = ${workspace.org.id} AND slug = 'person')`;
  expect(persons.map((row) => row.id)).toEqual([person.id]);
  const samePerson =
    await sql`SELECT er.id FROM entity_relationships er JOIN entity_relationship_types rt ON rt.id = er.relationship_type_id WHERE er.organization_id = ${workspace.org.id} AND rt.slug = 'same_person'`;
  expect(samePerson).toHaveLength(0);
});

async function installIdentitySchema(sdk: ReturnType<typeof buildClientSDK>) {
  await sdk.entitySchema.createType({
    slug: contactIdentity.key,
    name: contactIdentity.name!,
    metadata_schema: {
      type: "object",
      properties: contactIdentity.properties,
      "x-lobu-resolution": contactIdentity.resolutionPolicy,
    },
  });
  for (const type of identityRelationships) {
    await sdk.entitySchema.createRelType({
      slug: type.key,
      name: type.name!,
      ...(type.purpose ? { purpose: type.purpose } : {}),
    });
    for (const rule of type.rules ?? []) {
      await sdk.entitySchema.addRule({
        slug: type.key,
        source_entity_type_slug:
          typeof rule.source === "string" ? rule.source : rule.source.key,
        target_entity_type_slug:
          typeof rule.target === "string" ? rule.target : rule.target.key,
      });
    }
  }
}

test("incremental published MCP helper imports and verifies before accepting the cursor on real governed PG", async () => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic Incremental Identity",
  });
  const context = {
    ...ownerToolContext(workspace.org.id, workspace.users.owner.id),
    tokenType: "oauth" as const,
    scopedToOrg: false,
    allowCrossOrg: true,
    grantedOrganizationIds: [workspace.org.id],
  };
  const sdk = buildClientSDK(context, {} as Env);
  await installIdentitySchema(sdk);
  const bundle = readFileSync(
    new URL("../identity-incremental.mcp.js", import.meta.url),
    "utf8"
  );
  const base = {
    workspace: workspace.org.slug,
    reader_id: "synthetic-reader",
    automation_id: 303,
    sources: [
      {
        provider: "linkedin",
        account_scope: "synthetic-saved-account",
        connection_id: 202,
        feed_id: 101,
        source_scope: "synthetic-source-scope",
      },
    ],
  };
  const call = async (request: unknown, access: "read" | "write") => {
    // Only the source responses are synthetic: the generated asset, V8 bridge,
    // entity policy, writes, exact readback and replay all use production SDK.
    const result = await runScript({
      source: `${bundle}
      export default async (_ctx, client) => {
        const live = await client.org(${JSON.stringify(workspace.org.slug)});
        const source = {
          entities: live.entities, query: sql => live.query(sql),
          knowledge: { read: async () => ({ content: [{ connection_id: 202, feed_id: 101, created_at: "2026-01-01T00:00:00Z",
            metadata: { observation_id: "synthetic-observation", resource_ref: "synthetic-native-message", resource_type: "message", source_scope: "synthetic-source-scope" } }],
            page: { has_more: false }, resume_cursor: "synthetic-resume" }) },
          feeds: {
            get: async () => ({ feed: { id: 101, connection_id: 202, feed_key: "live_messages", config: {}, operations: ["read"] } }),
            readMany: async () => ({ results: [{ feed_id: 101, ok: true, rows: [{ id: "synthetic-native-message", sender_member_id: "1234567", sender_slug: "synthetic-contact", from_me: false, text: "private-body-excluded" }] }] })
          }
        };
        return runIncrementalIdentity({ org: async () => source }, ${JSON.stringify(request)});
      }`,
      sdk,
      maxAccessLevel: access,
      allowCrossOrg: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result.returnValue as any;
  };
  const prepared = await call({ ...base, action: "poll" }, "read");
  expect(prepared.state.cursor).toBeUndefined();
  const imported = await call(
    { ...base, action: "advance", state: prepared.state },
    "write"
  );
  expect(imported.changed).toBe(2);
  expect(imported.state.cursor).toBeUndefined();
  const replay = await call(
    { ...base, action: "advance", state: prepared.state },
    "write"
  );
  expect(replay.changed).toBe(0);
  const verified = await call(
    { ...base, action: "advance", state: imported.state },
    "read"
  );
  expect(verified).toMatchObject({
    phase: "accepted",
    state: { cursor: "synthetic-resume" },
  });
  expect(verified.state.pending).toBeUndefined();
  const sql = getTestDb();
  const identities =
    await sql`SELECT e.metadata FROM entities e JOIN entity_types t ON t.id = e.entity_type_id WHERE e.organization_id = ${workspace.org.id} AND t.slug = 'contact-identity'`;
  expect(identities).toHaveLength(2);
  expect(JSON.stringify(identities)).not.toContain("private-body");
  const people =
    await sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id WHERE e.organization_id = ${workspace.org.id} AND t.slug = 'person'`;
  expect(people).toHaveLength(0);
  const runs =
    await sql`SELECT id FROM runs WHERE organization_id = ${workspace.org.id} AND run_type = 'automation'`;
  expect(runs).toHaveLength(0);
});
