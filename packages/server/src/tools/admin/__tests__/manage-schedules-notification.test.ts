import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../../gateway/__tests__/helpers/db-setup";
import { registerScheduledJobsTicker } from "../../../scheduled/scheduled-jobs-service";
import type { ToolContext } from "../../registry";
import { manageSchedules } from "../manage_schedules";

const ORG = "org-sched-notify";
const AGENT = "agent-sched-notify";
const USER = "user-sched-notify";

const ctx: ToolContext = {
  organizationId: ORG,
  userId: USER,
  memberRole: "admin",
  agentId: AGENT,
  sourceContext: null,
  isAuthenticated: true,
  clientId: "lobu-worker",
  scopes: ["mcp:read", "mcp:write", "mcp:admin"],
  tokenType: "pat",
  scopedToOrg: true,
  allowCrossOrg: false,
};

const create = (recipients: unknown) =>
  manageSchedules(
    {
      action: "create",
      description: "notify",
      run_at: new Date(Date.now() + 60_000).toISOString(),
      payload: { type: "send_notification", title: "hi", recipients },
    } as any,
    {} as any,
    ctx
  );

describe("manage_schedules send_notification recipients", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT, { organizationId: ORG, ownerUserId: USER });
    const sql = getDb();
    await sql`
      INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
      VALUES (${USER}, 'member@example.test', 'Member', 'member-user', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES ('m-sched-notify', ${ORG}, ${USER}, 'owner', NOW())
      ON CONFLICT (id) DO NOTHING
    `;
  }, 60_000);

  test("refuses an email string as a recipient and persists nothing", async () => {
    const res: any = await create(["member@example.test"]);
    expect(String(res.error)).toContain("invalid_recipients");
    expect(String(res.error)).toContain("member@example.test");
    const rows = await getDb()`SELECT id FROM scheduled_jobs`;
    expect(rows).toHaveLength(0);
  });

  test("refuses an empty recipient list", async () => {
    const res: any = await create([]);
    expect(String(res.error)).toContain("invalid_recipients");
  });

  test("accepts a member user id and the admins/all keywords", async () => {
    for (const r of [[USER], "admins", "all"]) {
      const res: any = await create(r);
      expect(res.error).toBeUndefined();
      expect(res.schedule).toBeDefined();
    }
  });

  test("ticker records the spawned run id in last_fired_run_id", async () => {
    const res: any = await create([USER]);
    const id = res.schedule.id;
    await getDb()`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = ${id}`;
    const handlers = new Map<string, (c: { payload: unknown; taskRunId: number }) => Promise<void>>();
    registerScheduledJobsTicker({
      register: (name: string, h: any) => handlers.set(name, h),
      spawn: async () => "4242",
    } as any);
    await handlers.get("scheduled-jobs-tick")!({ payload: {}, taskRunId: 1 });
    const [row] = await getDb()`SELECT last_fired_at, last_fired_run_id FROM scheduled_jobs WHERE id = ${id}`;
    expect(row.last_fired_at).not.toBeNull();
    expect(Number(row.last_fired_run_id)).toBe(4242);
  });
});
