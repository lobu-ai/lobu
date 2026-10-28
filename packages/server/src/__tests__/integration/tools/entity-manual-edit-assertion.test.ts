/**
 * Asserted manual edits over REST: `manage_entity update` with
 * `manual_edit: true`, honoured only for a token explicitly minted with the
 * `entities:manual_edit` scope by a person in a web session.
 *
 * A first-party backend acting for a real person's click authenticates with a
 * PAT, which is delegated authority (`clientId: pat_<id>`), so without the
 * assertion its writes never claim field ownership and the next Automation
 * write silently overwrites the person's edit.
 */

import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app, type Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
} from "../../setup/test-fixtures";

const env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
  RATE_LIMIT_ENABLED: "false",
} as Env;

let org: Awaited<ReturnType<typeof createTestOrganization>>;
let owner: Awaited<ReturnType<typeof createTestUser>>;
let cookie: string;
let entityId: number;
let server: Server;
let baseUrl: string;

function request(method: string, route: string, body?: unknown, token?: string) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function update(token: string | undefined, body: Record<string, unknown>) {
  return request("POST", `/api/${org.slug}/manage_entity`, { action: "update", entity_id: entityId, ...body }, token);
}

async function mintManualEditToken(): Promise<{ id: number; token: string }> {
  const minted = await request("POST", `/api/${org.slug}/tokens`, {
    name: "task-board-backend",
    scope: "mcp:write entities:manual_edit",
  });
  expect(minted.status).toBe(201);
  const { token } = await minted.json();
  return { id: Number(token.id), token: token.token };
}

async function entityRow() {
  const [row] = await getTestDb()`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
  return row as { metadata: Record<string, unknown>; field_controls: Record<string, Record<string, unknown>> };
}

async function pendingFieldApprovals() {
  return getTestDb()`
    SELECT id, action_input FROM runs
    WHERE organization_id = ${org.id}
      AND run_type = 'internal'
      AND action_key = 'entity_field_change'
      AND approval_status = 'pending'
  `;
}

beforeAll(async () => {
  await initWorkspaceProvider();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: (req) => app.fetch(req, env), port: 0, hostname: "127.0.0.1" }, (address) => {
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    }) as Server;
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await cleanupTestDatabase();
});

beforeEach(async () => {
  org = await createTestOrganization();
  owner = await createTestUser();
  await addUserToOrganization(owner.id, org.id, "owner");
  cookie = (await createTestSession(owner.id)).cookieHeader;
  entityId = (await createTestEntity({
    name: "Manual Edit Target",
    organization_id: org.id,
    created_by: owner.id,
  })).id;
});

describe("asserted manual edits over REST", () => {
  it("rejects the flag from a token without entities:manual_edit and writes nothing", async () => {
    const plain = (await createTestPAT(owner.id, org.id, { scope: "mcp:read mcp:write" })).token;
    const response = await update(plain, { metadata: { severity: "high" }, manual_edit: true });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("MANUAL_EDIT_NOT_ALLOWED");
    expect(body.retryable).toBe(false);
    expect(body.error).toContain("entities:manual_edit");

    const row = await entityRow();
    expect(row.metadata.severity).toBeUndefined();
    expect(row.field_controls).toEqual({});
  });

  it("claims ownership for a scoped token and records the asserting client", async () => {
    const minted = await mintManualEditToken();
    const response = await update(minted.token, {
      metadata: { severity: "high" },
      field_note: "Set from the task board",
      manual_edit: true,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.manual_edit_applied).toBe(true);
    expect(body.applied_fields).toContain("severity");

    const row = await entityRow();
    expect(row.metadata.severity).toBe("high");
    expect(row.field_controls.severity).toMatchObject({
      set_by: owner.id,
      note: "Set from the task board",
      asserted_by_client: `pat_${minted.id}`,
    });
  });

  it("holds a later non-human overwrite of the asserted field while an unowned field applies", async () => {
    const minted = await mintManualEditToken();
    expect((await update(minted.token, { metadata: { severity: "high" }, manual_edit: true })).status).toBe(200);

    // The same backend without the assertion is delegated authority again.
    const response = await update(minted.token, { metadata: { severity: "critical", notes: "runner" } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.manual_edit_applied).toBeFalsy();
    expect(body.blocked_fields).toEqual(["severity"]);
    expect(body.applied_fields).toEqual(["notes"]);
    expect(body.approval_queued).toBe(true);

    const row = await entityRow();
    expect(row.metadata).toMatchObject({ severity: "high", notes: "runner" });
    expect(row.field_controls.notes).toBeUndefined();
    const approvals = await pendingFieldApprovals();
    expect(approvals).toHaveLength(1);
    expect((approvals[0].action_input as { fields: Record<string, unknown> }).fields).toEqual({ severity: "critical" });
  });

  it("allows affirm_fields only with an honoured assertion", async () => {
    const minted = await mintManualEditToken();
    expect((await update(minted.token, { metadata: { severity: "high" } })).status).toBe(200);
    expect((await entityRow()).field_controls).toEqual({});

    const unasserted = await update(minted.token, { affirm_fields: ["severity"] });
    expect(unasserted.status).toBe(400);
    expect((await unasserted.json()).error).toBe("affirm_fields is only allowed for human edits");

    const asserted = await update(minted.token, { affirm_fields: ["severity"], manual_edit: true });
    expect(asserted.status).toBe(200);
    expect((await asserted.json()).manual_edit_applied).toBe(true);
    expect((await entityRow()).field_controls.severity).toMatchObject({
      set_by: owner.id,
      asserted_by_client: `pat_${minted.id}`,
    });
  });

  it("does not report or record an assertion on a plain web-session edit", async () => {
    const response = await update(undefined, { metadata: { severity: "high" } });
    expect(response.status).toBe(200);
    expect((await response.json()).manual_edit_applied).toBeFalsy();
    const marker = (await entityRow()).field_controls.severity;
    expect(marker.set_by).toBe(owner.id);
    expect(marker).not.toHaveProperty("asserted_by_client");
  });

  it("mints entities:manual_edit only from an owner/admin web session", async () => {
    const client = await createTestOAuthClient();
    const oauth = (await createTestAccessToken(owner.id, org.id, client.client_id, { scope: "mcp:admin" })).token;
    const pat = (await createTestPAT(owner.id, org.id, { scope: "mcp:admin" })).token;
    for (const token of [oauth, pat]) {
      const denied = await request("POST", `/api/${org.slug}/tokens`, { name: "escalate", scope: "entities:manual_edit" }, token);
      expect(denied.status).toBe(403);
    }
    const tokens = await getTestDb()`
      SELECT scope FROM personal_access_tokens WHERE organization_id = ${org.id} AND scope LIKE '%entities:manual_edit%'
    `;
    expect(tokens).toHaveLength(0);

    // An OAuth grant cannot carry the scope even when its stored grant names it.
    const smuggled = (await createTestAccessToken(owner.id, org.id, client.client_id, {
      scope: "mcp:write entities:manual_edit",
    })).token;
    const response = await update(smuggled, { metadata: { severity: "high" }, manual_edit: true });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("MANUAL_EDIT_NOT_ALLOWED");

    const member = await createTestUser();
    await addUserToOrganization(member.id, org.id, "member");
    const memberCookie = (await createTestSession(member.id)).cookieHeader;
    const memberMint = await fetch(`${baseUrl}/api/${org.slug}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: memberCookie },
      body: JSON.stringify({ name: "member", scope: "entities:manual_edit" }),
    });
    expect(memberMint.status).toBe(403);

    await mintManualEditToken();
  });
});
