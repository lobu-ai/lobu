/**
 * Chat-store eligibility of a connector connection (credential_mode NULL).
 *
 * A connector connection joins the chat connection store only when BOTH
 * declarations hold: the gateway declares its platform a connector transport,
 * and the connector's active definition declares a message event that can reply
 * to its source. The shipped `whatsapp.web` definition declares no such event
 * yet, so its connections must stay out of the chat engine — that is the
 * "inbound WhatsApp still takes today's path" guarantee.
 */

import WhatsAppWebConnector from "@lobu/connectors/whatsapp_web";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { connectorTransportPlatforms } from "../../../gateway/connections/platforms/index";
import { orgContext } from "../../../lobu/stores/org-context";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestConnection, createTestOrganization, createTestUser } from "../../setup/test-fixtures";

const SHIPPED_EVENTS = new WhatsAppWebConnector().definition.automationEvents ?? [];
const REPLYABLE_EVENTS = SHIPPED_EVENTS.map((event) => ({
  ...event,
  capabilities: { ...event.capabilities, replyToSource: true },
}));

const store = createPostgresAgentConnectionStore({
  connectorTransportPlatforms: connectorTransportPlatforms(),
});

let orgId: string;

async function defineConnector(key: string, automationEvents: unknown): Promise<void> {
  await getDb()`
    INSERT INTO connector_definitions (organization_id, key, name, version, automation_events, status)
    VALUES (${orgId}, ${key}, ${key}, '1.0.0', ${getDb().json(automationEvents as any)}, 'active')
  `;
}

async function connection(key: string): Promise<string> {
  const owner = await createTestUser();
  const created = await createTestConnection({
    organization_id: orgId,
    connector_key: key,
    created_by: owner.id,
    createDefaultFeed: false,
  });
  return String(created.id);
}

const inOrg = <T>(fn: () => Promise<T>) => orgContext.run({ organizationId: orgId }, fn);

beforeEach(async () => {
  await cleanupTestDatabase();
  orgId = (await createTestOrganization()).id;
});

describe("connector-transport chat store eligibility", () => {
  it("only whatsapp.web is a declared connector transport", () => {
    expect(connectorTransportPlatforms()).toEqual(["whatsapp.web"]);
  });

  it("keeps a whatsapp.web connection out while its connector declares no reply-to-source event", async () => {
    expect(SHIPPED_EVENTS.some((event) => event.capabilities?.replyToSource)).toBe(false);
    await defineConnector("whatsapp.web", SHIPPED_EVENTS);
    const id = await connection("whatsapp.web");

    expect(await inOrg(() => store.getConnection(id))).toBeNull();
    expect(await inOrg(() => store.listConnections())).toEqual([]);
    expect(await store.listConnections()).toEqual([]);
  });

  it("admits it, under its numeric id, once the connector declares reply-to-source", async () => {
    await defineConnector("whatsapp.web", REPLYABLE_EVENTS);
    const id = await connection("whatsapp.web");

    const stored = await inOrg(() => store.getConnection(id));
    expect(stored).toMatchObject({ id, platform: "whatsapp.web", organizationId: orgId });
    // Org-less boot listing and platform-filtered listing both see it.
    expect((await store.listConnections()).map((c) => c.id)).toEqual([id]);
    expect(
      (await inOrg(() => store.listConnections({ platform: "whatsapp.web" }))).map((c) => c.id),
    ).toEqual([id]);
    // It has no agent binding, so an agent-scoped list never returns it.
    expect(await inOrg(() => store.listConnections({ agentId: "any-agent" }))).toEqual([]);
    expect(await inOrg(() => store.listConnections({ platform: "slack" }))).toEqual([]);
  });

  it("never admits a connection of another org through the numeric id", async () => {
    await defineConnector("whatsapp.web", REPLYABLE_EVENTS);
    const id = await connection("whatsapp.web");
    const otherOrg = (await createTestOrganization()).id;
    expect(
      await orgContext.run({ organizationId: otherOrg }, () => store.getConnection(id)),
    ).toBeNull();
  });

  it("a connector declaring reply-to-source is not enough without a gateway transport", async () => {
    await defineConnector("example.chat", REPLYABLE_EVENTS);
    const id = await connection("example.chat");
    expect(await inOrg(() => store.getConnection(id))).toBeNull();
    expect(await store.listConnections()).toEqual([]);

    // And a store built without any declared transport admits nothing new.
    await defineConnector("whatsapp.web", REPLYABLE_EVENTS);
    const waId = await connection("whatsapp.web");
    const plain = createPostgresAgentConnectionStore();
    expect(await inOrg(() => plain.getConnection(waId))).toBeNull();
    expect(await plain.listConnections()).toEqual([]);
  });

  it("refuses to write a connector-owned connection through the chat store", async () => {
    await defineConnector("whatsapp.web", REPLYABLE_EVENTS);
    const id = await connection("whatsapp.web");
    const stored = await inOrg(() => store.getConnection(id));
    expect(stored).not.toBeNull();
    await expect(
      inOrg(() => store.updateConnection(id, { metadata: { botUsername: "x" } })),
    ).rejects.toThrow("owned by their connector");
    const rows = await getDb()`
      SELECT count(*)::int AS n FROM connections WHERE organization_id = ${orgId}
    `;
    expect(rows[0].n).toBe(1);
  });
});
