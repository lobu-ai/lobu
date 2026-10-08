/**
 * The org-scoped ACL generation fence.
 *
 * The timestamp fence it supplements orders STATEMENT timestamps, not commit
 * visibility: an invalidation can stamp `updated_at` before a sync's cutoff yet
 * become visible after it, so the sync blesses membership the invalidation had
 * already contradicted. These cases pin the generation half, which is read in
 * the sync's own snapshot and therefore cannot be fooled that way.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bumpAclGeneration } from "../../../authz/acl-generation";
import { markAclFresh } from "../../../authz/access-graph";
import { markConnectionAclFailed } from "../../../authz/acl-observability";
import { getDb } from "../../../db/client";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

describe("ACL generation fence", () => {
	let orgId: string;
	const connectionId = "conn-acl-generation";

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Generation Org" });
		orgId = org.id;
	});

	/** The generation a sync would have observed when it began. */
	async function observeGeneration(): Promise<string | null> {
		const sql = getDb();
		const rows = await sql<{ acl_generation: string | null }>`
      SELECT acl_generation::text AS acl_generation
      FROM organization WHERE id = ${orgId}
    `;
		return rows.length > 0 ? rows[0].acl_generation : null;
	}

	async function freshnessState(): Promise<string | null> {
		const sql = getDb();
		const rows = await sql<{ freshness_state: string }>`
      SELECT freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${orgId} AND connection_id = ${connectionId}
    `;
		return rows.length > 0 ? rows[0].freshness_state : null;
	}

	/** Stamp with a fence captured right now — the ordinary uncontended case. */
	async function stampFresh(): Promise<void> {
		await markAclFresh(orgId, connectionId, {
			startedAt: await syncCutoff(),
			generation: await observeGeneration(),
		});
	}

	async function syncCutoff(): Promise<string> {
		const sql = getDb();
		const rows = await sql<{ now: string }>`
      SELECT clock_timestamp()::text AS now
    `;
		return rows[0].now;
	}

	async function waitForBlockedGenerationRead(timeoutMs = 10_000): Promise<void> {
		const sql = getDb();
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const [{ n }] = await sql<{ n: number }>`
        SELECT count(*)::int AS n
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%SELECT acl_generation::text AS acl_generation%'
          AND query ILIKE '%FOR SHARE%'
      `;
			if (n > 0) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("markAclFresh never blocked on the uncommitted generation bump");
	}

	it("stamps fresh when nothing invalidated mid-sync", async () => {
		const generation = await observeGeneration();
		const cutoff = await syncCutoff();
		await markAclFresh(orgId, connectionId, { startedAt: cutoff, generation });
		expect(await freshnessState()).toBe("fresh");
	});

	it("refuses to INSERT a fresh row when a bump landed mid-sync", async () => {
		// The path the timestamp fence cannot guard at all: with no existing row,
		// `ON CONFLICT … WHERE` never runs, so a sync that began before the
		// invalidation would create a brand-new `fresh` row after it.
		const generation = await observeGeneration();
		const cutoff = await syncCutoff();
		await getDb().begin(async (tx) => {
			await bumpAclGeneration(tx, orgId);
		});
		await markAclFresh(orgId, connectionId, { startedAt: cutoff, generation });
		expect(await freshnessState()).toBeNull();
	});

	it("refuses to UPDATE an existing row to fresh when a bump landed mid-sync", async () => {
		await stampFresh();
		const sql = getDb();
		await sql`
      UPDATE authz_source_acl_state SET freshness_state = 'stale'
      WHERE organization_id = ${orgId} AND connection_id = ${connectionId}
    `;

		const generation = await observeGeneration();
		const cutoff = await syncCutoff();
		await getDb().begin(async (tx) => {
			await bumpAclGeneration(tx, orgId);
		});
		await markAclFresh(orgId, connectionId, { startedAt: cutoff, generation });
		expect(await freshnessState()).toBe("stale");
	});

	it("refuses a revocation whose write timestamp precedes the sync but commits afterward", async () => {
		await stampFresh();
		const generation = await observeGeneration();

		let signalInvalidationWritten!: (writtenAt: string) => void;
		const invalidationWritten = new Promise<string>((resolve) => {
			signalInvalidationWritten = resolve;
		});
		let releaseInvalidation!: () => void;
		const mayCommit = new Promise<void>((resolve) => {
			releaseInvalidation = resolve;
		});

		const invalidating = getDb().begin(async (tx) => {
			await bumpAclGeneration(tx, orgId);
			const [{ updated_at: invalidatedAt }] = await tx<{ updated_at: string }>`
        UPDATE authz_source_acl_state
        SET freshness_state = 'stale', updated_at = clock_timestamp()
        WHERE organization_id = ${orgId} AND connection_id = ${connectionId}
        RETURNING updated_at::text AS updated_at
      `;
			signalInvalidationWritten(invalidatedAt);
			await mayCommit;
			return invalidatedAt;
		});

		const invalidatedAtWrite = await invalidationWritten;
		// The invalidation is still uncommitted, so this sync sees the old
		// generation even though its cutoff is later than the stale-row write.
		expect(await observeGeneration()).toBe(generation);
		// DERIVED from the invalidation's own write timestamp rather than read
		// from the clock. The point of the cutoff is to sit strictly after that
		// write while the invalidation is still uncommitted — reading
		// `clock_timestamp()` from the shared pool only usually produces that
		// ordering, which made this assertion flaky under parallel load.
		const [{ cutoff }] = await getDb()<{ cutoff: string }>`
      SELECT (${invalidatedAtWrite}::timestamptz + interval '1 microsecond')::text AS cutoff
    `;
		const stamping = markAclFresh(orgId, connectionId, { startedAt: cutoff, generation });
		let blockingError: unknown;
		try {
			await waitForBlockedGenerationRead();
		} catch (error) {
			blockingError = error;
		} finally {
			releaseInvalidation();
		}
		await invalidating;
		await stamping;
		if (blockingError) throw blockingError;

		// The whole point: the stamp had a cutoff LATER than the revocation's
		// write, so the timestamp fence alone would have blessed it fresh. The
		// generation is what keeps it stale.
		expect(await freshnessState()).toBe("stale");
	});

	it("stamps fresh once the sync observes the NEW generation", async () => {
		// The fence must not wedge the connection permanently: the next sync reads
		// the bumped generation and is allowed through.
		await getDb().begin(async (tx) => {
			await bumpAclGeneration(tx, orgId);
		});
		const generation = await observeGeneration();
		const cutoff = await syncCutoff();
		await markAclFresh(orgId, connectionId, { startedAt: cutoff, generation });
		expect(await freshnessState()).toBe("fresh");
	});

	it("invalidates an in-flight sync when another ACL sync fails", async () => {
		await stampFresh();
		const generation = await observeGeneration();
		await markConnectionAclFailed(orgId, connectionId, "generation fence test");
		expect(Number(await observeGeneration())).toBeGreaterThan(Number(generation));
		expect(await freshnessState()).toBe("failed");
	});

	it("refuses to stamp when the organization row is missing", async () => {
		// No organization row means no generation to compare, so there is no fence
		// to satisfy. Publishing anyway would bless a projection whose freshness
		// cannot be verified, so this fails closed instead. `connections` cascades
		// from `organization`, so in production this is an orphaned state row or a
		// job racing org deletion — never a live connection.
		const syntheticOrg = "org_does_not_exist_generation";
		await markAclFresh(syntheticOrg, connectionId, {
			startedAt: await syncCutoff(),
			generation: null,
		});
		const sql = getDb();
		const rows = await sql<{ freshness_state: string }>`
      SELECT freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${syntheticOrg} AND connection_id = ${connectionId}
    `;
		expect(rows).toHaveLength(0);
	});
});
