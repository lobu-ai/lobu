import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_TEMPLATE_SDK_SCRIPT_LENGTH } from "@lobu/core/json-template";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAccessToken, createTestOAuthClient, createTestConnection, createTestConnectorDefinition, createTestEntity, createTestSession } from "../../setup/test-fixtures";
import { post } from "../../setup/test-helpers";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

describe("native event SDK actions", () => {
  beforeAll(async () => { await initWorkspaceProvider(); });
  beforeEach(async () => { await cleanupTestDatabase(); });

  async function fixture(script = "export default async(ctx) => ({ total: 42, actor: ctx.user_id, source: input.source_event_id, value: input.value })", mode: "read" | "full" = "full") {
    const workspace = await TestWorkspace.create({ name: "Synthetic native SDK" });
    const api = await TestApiClient.for({ organizationId: workspace.org.id, userId: workspace.users.owner.id, memberRole: "owner" });
    await api.entity_schema.createType({
      slug: "status-panel", name: "Status panel",
      event_kinds: {
        "status.panel": {
          jsonTemplate: { type: "button", props: { label: "Update", onClick: "@refresh", value: "shown" } },
          interactions: { refresh: { sdk: { script, mode } } },
        },
      },
    });
    const entity = await createTestEntity({ name: "Synthetic panel", entity_type: "status-panel", organization_id: workspace.org.id, created_by: workspace.users.owner.id });
    const source = await api.knowledge.save({ entity_ids: [entity.id], semantic_type: "status.panel", payload_type: "empty", title: "Synthetic panel", metadata: { total: 7 } });
    const cookie = (await createTestSession(workspace.users.owner.id)).cookieHeader;
    const path = `/api/${workspace.org.slug}/events/${source.id}/actions/refresh`;
    return { workspace, api, entity, source, cookie, path };
  }

  it("runs the registered script as the clicking user and returns data without another dashboard or interaction", async () => {
    const f = await fixture();
    const response = await post(f.path, { cookie: f.cookie, body: { value: "shown", interaction_id: "first-click", script: "export default async () => ({ total: 999 })" } });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ kind: "sdk", result: { success: true, return_value: { total: 42, actor: f.workspace.users.owner.id, source: f.source.id, value: "shown" } } });
    const rows = await getTestDb()`SELECT id, metadata, superseded_by FROM events WHERE organization_id = ${f.workspace.org.id} AND (semantic_type = 'status.panel' OR origin_type = 'template_interaction')`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(f.source.id);
    expect(rows[0].metadata.total).toBe(7);
    expect(rows[0].superseded_by).toBeNull();
  });

  it("rejects forged values and retired sources before executing", async () => {
    const f = await fixture();
    const forged = await post(f.path, { cookie: f.cookie, body: { value: "hidden", interaction_id: "forged" } });
    expect(forged.status).toBe(400);
    await f.api.knowledge.save({ entity_ids: [f.entity.id], semantic_type: "status.panel", payload_type: "empty", metadata: { total: 9 }, supersedes_event_id: f.source.id });
    const stale = await post(f.path, { cookie: f.cookie, body: { value: "shown", interaction_id: "stale" } });
    expect(stale.status).toBe(409);
  });

  it("denies an event from another workspace and a private source the clicker cannot read", async () => {
    const f = await fixture();
    const foreign = await TestWorkspace.create({ name: "Synthetic unrelated workspace" });
    const foreignCookie = (await createTestSession(foreign.users.owner.id)).cookieHeader;
    const response = await post(`/api/${foreign.org.slug}/events/${f.source.id}/actions/refresh`, { cookie: foreignCookie, body: { value: "shown", interaction_id: "foreign" } });
    expect([403, 404]).toContain(response.status);
    await createTestConnectorDefinition({ key: "synthetic.private", name: "Private fixture", organization_id: f.workspace.org.id });
    const connection = await createTestConnection({ organization_id: f.workspace.org.id, connector_key: "synthetic.private", created_by: f.workspace.users.owner.id, visibility: "private" });
    await getTestDb()`UPDATE events SET connection_id = ${connection.id} WHERE id = ${f.source.id}`;
    const memberCookie = (await createTestSession(f.workspace.users.member.id)).cookieHeader;
    const denied = await post(f.path, { cookie: memberCookie, body: { value: "shown", interaction_id: "private" } });
    expect([403, 404]).toContain(denied.status);
    expect((await denied.json()).kind).not.toBe("sdk");
  });

  it("uses the current declaration immediately and stops after revocation", async () => {
    const f = await fixture();
    const click = (id: string) => post(f.path, { cookie: f.cookie, body: { value: "shown", interaction_id: id } });
    expect((await (await click("before-change")).json()).result.return_value.total).toBe(42);
    await f.api.entity_schema.updateType({ slug: "status-panel", event_kinds: {
      "status.panel": {
        jsonTemplate: { type: "button", props: { label: "Update", onClick: "@refresh", value: "shown" } },
        interactions: { refresh: { sdk: { script: "export default async () => ({ total: 99 })", mode: "read" } } },
      },
    } });
    expect((await (await click("after-change")).json()).result.return_value.total).toBe(99);
    await f.api.entity_schema.updateType({ slug: "status-panel", event_kinds: {
      "status.panel": { jsonTemplate: { type: "text", content: "Refresh retired" }, interactions: {} },
    } });
    expect((await click("after-revocation")).status).toBe(403);
  });

  it("does not let OAuth callers borrow the browser-session binding", async () => {
    const f = await fixture();
    const oauth = await createTestOAuthClient();
    const { token } = await createTestAccessToken(f.workspace.users.owner.id, f.workspace.org.id, oauth.client_id);
    const response = await post(f.path, { token, body: { value: "shown", interaction_id: "oauth-click" } });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("signed-in web session");
  });

  it("fits the largest declaration and escaped input inside the SDK request bounds", async () => {
    const script = "export default async () => ({ total: 42 })".padEnd(MAX_TEMPLATE_SDK_SCRIPT_LENGTH, " ");
    const f = await fixture(script, "read");
    const value = String.fromCharCode(1).repeat(1000);
    await f.api.entity_schema.updateType({ slug: "status-panel", event_kinds: {
      "status.panel": {
        jsonTemplate: { type: "button", props: { label: "Update", onClick: "@refresh", value } },
        interactions: { refresh: { sdk: { script, mode: "read" } } },
      },
    } });
    await getTestDb()`UPDATE events SET title = ${"Long title ".repeat(100)} WHERE id = ${f.source.id}`;
    const response = await post(f.path, { cookie: f.cookie, body: { value, interaction_id: "bounds" } });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ kind: "sdk", result: { success: true, return_value: { total: 42 } } });
  });

  it("uses query_sdk restrictions for a read declaration", async () => {
    const f = await fixture("export default async(ctx, client) => client.knowledge.save({ content: 'Must not write', semantic_type: 'note' })", "read");
    const response = await post(f.path, { cookie: f.cookie, body: { value: "shown", interaction_id: "read-only" } });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ kind: "sdk", result: { success: false } });
    const notes = await getTestDb()`SELECT id FROM events WHERE organization_id = ${f.workspace.org.id} AND payload_text = 'Must not write'`;
    expect(notes).toHaveLength(0);
  });

  it("rejects ambiguous or malformed SDK declarations at authoring time", async () => {
    const f = await fixture();
    for (const interaction of [
      { sdk: { script: " ", mode: "full" } },
      { emits: "status.panel", sdk: { script: "export default async () => ({})", mode: "full" } },
      { sdk: { script: "export default async () => ({})", mode: "arbitrary" } },
      { sdk: { script: "export default async () => ({})", mode: "full", timeout_ms: 60001 } },
    ]) {
      await expect(f.api.entity_schema.updateType({ slug: "status-panel", event_kinds: {
        "status.panel": { jsonTemplate: { type: "button", onClick: "@refresh" }, interactions: { refresh: interaction } },
      } } as never)).rejects.toThrow();
    }
  });
});
