/**
 * Scope of a workspace deletion request (`workspace/deletion.ts`).
 *
 * Requesting deletion cancels work that is still queued, but must not touch
 * work already executing or runs that already reached a terminal state: the
 * status predicate is an explicit allow-list, not a negation. The
 * `awaiting_approval` arm documents a queued state the check constraint does
 * not mint today (`runs_status_check` admits only
 * pending/claimed/running/completed/failed/cancelled/timeout), so the
 * covered assertion is that every queued (`pending`) run for the workspace
 * is cancelled while in-flight and terminal runs — and every run in other
 * workspaces — are untouched.
 *
 * Reader visibility follows in the same test: once deletion is requested,
 * slug lookups and owner resolution stop answering for the workspace,
 * including through the missing-namespace fallback.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { pgBigintArray } from "../../../db/client";
import { requestWorkspaceDeletion } from "../../../workspace/deletion";
import { MultiTenantProvider } from "../../../workspace/multi-tenant";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

async function seedRun(organizationId: string, status: string): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO runs (organization_id, run_type, status)
    VALUES (${organizationId}, 'sync', ${status})
    RETURNING id
  `;
  return Number(row.id);
}

describe("workspace deletion request scope", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("cancels only queued runs and leaves in-flight, terminal, and foreign runs alone", async () => {
    const sql = getTestDb();
    const target = await createTestOrganization({ slug: "deletion-scope-target" });
    const bystander = await createTestOrganization({ slug: "deletion-scope-bystander" });

    const pending = await seedRun(target.id, "pending");
    const claimed = await seedRun(target.id, "claimed");
    const running = await seedRun(target.id, "running");
    const completed = await seedRun(target.id, "completed");
    const failed = await seedRun(target.id, "failed");
    const alreadyCancelled = await seedRun(target.id, "cancelled");
    const foreignPending = await seedRun(bystander.id, "pending");

    const result = await requestWorkspaceDeletion(sql, {
      organizationId: target.id,
      requestedBy: null,
      actorSource: "ui",
    });
    expect(result).toMatchObject({ alreadyRequested: false });

    const rows = await sql<{ id: number; status: string; error_message: string | null }[]>`
      SELECT id, status, error_message FROM runs WHERE id = ANY(${pgBigintArray([pending, claimed, running, completed, failed, alreadyCancelled, foreignPending])}::bigint[])
    `;
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    expect(byId.get(pending)).toMatchObject({
      status: "cancelled",
      error_message: "Workspace deletion requested",
    });
    for (const id of [claimed, running, completed, failed, alreadyCancelled]) {
      expect(byId.get(id)).toBeDefined();
      expect(byId.get(id)!.error_message).toBeNull();
    }
    expect(byId.get(claimed)).toMatchObject({ status: "claimed" });
    expect(byId.get(running)).toMatchObject({ status: "running" });
    expect(byId.get(completed)).toMatchObject({ status: "completed" });
    expect(byId.get(failed)).toMatchObject({ status: "failed" });
    expect(byId.get(foreignPending)).toMatchObject({ status: "pending" });
  });

  it("repeating the request keeps the first marker and cancels newly queued runs", async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ slug: "deletion-scope-repeat" });
    await requestWorkspaceDeletion(sql, {
      organizationId: org.id,
      requestedBy: null,
      actorSource: "ui",
    });
    const late = await seedRun(org.id, "pending");
    const result = await requestWorkspaceDeletion(sql, {
      organizationId: org.id,
      requestedBy: null,
      actorSource: "ui",
    });
    expect(result).toMatchObject({ alreadyRequested: true });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM runs WHERE id = ${late}`;
    expect(row.status).toBe("cancelled");
  });

  it("hides the workspace from slug lookups and owner resolution", async () => {
    const sql = getTestDb();
    const provider = new MultiTenantProvider();
    const org = await createTestOrganization({ slug: "deletion-scope-hidden" });
    await sql`
      INSERT INTO namespace (slug, type, ref_id)
      VALUES (${org.slug}, 'organization', ${org.id})
    `;
    expect(await provider.getOrgSlug(org.id)).toBe(org.slug);
    expect((await provider.getOrgSlugs([org.id])).get(org.id)).toBe(org.slug);
    expect((await provider.resolveOwner(org.slug, "organization"))?.id).toBe(org.id);

    await requestWorkspaceDeletion(sql, {
      organizationId: org.id,
      requestedBy: null,
      actorSource: "ui",
    });

    expect(await provider.getOrgSlug(org.id)).toBeNull();
    expect((await provider.getOrgSlugs([org.id])).size).toBe(0);
    expect(await provider.resolveOwner(org.slug, "organization")).toBeNull();
  });

  it("resolves a missing namespace entry until deletion, then finds nothing", async () => {
    const sql = getTestDb();
    const provider = new MultiTenantProvider();
    const org = await createTestOrganization({ slug: "deletion-scope-fallback" });

    // No namespace row: the fallback reads the organization table directly
    // and self-heals the entry.
    expect((await provider.resolveOwner(org.slug, "organization"))?.id).toBe(org.id);
    const [backfilled] = await sql<{ ref_id: string }[]>`
      SELECT ref_id FROM namespace WHERE slug = ${org.slug} AND type = 'organization'
    `;
    expect(backfilled?.ref_id).toBe(org.id);

    await requestWorkspaceDeletion(sql, {
      organizationId: org.id,
      requestedBy: null,
      actorSource: "ui",
    });

    // The backfilled row still names the workspace, but the live-org join
    // and the fallback both filter on the deletion marker now.
    expect(await provider.resolveOwner(org.slug, "organization")).toBeNull();
  });

  it("leaves other workspaces resolvable", async () => {
    const sql = getTestDb();
    const provider = new MultiTenantProvider();
    const target = await createTestOrganization({ slug: "deletion-scope-gone" });
    const live = await createTestOrganization({ slug: "deletion-scope-live" });
    await requestWorkspaceDeletion(sql, {
      organizationId: target.id,
      requestedBy: null,
      actorSource: "ui",
    });
    expect(await provider.getOrgSlug(live.id)).toBe(live.slug);
    expect((await provider.getOrgSlugs([live.id])).get(live.id)).toBe(live.slug);
  });
});
