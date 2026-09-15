/**
 * Owner-routed approvals: the human who owns the gated fields
 * (entities.field_controls[field].set_by) may decide the run from Slack even
 * without an admin role; a non-admin member who is NOT the owner keeps getting
 * rejected; admins keep working. Exercises the real propose → click → apply
 * chain against Postgres.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
  linkSlackIdentityInGraph,
} from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import { proposeEntityFieldChange } from "../../tools/admin/entity-field-approval.js";
import type { ToolContext } from "../../tools/registry.js";
import { initWorkspaceProvider } from "../../workspace/index.js";
import { registerActionHandlers } from "../connections/interaction-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

const TEAM_ID = "T-OWNERAPPROVE";

type ActionHandler = (event: any) => Promise<void>;

function setupHandler(
  organizationId: string,
  platform = "slack",
): {
  handler: ActionHandler;
  post: ReturnType<typeof mock>;
} {
  let captured: ActionHandler | undefined;
  const chat = {
    onAction: mock((h: ActionHandler) => {
      captured = h;
    }),
  };
  const connection = {
    id: "conn-owner-1",
    platform,
    organizationId,
    config: {},
    settings: {},
    // Only Slack has a workspace axis. Stamping a teamId on a Google Chat
    // connection would hide the very case under test, since `actionEventTeamId`
    // falls back to `connection.metadata.teamId`.
    metadata: platform === "slack" ? { teamId: TEAM_ID } : {},
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as PlatformConnection;
  registerActionHandlers(chat as any, connection);
  if (!captured) throw new Error("onAction handler not registered");
  const post = mock(async () => undefined);
  return { handler: captured, post };
}

interface Fixture {
  orgId: string;
  entityId: number;
  runId: number;
  adminSlackId: string;
  adminUserId: string;
  ownerSlackId: string;
  otherSlackId: string;
  ownerUserId: string;
}

/**
 * Org with an admin, a non-admin field OWNER, and a non-admin bystander — all
 * with verified Slack identities — plus an entity whose `severity` the owner
 * set, and a pending agent proposal to change it.
 */
async function seedApprovalFixture(): Promise<Fixture> {
  const sql = getDb();
  const org = await createTestOrganization({ name: "Owner Approval Org" });
  const admin = await createTestUser({ name: "Admin" });
  const owner = await createTestUser({ name: "Field Owner" });
  const other = await createTestUser({ name: "Bystander" });
  await addUserToOrganization(admin.id, org.id, "admin");
  await addUserToOrganization(owner.id, org.id, "member");
  await addUserToOrganization(other.id, org.id, "member");

  const identities: Array<[string, string]> = [
    ["U-ADMIN", admin.id],
    ["U-OWNER", owner.id],
    ["U-OTHER", other.id],
  ];
  for (const [slackId, lobuId] of identities) {
    await linkSlackIdentityInGraph({
      organizationId: org.id,
      userId: lobuId,
      teamId: TEAM_ID,
      slackUserId: slackId,
    });
  }

  const entity = await createTestEntity({
    name: "Owned Entity",
    organization_id: org.id,
    created_by: admin.id,
  });
  await sql`
    UPDATE entities SET
      metadata = ${sql.json({ severity: "high" })},
      field_controls = ${sql.json({
        severity: { set_by: owner.id, set_at: new Date().toISOString() },
      })}
    WHERE id = ${entity.id}
  `;

  const proposeCtx = {
    organizationId: org.id,
    userId: null,
    agentId: "agent-proposer",
    memberRole: null,
    isAuthenticated: true,
    tokenType: "oauth",
    scopedToOrg: true,
  } as unknown as ToolContext;
  const proposed = await proposeEntityFieldChange(proposeCtx, {
    entity_id: entity.id,
    fields: { severity: "critical" },
    current: { severity: "high" },
    attribution: "agent",
    reason: "An agent proposes updating severity on this entity.",
  });

  return {
    orgId: org.id,
    entityId: entity.id,
    runId: proposed.runId,
    adminSlackId: "U-ADMIN",
    adminUserId: admin.id,
    ownerSlackId: "U-OWNER",
    otherSlackId: "U-OTHER",
    ownerUserId: owner.id,
  };
}

async function runStatus(
  runId: number,
): Promise<{ approval_status: string | null; status: string | null }> {
  const rows = await getDb()<{
    approval_status: string | null;
    status: string | null;
  }>`SELECT approval_status, status FROM runs WHERE id = ${runId}`;
  return rows[0];
}

function clickEvent(
  fx: Fixture,
  slackUserId: string,
  post: ReturnType<typeof mock>,
): Record<string, unknown> {
  return {
    actionId: `run-approval:${fx.runId}:approve`,
    value: "approve",
    thread: { post },
    user: { userId: slackUserId },
    teamId: TEAM_ID,
    channelId: "C-APPROVALS",
    conversationId: "conv-1",
  };
}

describe("interaction bridge — owner-routed approval authority", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("the proposal records the single field owner in action_input", async () => {
    const fx = await seedApprovalFixture();
    const rows = await getDb()<{ owner: string | null }>`
      SELECT action_input->>'owner_user_id' AS owner FROM runs WHERE id = ${fx.runId}
    `;
    expect(rows[0].owner).toBe(fx.ownerUserId);
  });

  test("a non-admin member who is NOT the owner is rejected", async () => {
    const fx = await seedApprovalFixture();
    const { handler, post } = setupHandler(fx.orgId);

    await handler(clickEvent(fx, fx.otherSlackId, post));

    expect((await runStatus(fx.runId)).approval_status).toBe("pending");
    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0][0])).toContain(
      "couldn’t verify that your chat account maps to a Lobu admin",
    );
  });

  /**
   * Approval from a NON-Slack chat. `resolveActionReviewer` used to open with
   * `if (connection.platform !== "slack") return null`, plus a blanket
   * `teamId == null` guard — so every Google Chat tap was refused and the
   * refusal even named Slack. Google Chat carries no workspace id and its
   * `ChatUserIdentity.buildUserKey` ignores one by design, so BOTH the branch
   * and the guard had to go for this to resolve.
   */
  test("a Google Chat admin can approve — no team id, no Slack branch", async () => {
    const fx = await seedApprovalFixture();
    const googleUserId = "users/110000000000000000001";
    await linkChatIdentityInGraph({
      organizationId: fx.orgId,
      userId: fx.adminUserId,
      platform: "gchat",
      platformUserId: googleUserId,
    });

    const { handler, post } = setupHandler(fx.orgId, "gchat");
    await handler({
      actionId: `run-approval:${fx.runId}:approve`,
      value: "approve",
      thread: { post },
      user: { userId: googleUserId },
      // Google Chat sends no team id at all — the case the old guard rejected.
      channelId: "spaces/AAA",
      conversationId: "gchat:spaces/AAA:dm",
    });

    expect((await runStatus(fx.runId)).approval_status).toBe("approved");
  });

  test("the non-admin field owner can approve — run resolves and the change applies", async () => {
    const fx = await seedApprovalFixture();
    const { handler, post } = setupHandler(fx.orgId);

    await handler(clickEvent(fx, fx.ownerSlackId, post));

    const run = await runStatus(fx.runId);
    expect(run.approval_status).toBe("approved");
    expect(run.status).toBe("completed");
    const [entity] = await getDb()<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${fx.entityId}
    `;
    expect(entity.metadata.severity).toBe("critical");
  });

  test("an admin who is not the owner still approves", async () => {
    const fx = await seedApprovalFixture();
    const { handler, post } = setupHandler(fx.orgId);

    await handler(clickEvent(fx, fx.adminSlackId, post));

    expect((await runStatus(fx.runId)).approval_status).toBe("approved");
  });
});
