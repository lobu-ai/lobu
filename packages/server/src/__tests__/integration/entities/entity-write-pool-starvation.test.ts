/**
 * Entity-write transactions must never ask the POOL for a second connection.
 *
 * `withEntityWriteTransaction` holds ONE pooled connection for the whole write.
 * A helper inside it that reaches for `getDb()` instead of the caller's handle
 * needs a SECOND connection while still holding the first, so `DB_POOL_MAX`
 * concurrent writers each hold a slot and each wait for a slot only another
 * writer can free. Session waits are unbounded, so the pool is dead for the life
 * of the process — the #2818 hang, whose signature is exactly `DB_POOL_MAX`
 * sessions `idle in transaction` on the same statement.
 *
 * Same one-directional-dependency rule `getLockDb()` already documents for
 * session advisory locks, applied to the entity write path.
 *
 * These assert the INVARIANT (every statement of a write goes through the
 * caller's handle) rather than staging the deadlock itself. Staging it means
 * shrinking the shared singleton pool, and that singleton is process-wide across
 * every file in a Vitest worker — an earlier draft did exactly that and left a
 * later file in the same shard with a closed pool. The invariant is also the
 * stronger check: it fails on a reintroduced `getDb()` directly, without
 * depending on how many writers happen to be concurrent.
 *
 * The fourth fixed site, `ensureResourceEntityType`, needs no case here: its
 * handle parameter is required, so a regression is a compile error.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import {
	applyEventAttributions,
	clearEntityLinkRulesCache,
	resolveSenderIdentity,
} from "../../../utils/entity-link-upsert";
import { ensureMemberEntityType } from "../../../utils/member-entity-type";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const connectorKey = "pool-starvation";
const feedKey = "messages";

/**
 * Wraps a handle so every tagged-template statement issued THROUGH it is
 * recorded. A helper that bypasses it by calling `getDb()` leaves no trace here,
 * which is precisely the defect.
 */
function recordingHandle(handle: DbClient): {
	handle: DbClient;
	statements: string[];
} {
	const statements: string[] = [];
	const proxy = new Proxy(handle, {
		apply(target, thisArg, args) {
			const strings = args[0] as TemplateStringsArray | undefined;
			if (strings && Array.isArray(strings.raw))
				statements.push(strings.raw.join(" ? "));
			return Reflect.apply(target as never, thisArg, args);
		},
	});
	return { handle: proxy as DbClient, statements };
}

const matched = (statements: string[], pattern: RegExp): boolean =>
	statements.some((statement) => pattern.test(statement));

describe("entity write transactions never reach for a pooled connection", () => {
	let orgId: string;

	beforeEach(async () => {
		await cleanupTestDatabase();
		// Both caches answer a HIT without any query at all, so a warm entry would
		// hide the very reads under test.
		clearEntityLinkRulesCache();
		const org = await createTestOrganization({ name: "Pool Starvation Org" });
		orgId = org.id;
		const user = await createTestUser();
		await addUserToOrganization(user.id, orgId, "owner");
		await ensureMemberEntityType(orgId);
		await getTestDb()`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;
	});

	it("resolves the creator through the caller's transaction, not the pool", async () => {
		// The handle has to be a REAL transaction, not the pool: given a pool,
		// `withEntityWriteTransaction` opens its own and the write runs on that one
		// instead of anything this test can observe.
		const { entityId, statements } = await getTestDb().begin(async (tx) => {
			// The #2818 site exactly: the sender miss opens a transaction, resolves an
			// org member to attribute the mint to, then runs the identity lookup.
			const recorded = recordingHandle(tx);
			const resolved = await resolveSenderIdentity(recorded.handle, {
				orgId,
				connectorKey,
				mintEntityType: "person",
				title: "Unknown Sender",
				identities: [
					{
						namespace: "pool_starvation_user_id",
						identifier: "U_STARVE_1",
						matchOnly: false,
						primary: true,
					},
				],
			});
			return { entityId: resolved, statements: recorded.statements };
		});

		// The mint must actually have happened, or the write never reached the
		// statements below and the assertion would pass vacuously.
		expect(typeof entityId).toBe("number");
		expect(matched(statements, /FROM "member"/)).toBe(true);
	});

	it("loads attribution rules through the caller's transaction, not the pool", async () => {
		await createTestConnectorDefinition({
			key: connectorKey,
			name: "Pool Starvation Connector",
			organization_id: orgId,
			feeds_schema: {
				[feedKey]: {
					eventKinds: {
						message: {
							attributions: [
								{
									role: "authored_by",
									target: {
										entityType: "person",
										autoCreate: true,
										titlePath: "metadata.author_name",
										identities: [
											{
												namespace: "pool_starvation_user_id",
												eventPath: "metadata.author_id",
												primary: true,
											},
										],
									},
								},
							],
						},
					},
				},
			},
		});
		clearEntityLinkRulesCache();

		// The attribution-plan loader is what `applyEventAttributions` calls. A
		// caller-supplied handle may already be an open transaction (the sync
		// dry-run path threads its rolled-back one), so a rule read on the pool
		// would hold that transaction's connection while waiting for a second one.
		const { statements } = await getTestDb().begin(async (tx) => {
			const recorded = recordingHandle(tx);
			await applyEventAttributions(
				{
					connectorKey,
					feedKey,
					orgId,
					items: [
						{
							origin_type: "message",
							metadata: {
								author_id: "U_STARVE_2",
								author_name: "Rules Sender",
							},
						},
					],
				},
				recorded.handle,
			);
			return { statements: recorded.statements };
		});

		// Liveness: the plan read really happened, so the reads asserted below are
		// the real ones rather than an early bail-out.
		expect(
			statements.filter((statement) =>
				/FROM connector_definitions/.test(statement),
			).length,
		).toBeGreaterThanOrEqual(1);
		expect(matched(statements, /FROM "member"/)).toBe(true);
	});
});
