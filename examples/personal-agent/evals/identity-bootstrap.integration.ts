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

test("fresh workspace setup, retained alias lookup, interrupted import and replay through real governed SDK", async () => {
  const workspace = await TestWorkspace.create({
    name: "Synthetic Identity Bootstrap",
  });
  const context = {
    ...ownerToolContext(workspace.org.id, workspace.users.owner.id),
    tokenType: "session" as const,
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
