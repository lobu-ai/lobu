import { assertPhysicalMergeMembersAllowed } from "./identity-association";
import { lockIdentityOrganization } from "./relationship-validation";
/**
 * Entity merge — fold a duplicate `loser` entity into the `winner` it really is.
 *
 * The world-model keystone: when a bridge event (or a reviewer/automation) reveals
 * two entities are the same real thing, this fuses them WITHOUT rewriting the
 * append-only `events` table. It runs off the ingest hot path — a user-configured
 * automation's agent, or an admin, calls it via `manage_entity(action='merge')`; the
 * resolver only ever LOGS a "merge candidate", never fuses inline.
 *
 * Two disjoint event populations recall the winner afterward:
 *   1. Identity/metadata-attributed events (connector-ingested): repaired HERE —
 *      the loser's identities move to the winner, so the existing identity-graph
 *      recall (entity_identities → events.metadata) finds them for free.
 *   2. Raw `events.entity_ids`-stamped events (save_content memories, feed-pinned,
 *      webhooks): can't be rewritten (append-only), so the loser stays as a
 *      tombstone carrying `merged_into = winner`, and the recall redirect in
 *      content-search/entity-link.ts gathers `{winner} ∪ {losers}` for the
 *      `entity_ids @>` branch.
 *
 * Reversal uses the durable `entity_merge_operations` ledger to restore moved
 * identities, canonical attributes, relationship endpoints, and flattened
 * redirects. Undo fails closed when later edits no longer match that operation's
 * after-state. Chains remain flattened (L→W→V stored as L→V, W→V) so reads stay
 * one indexed hop; they must be undone from the outside in.
 */

import { isDeepStrictEqual } from "node:util";
import {
	invalidateOrgAcl,
	lockOrgForAclInvalidation,
} from "../authz/acl-generation";
import { type DbClient, getDb, pgBigintArray } from "../db/client";
import { mergeEntityState } from "../entity-resolution/merge-state";
import {
	RESOLUTION_FINGERPRINT_VERSION,
	type ResolutionEvidence,
} from "../entity-resolution/policy";
import { assertResolutionFingerprintCurrent } from "../entity-resolution/staleness";
import {
	EntityRowValidationError,
	type EntityRowValidationVerdict,
	validateEntityRowMergeGrantingApprovedFields,
} from "../authz/entity-row-validation";
import { transitionEntityMergeRows } from "./entity-management";
import logger from "./logger";
import {
	ACL_MANAGED_TYPE_SQL,
	withAclPrivilege,
} from "./relationship-validation";

export interface MergeResolutionProvenance {
	decision: "auto_merge" | "human";
	sourceRunId?: number | null;
	automationId?: number | null;
	policyHash?: string | null;
	evidence?: ResolutionEvidence[];
}

export interface ApplyMergeParams {
  orgId: string;
  /** The duplicate that gets tombstoned + forwarded. */
  loserId: number;
  /** The surviving entity that absorbs the loser. */
  winnerId: number;
  /** Who triggered the merge (agent id / user id) — for the tombstone audit. */
  mergedBy: string;
	resolution?: MergeResolutionProvenance;
	/**
	 * Set ONLY when this call is the application of a merge a human already
	 * approved, so a rule that escalates on the merge does not escalate the very
	 * merge its escalation asked for. `["$merged_into"]` is the whole vocabulary
	 * a merge card can be said to have approved.
	 */
	approvedFields?: readonly string[];
}

export interface ApplyMergeResult {
  movedIdentities: number;
  repointedEdges: number;
}

export interface ApplyMergeGroupResult {
  mergedEntityIds: number[];
  movedIdentities: number;
  repointedEdges: number;
}

export interface ApplyMergeGroupParams {
  orgId: string;
  loserIds: number[];
  winnerId: number;
  mergedBy: string;
	resolution?: MergeResolutionProvenance;
	expectedResolutionFingerprint?: string;
	/** See {@link ApplyMergeParams.approvedFields}. */
	approvedFields?: readonly string[];
}

/**
 * Preflight a merge against the type's write rules WITHOUT mutating anything.
 *
 * The mirror of `deleteEntity`'s dry run, and it exists for the same reason: a
 * rule refusal should be visible before someone commits to the merge, not
 * discovered as a failed 409 afterwards.
 *
 * Reads on the POOL deliberately. A preview enforces nothing, so there is no
 * check for a concurrent write to overtake — the verdict is advisory by
 * construction, and `applyMergeInTransaction` re-asks it under lock. This is
 * the same exemption `deleteEntity`'s dry run takes.
 *
 * Waives nothing: `approvedFields` is empty. Returns the typed verdict (null
 * when the rules allow the merge) so callers can tell a refusal from a
 * reviewable escalation exactly as execution does.
 */
export async function previewMerge(
	params: { loserIds: number[]; winnerId: number },
	db: DbClient = getDb(),
): Promise<EntityRowValidationVerdict | null> {
	const loserIds = [...new Set(params.loserIds)].sort((a, b) => a - b);
	const [winner] = await db`SELECT organization_id FROM entities WHERE id = ${params.winnerId}`;
	if (winner) await assertPhysicalMergeMembersAllowed(db, String(winner.organization_id), [...loserIds, params.winnerId]);
	if (loserIds.length === 0) return null;
	try {
		await validateEntityRowMergeGrantingApprovedFields({
			tx: db,
			loserIds,
			mergedInto: params.winnerId,
			approvedFields: [],
		});
	} catch (err) {
		if (!(err instanceof EntityRowValidationError)) throw err;
		return err.verdict;
	}
	return null;
}

/**
 * Apply a whole duplicate group under one outer transaction. Any stale or
 * invalid member rolls back every preceding member merge.
 */
export async function applyMergeGroup(
  params: ApplyMergeGroupParams,
  db: DbClient = getDb(),
): Promise<ApplyMergeGroupResult> {
	return db.begin((tx) => applyMergeGroupInTransaction(params, tx));
}

export async function applyMergeGroupInTransaction(
  params: ApplyMergeGroupParams,
  tx: DbClient,
): Promise<ApplyMergeGroupResult> {
  const loserIds = [...new Set(params.loserIds)].sort((a, b) => a - b);
	if (loserIds.length === 0)
		throw new Error("applyMergeGroup: no duplicate entities");
  if (loserIds.includes(params.winnerId)) {
		throw new Error("applyMergeGroup: canonical entity is also a duplicate");
  }

  // The organization outranks the entities: this transaction bumps the org
  // generation after locking entity rows, while organization deletion locks the
  // org and then cascades into `entities`. Claim the parent first or the two
  // deadlock.
  await lockIdentityOrganization(tx, params.orgId);
  await assertPhysicalMergeMembersAllowed(tx, params.orgId, [...loserIds, params.winnerId]);
  await lockOrgForAclInvalidation(tx, params.orgId);

  // Lock the whole group in one global order before applying any member. Pairwise
  // locking inside the loop is not sufficient: overlapping groups with different
  // winners can otherwise each hold one entity while waiting for the other.
  const entityIds = [...loserIds, params.winnerId].sort((a, b) => a - b);
  await tx`
    SELECT id
    FROM entities
    WHERE organization_id = ${params.orgId}
      AND id = ANY(${pgBigintArray(entityIds)}::bigint[])
    ORDER BY id
    FOR UPDATE
  `;

	if (params.expectedResolutionFingerprint) {
		await assertResolutionFingerprintCurrent(tx, {
			organizationId: params.orgId,
			winnerId: params.winnerId,
			loserIds,
			expectedFingerprint: params.expectedResolutionFingerprint,
			// Computed by this process moments ago, so it is current by
			// construction — never a stored digest from an older format.
			expectedVersion: RESOLUTION_FINGERPRINT_VERSION,
		});
	}

  let movedIdentities = 0;
  let repointedEdges = 0;
  for (const loserId of loserIds) {
    const result = await applyMergeInTransaction(
      {
        orgId: params.orgId,
        loserId,
        winnerId: params.winnerId,
        mergedBy: params.mergedBy,
				resolution: params.resolution,
				approvedFields: params.approvedFields,
      },
      tx,
    );
    movedIdentities += result.movedIdentities;
    repointedEdges += result.repointedEdges;
  }
  // ONCE for the whole group, not once per loser. The invalidation is org-wide
  // and idempotent within a transaction, so a 100-loser group doing 100 bumps
  // and 100 org-wide state updates buys nothing and multiplies the write cost
  // and the row-lock hold time by 100.
  await invalidateOrgAcl(tx, params.orgId);
  return { mergedEntityIds: loserIds, movedIdentities, repointedEdges };
}

/**
 * Fuse `loser` into `winner` in one transaction. Idempotent-safe on re-run: a
 * loser already merged into this winner returns a zero result rather than
 * throwing. Throws on a cross-entity-type or already-merged-elsewhere conflict so
 * the caller (tool) surfaces it rather than silently corrupting the graph.
 */
export async function applyMerge(
  params: ApplyMergeParams,
  db: DbClient = getDb(),
): Promise<ApplyMergeResult> {
	// Invalidation lives with the transaction OWNER, not inside
	// `applyMergeInTransaction`, so the group path can invalidate once for all its
	// losers instead of once each.
	return db.begin(async (tx) => {
		await lockIdentityOrganization(tx, params.orgId);
		await assertPhysicalMergeMembersAllowed(tx, params.orgId, [params.loserId, params.winnerId]);
		await lockOrgForAclInvalidation(tx, params.orgId);
		const result = await applyMergeInTransaction(params, tx);
		await invalidateOrgAcl(tx, params.orgId);
		return result;
	});
}

async function applyMergeInTransaction(
  params: ApplyMergeParams,
  tx: DbClient,
): Promise<ApplyMergeResult> {
  const { orgId, loserId, winnerId, mergedBy } = params;
  if (loserId === winnerId) {
		throw new Error("applyMerge: loser and winner are the same entity");
  }

  // Lock both rows in a stable order (lowest id first) to avoid deadlocks when
  // two merges touch the overlapping pair concurrently.
  const [a, b] = loserId < winnerId ? [loserId, winnerId] : [winnerId, loserId];
  const locked = await tx<{
    id: number;
    entity_type_id: number;
    merged_into: number | null;
    deleted_at: string | null;
		name: string;
		metadata: Record<string, unknown>;
		field_controls: Record<string, unknown>;
  }>`
    SELECT id, entity_type_id, merged_into, deleted_at, name, metadata, field_controls
    FROM entities
    WHERE organization_id = ${orgId} AND id IN (${a}, ${b})
    ORDER BY id
    FOR UPDATE
  `;

  const loser = locked.find((row) => Number(row.id) === loserId);
  const winner = locked.find((row) => Number(row.id) === winnerId);
  if (!loser || !winner) {
		throw new Error(
			`applyMerge: entity not found in org (loser=${loserId} winner=${winnerId})`,
		);
  }
  if (Number(loser.merged_into) === winnerId) {
    return { movedIdentities: 0, repointedEdges: 0 };
  }
  if (loser.merged_into !== null) {
		throw new Error(
			`applyMerge: loser ${loserId} already merged into ${loser.merged_into}`,
		);
  }
  if (loser.deleted_at !== null) {
    throw new Error(`applyMerge: loser ${loserId} is deleted`);
  }
  if (winner.merged_into !== null) {
		throw new Error(
			`applyMerge: winner ${winnerId} is itself merged into ${winner.merged_into}`,
		);
  }
  if (winner.deleted_at !== null) {
    throw new Error(`applyMerge: winner ${winnerId} is deleted`);
  }
  if (Number(loser.entity_type_id) !== Number(winner.entity_type_id)) {
		throw new Error(
			"applyMerge: cannot merge entities of different entity types",
		);
  }

	// The type's write rules judge the merge, under the locks taken above and
	// BEFORE any row is written — a denied merge should cost no work, and the
	// verdict must be read from the same snapshot the writes commit into.
	//
	// The loser only. See `validateEntityRowMergeGrantingApprovedFields` for why
	// the winner's metadata and the redirect repoint are deliberately excluded.
	await validateEntityRowMergeGrantingApprovedFields({
		tx,
		loserIds: [loserId],
		mergedInto: winnerId,
		approvedFields: params.approvedFields ?? [],
	});

	const identitiesBefore = await tx<{
		id: number;
		merged_from_entity_id: number | null;
	}>`
    SELECT id, merged_from_entity_id
    FROM entity_identities
    WHERE organization_id = ${orgId}
      AND entity_id = ${loserId}
      AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `;

	const relationshipsBefore = await tx<{
		id: number;
		from_entity_id: number;
		to_entity_id: number;
		deleted_at: Date | string | null;
	}>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.deleted_at
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.organization_id = ${orgId}
      AND r.deleted_at IS NULL
      AND (r.from_entity_id = ${loserId} OR r.to_entity_id = ${loserId})
      -- Authorization edges are deliberately absent from the undo ledger. Step
      -- 2b drops rather than repoints them, and an unmerge must not put a
      -- revoked grant back: the ledger replays an exact prior state, but access
      -- is whatever the provider says NOW. Leaving them out means the next ACL
      -- sync decides, which is the same fail-closed rule the merge followed.
      -- It also keeps unmerge's UPDATE off rows the trigger would refuse.
      AND NOT ${tx.unsafe(ACL_MANAGED_TYPE_SQL)}
    ORDER BY r.id
    FOR UPDATE OF r
  `;

  // 1. Move the loser's LIVE identities to the winner. The move can never hit
  //    `idx_entity_identities_live_unique_tenant_scoped`: `entity_id` is not part of that
  //    index, so repointing a row leaves its key
  //    (org, namespace, identifier, COALESCE(scope_key, ''))
  //    untouched. That holds even when loser and winner both claim the same
  //    (namespace, identifier) under DIFFERENT upstream tenant scopes, which the
  //    index legitimately permits as two live rows. Stamp
  //    origin with COALESCE so an identity that already carries a marker (moved
  //    here by an EARLIER merge, e.g. L→W then W→V) keeps its INNERMOST origin —
	//    the outer operation ledger can then put it back on W without losing L's
	//    provenance.
  const moved = (await tx<{ id: number }>`
    UPDATE entity_identities
    SET entity_id = ${winnerId},
        merged_from_entity_id = COALESCE(merged_from_entity_id, ${loserId}),
        updated_at = current_timestamp
    WHERE organization_id = ${orgId}
      AND entity_id = ${loserId}
      AND deleted_at IS NULL
    RETURNING id
  `) as Array<{ id: number }>;

	// 2. Merge complementary attributes. Scalar conflicts keep the canonical
	//    winner; arrays are unioned; missing fields and ownership markers move.
	//    The exact before/after pair is persisted below so Undo is lossless.
	const mergedState = mergeEntityState(
		{
			name: winner.name,
			metadata: winner.metadata ?? {},
			fieldControls: winner.field_controls ?? {},
		},
		{
			name: loser.name,
			metadata: loser.metadata ?? {},
			fieldControls: loser.field_controls ?? {},
		},
	);
	const updatedWinnerIds = await transitionEntityMergeRows({
		tx,
		organizationId: orgId,
		ids: [winnerId],
		expectedMergedInto: null,
		transition: {
			metadata: mergedState.metadata,
			fieldControls: mergedState.fieldControls,
		},
	});
	if (updatedWinnerIds.length !== 1) {
		throw new Error("applyMerge: canonical entity changed after locking");
	}

  // 2b. DROP the loser's authorization-bearing edges instead of repointing them.
  //
  //     An ACL edge is a projection of the provider's membership, not authored
  //     data, so "which of these two people keeps the channel grant" has no
  //     correct answer to guess — repointing silently transfers one person's
  //     access to another. Tombstoning lets the next sync re-derive the truth,
  //     which fails closed and self-heals. Once classified, the database trigger
  //     would reject the repoint anyway; this makes the intent explicit rather
  //     than crashing the merge.
  //
  //     The privilege is dropped again immediately: steps 3 and 4 below repoint
  //     ordinary edges, and if the flag stayed set for the rest of this
  //     transaction the trigger could no longer refuse a repoint of an
  //     authorization edge this statement did not match.
  await withAclPrivilege(tx, async () => {
    await tx`
      UPDATE entity_relationships r
      SET deleted_at = current_timestamp, updated_at = current_timestamp
      FROM entity_relationship_types rt
      WHERE rt.id = r.relationship_type_id
        AND ${tx.unsafe(ACL_MANAGED_TYPE_SQL)}
        AND r.organization_id = ${orgId}
        AND r.deleted_at IS NULL
        AND (r.from_entity_id = ${loserId} OR r.to_entity_id = ${loserId})
    `;
  });
  // 3. Tombstone loser edges that would become self-loops or collide with an
  //    existing winner edge. This must happen before repointing: the live-edge
  //    unique index rejects the collision during UPDATE, before a later cleanup
  //    statement could run.
  await tx`
    UPDATE entity_relationships r
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE r.organization_id = ${orgId}
      AND r.deleted_at IS NULL
      AND (r.from_entity_id = ${loserId} OR r.to_entity_id = ${loserId})
      AND (
        (CASE WHEN r.from_entity_id = ${loserId} THEN ${winnerId} ELSE r.from_entity_id END) =
        (CASE WHEN r.to_entity_id = ${loserId} THEN ${winnerId} ELSE r.to_entity_id END)
        OR EXISTS (
          SELECT 1
          FROM entity_relationships o
          WHERE o.organization_id = ${orgId}
            AND o.deleted_at IS NULL
            AND o.id <> r.id
            AND o.relationship_type_id = r.relationship_type_id
            AND o.from_entity_id = CASE
              WHEN r.from_entity_id = ${loserId} THEN ${winnerId}
              ELSE r.from_entity_id
            END
            AND o.to_entity_id = CASE
              WHEN r.to_entity_id = ${loserId} THEN ${winnerId}
              ELSE r.to_entity_id
            END
        )
      )
  `;

  // Repoint only the non-colliding live edges that remain.
  const repointed = (await tx<{ id: number }>`
    UPDATE entity_relationships
    SET from_entity_id = CASE WHEN from_entity_id = ${loserId} THEN ${winnerId} ELSE from_entity_id END,
        to_entity_id   = CASE WHEN to_entity_id   = ${loserId} THEN ${winnerId} ELSE to_entity_id   END,
        updated_at = current_timestamp
    WHERE organization_id = ${orgId}
      AND deleted_at IS NULL
      AND (from_entity_id = ${loserId} OR to_entity_id = ${loserId})
    RETURNING id
  `) as Array<{ id: number }>;

  // 4. Flatten: anything that already pointed at the loser now points at the
  //    winner, so every redirect stays exactly one hop (no chain walk at read).
  //    The read redirect (`entity_ids && ARRAY(… merged_into = X …)`) is a
  //    one-time indexed lookup even when X is an outer column, which a recursive
  //    chain walk would NOT be on list/count/order call sites. The identities'
  //    COALESCE'd `merged_from` markers (step 1) preserve reversibility that
  //    the flattened `merged_into` pointer alone would lose. The funnel writes
  //    an explicit id set, so the redirects are locked here first and the write
  //    below re-asserts the topology this read proved.
	const redirectsToFlatten = await tx<{ id: number }>`
    SELECT id
    FROM entities
    WHERE organization_id = ${orgId} AND merged_into = ${loserId}
    ORDER BY id
    FOR UPDATE
  `;
	const redirectIds = redirectsToFlatten.map((entity) => Number(entity.id));
	const redirectedIds = await transitionEntityMergeRows({
		tx,
		organizationId: orgId,
		ids: redirectIds,
		expectedMergedInto: loserId,
		transition: { mergedInto: winnerId },
	});
	if (redirectedIds.length !== redirectIds.length) {
		throw new Error("applyMerge: redirect topology changed after locking");
	}

  // 5. Tombstone the loser and point it at the winner.
	const tombstonedIds = await transitionEntityMergeRows({
		tx,
		organizationId: orgId,
		ids: [loserId],
		expectedMergedInto: null,
		transition: { mergedInto: winnerId, liveness: "deleted" },
	});
	if (tombstonedIds.length !== 1) {
		throw new Error("applyMerge: duplicate entity changed after locking");
	}

	const relationshipIds = relationshipsBefore.map((row) => Number(row.id));
	const relationshipsAfter =
		relationshipIds.length > 0
			? await tx<{
					id: number;
					from_entity_id: number;
					to_entity_id: number;
					deleted_at: Date | string | null;
				}>`
        SELECT id, from_entity_id, to_entity_id, deleted_at
        FROM entity_relationships
        WHERE organization_id = ${orgId}
          AND id = ANY(${pgBigintArray(relationshipIds)}::bigint[])
        ORDER BY id
      `
			: [];
	const afterById = new Map(
		relationshipsAfter.map((row) => [Number(row.id), row]),
	);
	const timestamp = (value: Date | string | null): string | null =>
		value === null ? null : new Date(value).toISOString();
	const ledger = {
		winner: {
			metadataBefore: winner.metadata ?? {},
			metadataAfter: mergedState.metadata,
			fieldControlsBefore: winner.field_controls ?? {},
			fieldControlsAfter: mergedState.fieldControls,
		},
		identities: identitiesBefore.map((identity) => ({
			id: Number(identity.id),
			mergedFromEntityId:
				identity.merged_from_entity_id == null
					? null
					: Number(identity.merged_from_entity_id),
		})),
		redirectedEntityIds: redirectedIds,
		relationships: relationshipsBefore.map((before) => {
			const after = afterById.get(Number(before.id));
			if (!after)
				throw new Error(`applyMerge: relationship ${before.id} disappeared`);
			return {
				id: Number(before.id),
				before: {
					fromEntityId: Number(before.from_entity_id),
					toEntityId: Number(before.to_entity_id),
					deletedAt: timestamp(before.deleted_at),
				},
				after: {
					fromEntityId: Number(after.from_entity_id),
					toEntityId: Number(after.to_entity_id),
					deletedAt: timestamp(after.deleted_at),
				},
			};
		}),
	};
	const resolution = params.resolution ?? { decision: "human" as const };
	await tx`
    INSERT INTO entity_merge_operations
      (organization_id, winner_entity_id, loser_entity_id, source_run_id,
       automation_id, decision, policy_hash, evidence, ledger, merged_by)
    VALUES
      (${orgId}, ${winnerId}, ${loserId}, ${resolution.sourceRunId ?? null},
       ${resolution.automationId ?? null}, ${resolution.decision}, ${resolution.policyHash ?? null},
       ${tx.json(resolution.evidence ?? [])}, ${tx.json(ledger)}, ${mergedBy})
  `;

  logger.info(
    {
      orgId,
      loserId,
      winnerId,
      mergedBy,
      movedIdentities: moved.length,
      repointedEdges: repointed.length,
    },
		"entity merge applied",
  );

  return {
    movedIdentities: moved.length,
    repointedEdges: repointed.length,
  };
}

export interface ApplyUnmergeParams {
  orgId: string;
  /** The tombstoned loser to split back out. */
  loserId: number;
  /** Who triggered the un-merge — for the audit log. */
  unmergedBy: string;
}

export interface ApplyUnmergeResult {
  winnerId: number;
  /** Identities moved back from the winner to the loser. */
  restoredIdentities: number;
}

/**
 * Reverse a merge: split `loser` back out of the winner. The durable operation
 * ledger restores moved identities, canonical metadata, field ownership,
 * relationship endpoints, and redirects flattened by this operation.
 *
 * Chains: `applyMerge` FLATTENS, so every tombstoned loser points at the TERMINAL
 * winner. In `L→W→V`, undo W→V first; that restores L→W and all identities W
 * held before the outer merge. L→W can then be undone exactly. Attempting to
 * undo L directly while it points at V fails closed.
 */
export async function applyUnmerge(
	params: ApplyUnmergeParams,
	db: DbClient = getDb(),
): Promise<ApplyUnmergeResult> {
  const { orgId, loserId, unmergedBy } = params;

  return db.begin(async (tx) => {
    await lockOrgForAclInvalidation(tx, orgId);
    // Discover the winner WITHOUT locking first: we can't name the winner until
    // we read merged_into, but taking the loser's lock here would grab the
    // loser's row before the winner's — inverting applyMerge's lowest-id-first
    // order and deadlocking a concurrent merge of the same pair whenever
    // winnerId < loserId.
    const [probe] = (await tx<{ merged_into: number | null }>`
      SELECT merged_into
      FROM entities
      WHERE organization_id = ${orgId} AND id = ${loserId}
    `) as Array<{ merged_into: number | null }>;
    if (!probe) {
      throw new Error(`applyUnmerge: entity ${loserId} not found in org`);
    }
    if (probe.merged_into === null) {
			throw new Error(
				`applyUnmerge: entity ${loserId} is not merged into anything`,
			);
    }
    const winnerId = Number(probe.merged_into);

    // Lock BOTH rows in one statement, ascending id (matches applyMerge), so no
    // path ever holds these two locks in opposing orders.
		const [lo, hi] =
			loserId < winnerId ? [loserId, winnerId] : [winnerId, loserId];
    const locked = (await tx<{
      id: number;
      merged_into: number | null;
			metadata: Record<string, unknown>;
			field_controls: Record<string, unknown>;
    }>`
      SELECT id, merged_into, metadata, field_controls
      FROM entities
      WHERE organization_id = ${orgId} AND id IN (${lo}, ${hi})
      ORDER BY id
      FOR UPDATE
    `) as Array<{
			id: number;
			merged_into: number | null;
			metadata: Record<string, unknown>;
			field_controls: Record<string, unknown>;
		}>;

    // Re-validate under lock: merged_into can move between the unlocked probe and
    // acquiring the lock (a racing unmerge/merge). Fail closed if it changed so
    // we never operate on a stale winner we didn't lock.
    const loserRow = locked.find((row) => Number(row.id) === loserId);
    if (!loserRow) {
      throw new Error(`applyUnmerge: entity ${loserId} not found in org`);
    }
    if (
      loserRow.merged_into === null ||
      Number(loserRow.merged_into) !== winnerId
    ) {
			throw new Error(
				`applyUnmerge: entity ${loserId} is not merged into anything`,
			);
    }

		const [operation] = await tx<{
			id: number;
			winner_entity_id: number;
			ledger: {
				winner: {
					metadataBefore: Record<string, unknown>;
					metadataAfter: Record<string, unknown>;
					fieldControlsBefore: Record<string, unknown>;
					fieldControlsAfter: Record<string, unknown>;
				};
				identities: Array<{
					id: number;
					mergedFromEntityId: number | null;
				}>;
				redirectedEntityIds: number[];
				relationships: Array<{
					id: number;
					before: {
						fromEntityId: number;
						toEntityId: number;
						deletedAt: string | null;
					};
					after: {
						fromEntityId: number;
						toEntityId: number;
						deletedAt: string | null;
					};
				}>;
			};
		}>`
      SELECT id, winner_entity_id, ledger
      FROM entity_merge_operations
      WHERE organization_id = ${orgId}
        AND loser_entity_id = ${loserId}
        AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `;

		if (operation) {
			if (Number(operation.winner_entity_id) !== winnerId) {
				throw new Error(
					"applyUnmerge: a later merge changed the canonical entity; undo that merge first",
				);
			}
			const winnerRow = locked.find((row) => Number(row.id) === winnerId);
			if (!winnerRow) {
				throw new Error(`applyUnmerge: winner ${winnerId} not found in org`);
			}
			const ledger = operation.ledger;
			if (
				!isDeepStrictEqual(
					winnerRow.metadata ?? {},
					ledger.winner.metadataAfter,
				) ||
				!isDeepStrictEqual(
					winnerRow.field_controls ?? {},
					ledger.winner.fieldControlsAfter,
				)
			) {
				throw new Error(
					"applyUnmerge: canonical attributes changed after this merge; exact undo is unsafe",
				);
			}

			const identityIds = ledger.identities.map((item) => item.id);
			const currentIdentities =
				identityIds.length > 0
					? await tx<{
							id: number;
							entity_id: number;
							merged_from_entity_id: number | null;
							deleted_at: Date | string | null;
						}>`
            SELECT id, entity_id, merged_from_entity_id, deleted_at
            FROM entity_identities
            WHERE organization_id = ${orgId}
              AND id = ANY(${pgBigintArray(identityIds)}::bigint[])
            ORDER BY id
            FOR UPDATE
          `
					: [];
			const currentIdentityById = new Map(
				currentIdentities.map((row) => [Number(row.id), row]),
			);
			for (const item of ledger.identities) {
				const current = currentIdentityById.get(item.id);
				const expectedMarker = item.mergedFromEntityId ?? loserId;
				if (
					!current ||
					Number(current.entity_id) !== winnerId ||
					Number(current.merged_from_entity_id) !== expectedMarker ||
					current.deleted_at !== null
				) {
					throw new Error(
						`applyUnmerge: identity ${item.id} changed after this merge; exact undo is unsafe`,
					);
				}
			}

			const relationshipIds = ledger.relationships.map((item) => item.id);
			const currentRelationships =
				relationshipIds.length > 0
					? await tx<{
							id: number;
							from_entity_id: number;
							to_entity_id: number;
							deleted_at: Date | string | null;
							acl_managed: boolean;
						}>`
            SELECT r.id, r.from_entity_id, r.to_entity_id, r.deleted_at,
                   ${tx.unsafe(ACL_MANAGED_TYPE_SQL)}
                     AS acl_managed
            FROM entity_relationships r
            JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
            WHERE r.organization_id = ${orgId}
              AND r.id = ANY(${pgBigintArray(relationshipIds)}::bigint[])
            ORDER BY r.id
            FOR UPDATE OF r
          `
					: [];
			const currentById = new Map(
				currentRelationships.map((row) => [Number(row.id), row]),
			);
			// A ledger written BEFORE this feature can contain `member_of` rows:
			// back then merge repointed them like any other edge. Restoring one
			// now would resurrect a revoked grant, and once the type is classified
			// the trigger would reject the write outright — which would make every
			// historical merge permanently un-undoable. Skip them in both the
			// exactness check and the restore; the cleanup below drops them.
			const aclManagedIds = new Set(
				currentRelationships
					.filter((row) => row.acl_managed)
					.map((row) => Number(row.id)),
			);
			for (const item of ledger.relationships) {
				if (aclManagedIds.has(item.id)) continue;
				const current = currentById.get(item.id);
				const currentDeletedAt =
					current?.deleted_at == null
						? null
						: new Date(current.deleted_at).toISOString();
				if (
					!current ||
					Number(current.from_entity_id) !== item.after.fromEntityId ||
					Number(current.to_entity_id) !== item.after.toEntityId ||
					currentDeletedAt !== item.after.deletedAt
				) {
					throw new Error(
						`applyUnmerge: relationship ${item.id} changed after this merge; exact undo is unsafe`,
					);
				}
			}

			for (const item of ledger.relationships) {
				if (aclManagedIds.has(item.id)) continue;
				await tx`
          UPDATE entity_relationships
          SET from_entity_id = ${item.before.fromEntityId},
              to_entity_id = ${item.before.toEntityId},
              deleted_at = ${item.before.deletedAt},
              updated_at = current_timestamp
          WHERE organization_id = ${orgId} AND id = ${item.id}
        `;
			}

			const redirectedEntityIds = ledger.redirectedEntityIds ?? [];
			if (redirectedEntityIds.length > 0) {
				const restoredRedirects = await transitionEntityMergeRows({
					tx,
					organizationId: orgId,
					ids: redirectedEntityIds,
					expectedMergedInto: winnerId,
					transition: { mergedInto: loserId },
				});
				if (restoredRedirects.length !== redirectedEntityIds.length) {
					throw new Error(
						"applyUnmerge: a flattened redirect changed after this merge; exact undo is unsafe",
					);
				}
			}
			const restoredWinnerIds = await transitionEntityMergeRows({
				tx,
				organizationId: orgId,
				ids: [winnerId],
				expectedMergedInto: null,
				transition: {
					metadata: ledger.winner.metadataBefore,
					fieldControls: ledger.winner.fieldControlsBefore,
				},
			});
			if (restoredWinnerIds.length !== 1) {
				throw new Error(
					"applyUnmerge: canonical topology changed after locking; exact undo is unsafe",
				);
			}
		}

		// Authorization edges on EITHER entity are dropped, not restored. This is
		// required for ledger-backed and legacy merges alike: while the identities
		// were folded onto the winner, an ACL sync could have resolved the loser's
		// provider identity there and granted the winner access. Splitting them
		// again would leave that grant on someone the provider never granted it to.
		// The only answer that cannot invent access is to drop both sides and let
		// the next sync re-derive from the provider.
		await withAclPrivilege(tx, async () => {
			await tx`
        UPDATE entity_relationships r
        SET deleted_at = current_timestamp, updated_at = current_timestamp
        FROM entity_relationship_types rt
        WHERE rt.id = r.relationship_type_id
          AND ${tx.unsafe(ACL_MANAGED_TYPE_SQL)}
          AND r.organization_id = ${orgId}
          AND r.deleted_at IS NULL
          AND (
            r.from_entity_id IN (${loserId}, ${winnerId})
            OR r.to_entity_id IN (${loserId}, ${winnerId})
          )
      `;
		});

		// Dropping the edges is not enough on its own: a sync that resolved the
		// loser's provider identity to the WINNER before this transaction can
		// still be in flight and would write that already-resolved grant back
		// moments after we commit. Marking the ACL state stale makes the gate stop
		// trusting the snapshot; bumping the generation below prevents that sync
		// from marking it fresh again after this transaction commits.
		//
		// NOT gated on having dropped anything, which is the subtle part. The race
		// this exists for is exactly the case where the drop finds nothing: the
		// sync has already resolved the identity to the winner but has not yet
		// written the edge, so counting dropped rows would skip the invalidation
		// in precisely the window that needs it.
		//
		// Marking unconditionally is harmless where it does not apply: the state
		// update matches no rows for an org that has never onboarded an ACL
		// connection. Where it does match, `stale` FAILS CLOSED for every enforced
		// connection until the next sync — an
		// availability cost taken deliberately on a rare, admin-initiated action,
		// because the alternative is serving access the provider never granted.
		//
		// `clock_timestamp()` remains the secondary fence for two syncs within one
		// generation; the counter covers commit visibility across invalidations.
		await invalidateOrgAcl(tx, orgId);

		// 1. Restore every identity this operation moved, including identities an
		//    inner merge had already placed on the loser. Legacy operations have no
		//    ledger, so they retain the marker-based single-merge fallback.
		let restored: Array<{ id: number }>;
		if (operation) {
			restored = [];
			for (const identity of operation.ledger.identities) {
				const rows = await tx<{ id: number }>`
          UPDATE entity_identities
          SET entity_id = ${loserId},
              merged_from_entity_id = ${identity.mergedFromEntityId},
              updated_at = current_timestamp
          WHERE organization_id = ${orgId} AND id = ${identity.id}
          RETURNING id
        `;
				restored.push(...rows);
			}
		} else {
			restored = (await tx<{ id: number }>`
      UPDATE entity_identities
      SET entity_id = ${loserId},
          merged_from_entity_id = NULL,
          updated_at = current_timestamp
      WHERE organization_id = ${orgId}
        AND entity_id = ${winnerId}
        AND merged_from_entity_id = ${loserId}
        AND deleted_at IS NULL
      RETURNING id
    `) as Array<{ id: number }>;
		}

		// 2. Un-forward and un-tombstone the loser. Ledger-backed merges restored
		//    redirects flattened through it above; legacy merges retain the old
		//    single-row automation because no redirect history exists for them.
		const revivedIds = await transitionEntityMergeRows({
			tx,
			organizationId: orgId,
			ids: [loserId],
			expectedMergedInto: winnerId,
			transition: { mergedInto: null, liveness: "live" },
		});
		if (revivedIds.length !== 1) {
			throw new Error(
				"applyUnmerge: duplicate topology changed after locking; exact undo is unsafe",
			);
		}
		if (operation) {
			await tx`
        UPDATE entity_merge_operations
        SET status = 'undone', undone_at = current_timestamp, undone_by = ${unmergedBy}
        WHERE id = ${operation.id}
      `;
		}

    logger.info(
      {
        orgId,
        loserId,
        winnerId,
        unmergedBy,
        restoredIdentities: restored.length,
      },
			"entity merge reversed",
    );

    return {
      winnerId,
      restoredIdentities: restored.length,
    };
  });
}
