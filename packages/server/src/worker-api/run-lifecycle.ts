/**
 * Run lifecycle endpoints.
 *
 * Handlers for the in-flight and completion phases of connector/automation/auth
 * runs: heartbeat, stream, complete, complete-automation, complete-action,
 * complete-auth, complete-embeddings, fetch-events, emit-auth-artifact,
 * poll-auth-signal.
 */

import type {
	CompleteActionRequest,
	CompleteAuthRequest,
	CompleteAutomationRequest,
	CompleteEmbeddingsRequest,
	CompleteRequest,
	EmitAuthArtifactRequest,
	HeartbeatRequest,
	HeartbeatResponse,
	PollAuthSignalRequest,
	StreamBatch,
} from "@lobu/core/contracts/worker/protocol";
import type { Context } from "hono";
import {
	activateAutomationSignal,
	type AutomationActivationResult,
	dispatchAutomationRunsBestEffort,
} from "../automations/activation";
import {
	deriveConnectorActivationSignals,
	loadConnectorDeriveFeedContext,
	type ConnectorDeriveFeedContext,
} from "../automations/connector-derived";
import { materializeConnectorAutomationSignal } from "../automations/connector-signal";
import { feedBackoff } from "../connectors/feed-backoff";
import { parseDependencyUnavailableError } from "../connectors/dependency-unavailable";
import { maybeEmitFeedAutoPausedAfterFailure } from "../automations/platform-events";
import { getDb, parsePgNumberArray } from "../db/client";
import { eventArtifactBinding } from "../gateway/files/artifact-store";
import { emit } from "../events/emitter";
import { parseJsonBody } from "../gateway/routes/shared/helpers";
import type { Env } from "../index";
import { notifyBrowserAuthExpired } from "../notifications/triggers";
import { supersedeActionEvent } from "../tools/admin/approval-events";
import {
	type AuthProfileKind,
	getAuthProfileById,
	getBrowserSessionReadiness,
} from "../utils/auth-profiles";
import { toSecretRefAuthData } from "../utils/auth-credential-secrets";
import { autoLinkEvent } from "../utils/auto-linker";
import { nextRunAt as nextRunAtFromCron } from "../utils/cron";
import {
	getConfiguredEmbeddingModel,
	needsEmbeddingSql,
} from "../utils/embeddings";
import { applyEventAttributions } from "../utils/entity-link-upsert";
import { errorMessage } from "../utils/errors";
import { validateConnectorEventSemanticType } from "../utils/event-kind-validation";
import {
	deleteMaterializedArtifacts,
	materializeActionOutputAttachments,
	materializeInlineAttachments,
	triggerAudioTranscriptions,
} from "../utils/inline-attachments";
import { insertEvent, recordLifecycleEvent } from "../utils/insert-event";
import logger from "../utils/logger";
import { reconcileConnectorRelationshipClaims } from "../utils/relationship-claims";
import { stripNul, stripNulDeep } from "../utils/strip-nul";
import {
	isBrowserConnectorKey,
	sanitizeBrowserActionOutput,
	sanitizeBrowserIngestionFields,
	sanitizeBrowserPayload,
	sanitizeBrowserText,
} from "../utils/browser-ingestion-sanitizer";
import {
	bumpDeviceFinalizeNudge,
	resolveFinalizeNudgeBudget,
} from "../automations/run-completion";
import {
	advanceScheduleAfterTerminalFailure,
	deviceProviderQuotaResetNotBefore,
} from "../automations/schedule-cursor";
import { recordScheduledExecutionFailure } from "../automations/scheduled-failure-policy";
import { publishTurnDeltaBestEffort } from "./agent-turn";
import { authorizeRunForWorker } from "./shared";
import { classifyRunOutcome } from "../runs/run-outcome";
import { runLeaseFence, runOwnerFence } from "../runs/run-lease";

type DbClient = ReturnType<typeof getDb>;
type SqlFragment = ReturnType<DbClient>;

/**
 * Caps on `runs.dry_run_preview`. A dry run exists so an operator can see the
 * SHAPE of what a connector would ingest; it is not a second copy of `events`,
 * and an uncapped preview of a feed that emits thousands of long-bodied items
 * would be a large jsonb write on every batch. `total` in the stored preview is
 * always the true count, so truncation is visible rather than silent.
 */
const DRY_RUN_PREVIEW_LIMIT = 50;
const DRY_RUN_CONTENT_CHARS = 500;

/**
 * Atomic terminal-state transition guarded on `status = 'running' AND
 * claimed_by = worker_id`. If the run was already finalized by another path
 * (e.g. the gateway reaped it on a timeout and the worker reports in late) or
 * this worker isn't the claimant, the UPDATE matches zero rows — the caller
 * must then skip every side effect and ack idempotently. This is the F2
 * guard shared by every /complete handler; do not relax it.
 *
 * `extraSet` carries handler-specific column writes (e.g. items_collected,
 * exit metadata) and is spliced into the SET list. `returning` is the
 * handler's RETURNING column list. Both are nested `sql` fragments.
 */
async function finalizeRun(
	sql: DbClient,
	params: {
		runId: number;
		workerId: string;
		status: "completed" | "failed";
		extraSet?: SqlFragment;
		returning?: SqlFragment;
	}
): Promise<Array<Record<string, unknown>>> {
	const status = params.status;
	const extra = params.extraSet ?? sql``;
	const returning = params.returning ?? sql`id`;
	return (await sql`
    UPDATE runs
    SET status = ${status},
        completed_at = current_timestamp${extra}
    WHERE id = ${params.runId}
      ${runLeaseFence(sql, params.workerId)}
    RETURNING ${returning}
  `) as unknown as Array<Record<string, unknown>>;
}

async function runUsesBrowserConnector(
	sql: DbClient,
	runId: number
): Promise<boolean> {
	const rows = (await sql`
    SELECT connector_key FROM runs WHERE id = ${runId} LIMIT 1
  `) as unknown as Array<{ connector_key: string | null }>;
	return isBrowserConnectorKey(rows[0]?.connector_key);
}

/**
 * Reactivate the auth profile + the paused connections/feeds linked to it
 * after a successful auth run. Connections leave `pending_auth`, paused feeds
 * resume with `next_run_at` seeded. Shared by the auth completion path.
 */
async function reactivateProfileCascade(
	sql: DbClient,
	authProfileId: number,
	organizationId: string,
	profileKind: AuthProfileKind | null,
	authData: {
		credentials: Record<string, unknown>;
		metadata: Record<string, unknown>;
	}
): Promise<void> {
	// Only flat bearer-credential kinds (env, oauth_account, …) get their
	// auth_data stored as `secret://` refs. `browser_session` / `interactive`
	// profiles hold structured session state (cookie jars, Baileys creds) that
	// execution passes through verbatim as `sessionState` and never resolves as
	// refs — secret-ref'ing them would both strip their non-string values
	// (normalizeAuthValues keeps only strings) and leave unresolvable refs on
	// the worker. So those kinds pass their session state through unchanged.
	//
	// Secret upsert + profile activation still share one transaction so a
	// partial failure cannot leave a rotated secret without the matching
	// auth_data row (or vice versa).
	const isSessionStateProfile =
		profileKind === "browser_session" || profileKind === "interactive";
	await sql.begin(async (tx) => {
		const nextAuthData = isSessionStateProfile
			? authData.credentials
			: await toSecretRefAuthData({
					organizationId,
					authProfileId,
					credentials: authData.credentials,
					db: tx,
				});
		await tx`
      UPDATE auth_profiles
      SET auth_data = ${tx.json(nextAuthData)},
          metadata = ${tx.json(authData.metadata)},
          status = 'active',
          updated_at = current_timestamp
      WHERE id = ${authProfileId}
    `;
		await tx`
      UPDATE connections
      SET status = 'active', updated_at = current_timestamp
      WHERE auth_profile_id = ${authProfileId}
        AND status = 'pending_auth'
    `;
		await tx`
      UPDATE feeds f
      SET status = 'active',
          next_run_at = COALESCE(f.next_run_at, NOW()),
          updated_at = current_timestamp
      FROM connections c
      WHERE f.connection_id = c.id
        AND c.auth_profile_id = ${authProfileId}
        AND f.status = 'paused'
    `;
	});
}

/**
 * POST /api/workers/heartbeat
 *
 * Worker sends periodic heartbeat to indicate it's still processing.
 */
export async function heartbeat(c: Context<{ Bindings: Env }>) {
	try {
		const { run_id, worker_id, progress, agent_session, turn_delta } =
			await c.req.json<HeartbeatRequest>();

		const denied = await authorizeRunForWorker(c, run_id, worker_id);
		if (denied) return denied;

		// An agent turn rides its streamed reply on the heartbeat it already
		// sends, so the client sees the answer arrive rather than a blank screen
		// for the length of the turn. Best-effort and awaited: the publish is
		// fenced on the same lease the heartbeat below re-asserts, and a failure
		// must never fail the heartbeat itself.
		if (turn_delta) {
			await publishTurnDeltaBestEffort(run_id, worker_id, turn_delta);
		}

		const sql = getDb();
		// Stamped with the reporting worker so poll can only resume an agent
		// session on the device that owns it.
		const agentSessionCheckpoint = agent_session
			? sql`, run_metadata = jsonb_set(
              COALESCE(run_metadata, '{}'::jsonb),
              '{device_agent_session}',
              ${sql.json({
								protocol: agent_session.protocol,
								agent_kind: agent_session.agent_kind,
								session_id: agent_session.session_id,
								worker_id,
								updated_at: new Date().toISOString(),
							})}::jsonb,
              true
            )`
			: sql``;

		// `authorizeRunForWorker` already checked both of these, but it read the
		// row in a separate statement. This write is not idempotent — it stamps
		// `device_agent_session` with the reporting worker — so a run cancelled or
		// re-claimed in the gap would get another device's session pinned onto it
		// and poll would resume it on the wrong machine. Re-assert the lease in
		// the UPDATE itself; the 409 below is the same body and status
		// `authorizeRunForWorker` returns for the same condition, so it is not a
		// new outcome for the worker to handle.
		const updated = await sql`
      UPDATE runs
      SET last_heartbeat_at = current_timestamp,
          items_collected = COALESCE(${progress?.items_collected_so_far ?? null}, items_collected)${agentSessionCheckpoint}
      WHERE id = ${run_id}
        ${runLeaseFence(sql, worker_id)}
      RETURNING id
    `;
		if (updated.length === 0) {
			// The fence requires `status = 'running'`, so a cancelled run fails it
			// exactly like a lost lease does. The worker has to tell those apart:
			// on a cancel it still owns the run and must finish through its normal
			// completion path so the terminal row and the client's reply get
			// written; on a lost lease another worker owns it and this one must
			// touch nothing. Re-read on ownership alone to say which.
			const [owned] = (await sql`
        SELECT status FROM runs
        WHERE id = ${run_id}
          ${runOwnerFence(sql, worker_id)}
        LIMIT 1
      `) as unknown as Array<{ status: string } | undefined>;
			if (owned?.status === 'cancelled') {
				return c.json<HeartbeatResponse>({
					continue: false,
					stop_reason: 'cancelled',
				});
			}
			return c.json({ error: 'Run is not in progress' }, 409);
		}

		return c.json<HeartbeatResponse>({ continue: true });
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/stream
 *
 * Worker streams content batch for a sync run.
 */
export async function streamContent(c: Context<{ Bindings: Env }>) {
	let browserRun = false;
	const browserSourceOriginIds = new WeakMap<object, string>();
	try {
		let batch = await c.req.json<StreamBatch>();

		// Connector-supplied checkpoints (LinkedIn takeout cursors, browser
		// scrapes) can carry stray NUL (0x00), which Postgres rejects when written
		// to the jsonb checkpoint column (unsupported Unicode escape sequence).
		// Item payloads go through insertEvent which already sanitizes; the
		// checkpoint writes below are raw sql.json, so strip it here.
		if (batch.checkpoint) {
			batch.checkpoint = stripNulDeep(batch.checkpoint) as Record<
				string,
				unknown
			>;
		}

		const denied = await authorizeRunForWorker(
			c,
			batch.run_id,
			batch.worker_id
		);
		if (denied) return denied;

		const sql = getDb();

		// Look up run details for event columns
		const runRows = (await sql`
    SELECT r.feed_id, r.connection_id, r.connector_key, r.organization_id,
           r.dry_run,
           f.feed_key, f.entity_ids
    FROM runs r
    LEFT JOIN feeds f ON f.id = r.feed_id
    WHERE r.id = ${batch.run_id}
  `) as unknown as Array<{
			feed_id: number | null;
			connection_id: number | null;
			connector_key: string;
			organization_id: string;
			dry_run: boolean;
			feed_key: string | null;
			entity_ids: number[] | null;
		}>;

		if (runRows.length === 0) {
			return c.json({ error: "Run not found" }, 404);
		}

		const run = runRows[0];
		const entityIds = parsePgNumberArray(run.entity_ids);
		browserRun = isBrowserConnectorKey(run.connector_key);
		if (browserRun) {
			batch = {
				...batch,
				items: batch.items.map((item) => {
					const sanitized = sanitizeBrowserIngestionFields({
						originId: item.id,
						parentOriginId: item.origin_parent_id,
						title: item.title,
						content: item.payload_text,
						sourceUrl: item.source_url,
						payloadData: item.payload_data,
						payloadTemplate: item.payload_template,
						attachments: item.attachments,
						metadata: item.metadata,
					});
					const next = {
						...item,
						id: sanitized.originId ?? item.id,
						origin_parent_id: sanitized.parentOriginId,
						title: sanitized.title,
						payload_text: sanitized.content ?? item.payload_text,
						source_url: sanitized.sourceUrl,
						payload_data: sanitized.payloadData,
						payload_template: sanitized.payloadTemplate,
						attachments: sanitized.attachments,
						metadata: sanitized.metadata,
						automation_signals: sanitizeBrowserPayload(item.automation_signals),
						embedding: undefined,
					};
					if (next.id !== item.id) browserSourceOriginIds.set(next, item.id);
					return next;
				}),
				checkpoint: sanitizeBrowserPayload(batch.checkpoint),
			};
		}

		// A dry run executes the connector for real — same code, same credentials,
		// same validation, the same INSERTs — and then throws the writes away by
		// rolling back. Read from the run row rather than the request so a worker
		// cannot elect to skip writes, and so any replica handling this callback
		// reaches the same decision.
		//
		// Why rollback rather than a guard on each write. The set of things a dry
		// run must NOT do is open-ended — it grows every time anyone adds a write
		// to this path, and nothing makes them notice. The set it must KEEP is
		// closed: the preview, and that's it. So the code enumerates the closed
		// set and lets the transaction cover the open one. A write added below
		// tomorrow is rolled back without anyone remembering this feature exists.
		//
		// The bonus is the point of the feature: because the real INSERTs actually
		// run, a dry run answers "would this sync work?" honestly. A constraint
		// violation, a bad enum or a NOT NULL surfaces exactly as it would on the
		// real path. Skipping the insert would have reported success on data that
		// could never land.
		//
		// What rollback does NOT cover is anything that leaves Postgres, and those
		// are guarded individually below (marked ESCAPES THE TX). That is a
		// mechanically checkable category — "does this call escape the tx?" — not
		// a list someone has to keep in their head.
		const isDry = run.dry_run === true;
		const dryPreview: Array<Record<string, unknown>> = [];

		// The whole batch, parameterised on a DB handle. The real path passes the
		// singleton: event inserts below remain statement-per-autocommit, while
		// applyEventAttributions opens one bounded transaction for this batch's
		// entity attribution writes. The dry path passes a tx that is rolled back.
		const ingestBatch = async (db: DbClient) => {
			// Audio attachments are queued only after their event insert commits.
			let pendingTranscriptions: Parameters<
				typeof triggerAudioTranscriptions
			>[1] = [];
			let totalItems = 0;
			const rejectedItems: Array<{
				id: string;
				semantic_type?: string;
				errors: string[];
			}> = [];
			const acceptedItems: typeof batch.items = [];

			// Validate the connector-authored payload before attribution adds any
			// server-owned identity projection keys. Besides making strict
			// additionalProperties:false schemas compatible with tenant scope, this
			// keeps a rejected event from creating or accreting an entity that will
			// never have a corresponding durable event.
			for (const item of batch.items) {
				const itemOriginType = item.origin_type ?? null;
				const itemSemanticType =
					item.semantic_type ?? itemOriginType ?? "content";
				const validationType = itemOriginType ?? itemSemanticType;
				if (validationType && run.feed_key) {
					const kindResult = await validateConnectorEventSemanticType(
						validationType,
						item.metadata as Record<string, unknown> | undefined,
						run.connector_key,
						run.feed_key,
						run.organization_id
					);
					if (!kindResult.valid) {
						logger.warn(
							{
								run_id: batch.run_id,
								item_id: browserRun ? "[browser-item]" : item.id,
								semantic_type: validationType,
								errors: kindResult.errors,
							},
							"Connector event semantic type validation failed — rejecting event"
						);
						rejectedItems.push({
							id: item.id,
							semantic_type: validationType,
							errors: kindResult.errors,
						});
						continue;
					}
				}
				acceptedItems.push(item);
			}

			// Resolve or create entities declared via eventKinds[kind].attributions
			// before inserting events. One query per (entityType, matchField) per
			// batch — cheap compared to the per-event inserts that follow.
			//
			// Runs on a dry run too, against `db`: it creates entity rows, and those
			// roll back with everything else. Running it is what makes the inserts
			// below realistic — events carry the entity ids it resolves.
			const appliedAttributions = await applyEventAttributions(
				{
					connectorKey: run.connector_key,
					connectionId: run.connection_id,
					feedKey: run.feed_key,
					orgId: run.organization_id,
					items: acceptedItems,
				},
				db
			);

			// Platform-derived Automation activation: loaded once per batch, shared
			// by every item. A connector that still attaches `automation_signals`
			// (legacy) wins for those items. Loading is part of durable delivery:
			// failure aborts the batch so a retry cannot persist an event without
			// its matching Automation run.
			let deriveContext: ConnectorDeriveFeedContext | null = null;
			if (
				run.feed_id != null &&
				run.feed_key &&
				acceptedItems.some(
					(item) => (item.automation_signals?.length ?? 0) === 0
				)
			) {
				deriveContext = await loadConnectorDeriveFeedContext(
					{
						organizationId: run.organization_id,
						connectorKey: run.connector_key,
						feedKey: run.feed_key,
						feedId: run.feed_id,
					},
					db
				);
			}

			for (const [itemIndex, batchItem] of acceptedItems.entries()) {
				let item = batchItem;
				const sourceOriginId = browserSourceOriginIds.get(item);
				let publishedArtifactIds: string[] = [];
				let artifactCommitted = false;
				try {
					const itemOriginType = item.origin_type ?? null;
					const itemSemanticType =
						item.semantic_type ?? itemOriginType ?? "content";

					// Skip events with no content — connectors must provide text
					if (!item.payload_text && !item.title) {
						logger.warn(
							{
								run_id: batch.run_id,
								item_id: browserRun ? "[browser-item]" : item.id,
								connector: run.connector_key,
							},
							"[stream] Skipping event with empty payload_text and title"
						);
						continue;
					}

					let itemPendingTranscriptions: Awaited<
						ReturnType<typeof materializeInlineAttachments>
					>["pendingTranscriptions"] = [];
					if (!isDry) {
						// ESCAPES THE TX: publish only after validation, immediately before
						// the event insert. The finally block deletes this item's artifacts
						// unless insertEvent wrote a row that references them.
						const materialized = await materializeInlineAttachments(
							[item],
							() =>
								eventArtifactBinding({
									organizationId: run.organization_id,
									connectionId: run.connection_id,
									feedId: run.feed_id,
									originId: item.id,
								})
						);
						item = materialized.items[0] as typeof item;
						itemPendingTranscriptions = materialized.pendingTranscriptions;
						publishedArtifactIds = materialized.publishedArtifactIds;
					}

					const activations: AutomationActivationResult[] = [];
					const inserted = await insertEvent(
						{
							entityIds: entityIds,
							organizationId: run.organization_id,
							originId: item.id,
							title: item.title,
							payloadType: item.payload_type,
							content: item.payload_text,
							payloadData: item.payload_data,
							payloadTemplate: item.payload_template,
							attachments: item.attachments,
							authorName: item.author_name,
							sourceUrl: item.source_url,
							occurredAt: item.occurred_at,
							score: item.score,
							embedding: item.embedding,
							embeddingModel: item.embedding_model,
							metadata: item.metadata as Record<string, unknown> | undefined,
							semanticType: itemSemanticType,
							originType: itemOriginType,
							connectorKey: run.connector_key,
							connectionId: run.connection_id,
							feedKey: run.feed_key,
							feedId: run.feed_id,
							runId: batch.run_id,
							parentOriginId: item.origin_parent_id,
						},
						{
							onConflictUpdate: true,
							// applyEventAttributions scrubbed connector input and rebuilt
							// these reserved fields from identities in the transaction above.
							trustedIdentityScopeProjections: true,
							sourceOriginId,
							// Dry path only: the tx that gets rolled back — the INSERT
							// genuinely executes, so every constraint, trigger and NOT NULL
							// is exercised for real. The real path must NOT pass `db` even
							// though it equals the singleton: a caller-supplied `sql` makes
							// insertEvent skip its advisory-lock dedup transaction (the
							// caller's tx is assumed to be the atomic scope), and that lock
							// is what serializes concurrent ingests of the same
							// (connection_id, origin_id) across replicas.
							sql: isDry ? db : undefined,
							afterPersist: async (persisted, tx) => {
								// Keyed by `origin_type`, like attribution rules. A declaration
								// naming an endpoint the item never mentioned is omitted below,
								// and an empty desired set means this source no longer asserts
								// the edge. An endpoint the item DID mention but that failed to
								// resolve is handled separately — see below.
								const relationshipDeclarations = itemOriginType
									? (appliedAttributions.relationshipsByKind[itemOriginType] ??
										[])
									: [];
								if (
									relationshipDeclarations.length > 0 &&
									run.connection_id == null
								) {
									throw new Error(
										"Connector-declared relationships require a source connection"
									);
								}
								if (run.connection_id != null) {
									const named =
										appliedAttributions.namedEntityIdsByItem.get(itemIndex) ??
										new Map<string, number>();
									const unresolved =
										appliedAttributions.unresolvedNamedAttributionsByItem.get(
											itemIndex
										) ?? new Set<string>();
									const hasUnresolvedRelationshipEndpoint =
										relationshipDeclarations.some(
											(declaration) =>
												unresolved.has(declaration.from) ||
												unresolved.has(declaration.to)
										);
									// A named endpoint that the item asserted but that resolved to
									// nothing (ambiguous merge candidate, create declined) is a
									// transient read failure, not a withdrawal. Reconciliation is
									// all-or-nothing per source item because the claim key covers the
									// item's whole edge set: partially reconciling would retract the
									// unreadable edge. Hold every edge until the next sync reads the
									// item completely.
									if (hasUnresolvedRelationshipEndpoint) {
										logger.warn(
											{
												organizationId: run.organization_id,
												connectionId: run.connection_id,
												originId: persisted.origin_id,
												unresolvedAttributions: [...unresolved],
											},
											"Connector relationship reconciliation skipped because an endpoint attribution did not resolve"
										);
									} else {
										await reconcileConnectorRelationshipClaims(tx, {
											organizationId: run.organization_id,
											connectionId: run.connection_id,
											originId: persisted.origin_id,
											desired: relationshipDeclarations.flatMap((declaration) => {
												const fromEntityId = named.get(declaration.from);
												const toEntityId = named.get(declaration.to);
												return fromEntityId === undefined ||
													toEntityId === undefined
													? []
													: [{ declaration, fromEntityId, toEntityId }];
											}),
										});
									}
								}
								const drafts = item.automation_signals ?? [];
								if (drafts.length > 0) {
									for (const [draftIndex, draft] of drafts.entries()) {
										const signal = materializeConnectorAutomationSignal({
											draft,
											change: persisted.change,
											connectorKey: run.connector_key,
											connectionId: run.connection_id,
											deliveryId: `sync:${batch.run_id}:event:${persisted.id}:${draftIndex}`,
										});
										if (!signal) continue;
										activations.push(
											...(await activateAutomationSignal({
												organizationId: run.organization_id,
												signal,
												db: tx,
											}))
										);
									}
								} else if (deriveContext) {
									const derived = deriveConnectorActivationSignals(
										deriveContext,
										{
											connectionId: run.connection_id,
											originId: item.id,
											kind: itemOriginType ?? itemSemanticType,
											title: item.title ?? null,
											payloadText: item.payload_text ?? null,
											sourceUrl: item.source_url ?? null,
											occurredAt: item.occurred_at ?? new Date(),
											metadata: item.metadata as
												| Record<string, unknown>
												| undefined,
										},
										persisted.change,
										persisted.id
									);
									for (const signal of derived) {
										activations.push(
											...(await activateAutomationSignal({
												organizationId: run.organization_id,
												signal,
												db: tx,
											}))
										);
									}
								}
							},
						}
					);
					// `unchanged` reuses the pre-existing row, which still points at the
					// artifacts published by an earlier sync — the ones we just published
					// were never referenced by any row, so the finally block reclaims them.
					// `state_updated` reconciles counters on the existing row and leaves
					// `attachments` untouched, so it reuses the earlier sync's artifacts
					// exactly as `unchanged` does — the ones just published are unreferenced.
					if (
						inserted.change !== "unchanged" &&
						inserted.change !== "state_updated"
					) {
						artifactCommitted = true;
						const transcriptionConnectionId = run.connection_id;
						if (transcriptionConnectionId != null) {
							pendingTranscriptions.push(
								...itemPendingTranscriptions.map((job) => ({
									...job,
									originId: inserted.origin_id,
									baseEventId: inserted.id,
									connectionId: transcriptionConnectionId,
									title: inserted.title,
								}))
							);
						} else if (itemPendingTranscriptions.length > 0) {
							logger.warn(
								{ run_id: batch.run_id },
								"[stream] Audio transcription skipped — source connection missing"
							);
						}
					}
					// ESCAPES THE TX: this dispatches real Automation runs to the worker
					// fleet. The activation ROWS roll back with the tx, but a dispatched
					// agent run has already left the database — it would run against, and
					// react to, an event that is about to cease to exist.
					if (!isDry) {
						await dispatchAutomationRunsBestEffort(activations);
					}
					if (inserted) {
						totalItems++;
						// ESCAPES THE TX: detached (`.catch(() => {})`) and writes through
						// the getDb() singleton, not `db`, so its writes would commit
						// independently of the rollback — and race it, since nothing awaits
						// them.
						if (entityIds.length > 0 && !isDry) {
							autoLinkEvent({
								eventId: Number(inserted.id),
								entityIds,
								content: item.payload_text,
								title: item.title,
								organizationId: run.organization_id,
							}).catch(() => {});
						}
						// Captured after a successful insert, so the preview describes rows
						// that really did land (and would land again on a real sync) rather
						// than rows we merely hoped would.
						if (isDry && dryPreview.length < DRY_RUN_PREVIEW_LIMIT) {
							dryPreview.push({
								origin_id: item.id,
								title: item.title,
								semantic_type: itemSemanticType,
								payload_type: item.payload_type,
								occurred_at: item.occurred_at,
								author_name: item.author_name,
								source_url: item.source_url,
								// Bounded: a preview is for eyeballing shape, and some
								// connectors emit very large bodies.
								content_preview:
									typeof item.payload_text === "string"
										? item.payload_text.slice(0, DRY_RUN_CONTENT_CHARS)
										: null,
								attachment_count: item.attachments?.length ?? 0,
							});
						}
					}
				} catch (err) {
					if (browserRun) {
						console.error(
							"[stream] Insert failed for browser item:",
							sanitizeBrowserText(errorMessage(err))
						);
					} else {
						console.error("[stream] Insert failed for item", item.id, ":", err);
					}
					throw err;
				} finally {
					if (!artifactCommitted) {
						await deleteMaterializedArtifacts(publishedArtifactIds);
					}
				}
			}

			// ESCAPES THE TX: transcription is an external, paid API call, and it
			// is fired detached so nothing awaits it. `pendingTranscriptions` is
			// already empty on a dry run (nothing was materialized), but the
			// guard stays so this cannot start costing money if materialization
			// ever grows a dry path.
			if (!isDry) {
				triggerAudioTranscriptions(run.organization_id, pendingTranscriptions);
			}

			// Update feed + run checkpoint if provided (so mid-run state like QR
			// codes surface in UI via recent_runs[0].checkpoint before the run
			// completes). No dry-run guard: on a dry run these write to the tx and
			// vanish with it, which is exactly right — advancing the feed checkpoint
			// would silently change what the NEXT real sync collects, making the
			// rows this run previewed unreachable.
			if (batch.checkpoint) {
				if (run.feed_id) {
					await db`
      UPDATE feeds
      SET checkpoint = ${db.json(batch.checkpoint)},
          updated_at = current_timestamp
      WHERE id = ${run.feed_id}
    `;
				}
				await db`
      UPDATE runs
      SET checkpoint = ${db.json(batch.checkpoint)}
      WHERE id = ${batch.run_id}
    `;
			}

			return { totalItems, rejectedItems };
		};

		// The real path: singleton handle, autocommit per statement, byte-for-byte
		// the semantics that shipped before dry runs existed.
		//
		// The dry path: the same closure against a transaction, then an unconditional
		// rollback. postgres.js rolls back when the `begin` callback throws, so the
		// throw IS the mechanism — a sentinel, not an error condition. Catching only
		// that exact object means a genuine failure inside the batch still propagates
		// to the 500 handler below instead of being swallowed as "rolled back fine".
		const DRY_RUN_ROLLBACK = Symbol("dry-run-rollback");
		let outcome: Awaited<ReturnType<typeof ingestBatch>> | null = null;
		if (isDry) {
			try {
				await sql.begin(async (tx) => {
					outcome = await ingestBatch(tx);
					throw DRY_RUN_ROLLBACK;
				});
			} catch (err) {
				if (err !== DRY_RUN_ROLLBACK) throw err;
			}
		} else {
			outcome = await ingestBatch(sql);
		}
		// Unreachable: ingestBatch either assigns `outcome` or throws (and a throw
		// that is not the rollback sentinel is rethrown above). Asserted rather
		// than defaulted to {totalItems: 0} — TypeScript cannot see the assignment
		// through the transaction closure, and a silent zero here would report
		// "ingested nothing" for a batch that may well have ingested plenty.
		if (outcome === null) {
			throw new Error("[stream] batch completed without an outcome");
		}
		const { totalItems, rejectedItems } = outcome as Awaited<
			ReturnType<typeof ingestBatch>
		>;

		if (isDry) {
			// Written AFTER the rollback, on the singleton — this is the one thing a
			// dry run keeps, so it must not be inside the transaction it discards.
			// Accumulates across batches: a sync streams many, and the preview should
			// describe the whole run rather than only its last chunk. The per-batch
			// JS cap only bounds one request's payload, so the stored array is
			// re-capped here — without the ordinality slice a long sync would grow
			// the preview by up to DRY_RUN_PREVIEW_LIMIT per batch, unbounded.
			// `total` counts everything that would have been ingested even past the
			// cap, so the number stays honest when `items` is truncated.
			await sql`
      UPDATE runs
      SET dry_run_preview = jsonb_build_object(
            'items',
            (SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
             FROM jsonb_array_elements(
               COALESCE(dry_run_preview -> 'items', '[]'::jsonb)
                 || ${sql.json(dryPreview)}::jsonb
             ) WITH ORDINALITY AS e(value, ord)
             WHERE e.ord <= ${DRY_RUN_PREVIEW_LIMIT}),
            'total',
            COALESCE((dry_run_preview ->> 'total')::int, 0) + ${totalItems},
            'truncated',
            LEAST(
              jsonb_array_length(
                COALESCE(dry_run_preview -> 'items', '[]'::jsonb)
                  || ${sql.json(dryPreview)}::jsonb
              ),
              ${DRY_RUN_PREVIEW_LIMIT}
            ) < COALESCE((dry_run_preview ->> 'total')::int, 0) + ${totalItems}
          )
      WHERE id = ${batch.run_id}
    `;
		}

		return c.json({
			batches_received: 1,
			total_items: totalItems,
			...(isDry && { dry_run: true }),
			...(rejectedItems.length > 0 && { rejected_items: rejectedItems }),
		});
	} catch (err: unknown) {
		const rawMessage = errorMessage(err);
		const rawStack = err instanceof Error ? err.stack : undefined;
		const message = browserRun ? sanitizeBrowserText(rawMessage) : rawMessage;
		const stack = browserRun ? sanitizeBrowserText(rawStack) : rawStack;
		console.error("[stream] Error:", message, stack);
		return c.json({ error: message, stack }, 500);
	}
}

/**
 * POST /api/workers/complete
 *
 * Worker signals sync run completion (success or failure).
 */
export async function completeWorkerJob(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteRequest>();

		// Strip NUL (0x00) from connector- and worker-supplied payloads before they
		// hit Postgres (see streamContent). The final checkpoint and refreshed
		// browser auth_update are written via raw sql.json below; output_tail is
		// the raw subprocess stdout tail and error_message its failure text, so
		// both carry whatever bytes the OS shell emitted.
		if (req.checkpoint) {
			req.checkpoint = stripNulDeep(req.checkpoint) as Record<string, unknown>;
		}
		if (req.auth_update) {
			req.auth_update = stripNulDeep(req.auth_update) as Record<
				string,
				unknown
			>;
		}
		if (req.error_message) req.error_message = stripNul(req.error_message);
		const dependencyUnavailable =
			req.status === "failed"
				? parseDependencyUnavailableError(req.error_message)
				: null;
		if (dependencyUnavailable) req.error_message = dependencyUnavailable.message;
		if (req.output_tail) req.output_tail = stripNul(req.output_tail);

		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();
		// The two lanes that own their own completion route, resolved in ONE
		// primary-key read: this runs on every generic completion, so each extra
		// round trip is paid by every connector run.
		const [dedicatedLane] = await sql<{
			agent_turn: boolean;
			device_chat: boolean;
		}>`
      SELECT
        run_type = 'agent_turn' AS agent_turn,
        (run_type = 'chat_message'
          AND queue_name = 'messages'
          AND action_input->'executionTarget'->>'kind' = 'device') AS device_chat
      FROM runs
      WHERE id = ${req.run_id}
      LIMIT 1
    `;
		if (dedicatedLane?.agent_turn) {
			// An agent turn carries a transcript and a reply; finalizing it with
			// sync semantics would drop both and mark the turn done. Same shape as
			// the device-chat guard below: refuse, leave the run in progress, and
			// let the lane's own endpoint (or the stale-run reaper) terminalize it.
			return c.json(
				{ error: "Agent turn runs must use the complete-agent-turn endpoint" },
				409
			);
		}
		if (dedicatedLane?.device_chat) {
			// Device chat has a dedicated completion adapter that persists the
			// transcript and publishes the thread_response awaited by Activity. Keep
			// the run in progress when an older daemon calls the generic sync route;
			// sweepStaleDeviceChatRuns — which matches this exact predicate — then
			// produces a visible terminal response.
			return c.json(
				{ error: "Device chat runs must use the complete-chat endpoint" },
				409
			);
		}
		const isBrowserRun = await runUsesBrowserConnector(sql, req.run_id);
		if (isBrowserRun) {
			req.error_message = sanitizeBrowserText(req.error_message) ?? undefined;
			req.output_tail = sanitizeBrowserText(req.output_tail) ?? undefined;
			req.checkpoint = sanitizeBrowserPayload(req.checkpoint);
		}

		// Atomic terminal-state transition with the shared F2 guard (see
		// finalizeRun). A no-op (0 rows) means the run was already finalized by
		// another path (e.g. the gateway reaped it on timeout and the worker is
		// reporting in late) or this worker isn't the claimant — without it a late
		// completion resurrects a reaped run and the feed/auth bookkeeping below
		// double-applies (consecutive_failures, items_collected, next_run_at,
		// auth_data). The failed path also stamps exit diagnostics.
		//
		// The checkpoint write is CASE-guarded on `dry_run` and failure in SQL
		// (rather than read-then-branch in JS) so the guard rides the same atomic
		// UPDATE as the terminal transition: a dry run or failed stream never
		// records a new connector checkpoint.
		const dryGuardedCheckpoint = sql`
          checkpoint = CASE WHEN dry_run OR ${req.status === "failed"} THEN checkpoint
                       ELSE COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint) END`;
		const updatedRuns = (await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: req.status === "failed" ? "failed" : "completed",
			extraSet:
				req.status === "failed"
					? sql`,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},${dryGuardedCheckpoint},
          output_tail = ${req.output_tail ?? null},
          exit_code = ${req.exit_code ?? null},
          exit_signal = ${req.exit_signal ?? null},
          exit_reason = ${req.exit_reason ?? null}`
					: sql`,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},${dryGuardedCheckpoint}`,
			returning: sql`feed_id, connection_id, dry_run`,
		})) as unknown as Array<{
			feed_id: number | null;
			connection_id: number | null;
			dry_run: boolean;
		}>;

		if (updatedRuns.length === 0) {
			// The run was already finalized (timeout race) or this worker isn't the
			// claimant. Skip all feed/auth bookkeeping and return an idempotent
			// already-finalized response.
			logger.info(
				{
					run_id: req.run_id,
					worker_id: req.worker_id,
					claimed_status: req.status,
				},
				"[completeWorkerJob] no-op: run already in terminal state (likely gateway timeout)"
			);
			return c.json({ success: false, reason: "already_finalized" });
		}

		// Update the feed's sync state
		const runRows = updatedRuns;
		const feedId = runRows[0]?.feed_id;
		const isDry = runRows[0]?.dry_run === true;

		// Never for a dry run: this block stamps last_sync_at/status, resets or
		// increments consecutive_failures, adds items_collected, ADVANCES THE FEED
		// CHECKPOINT, and moves next_run_at (with backoff/auto-pause on failure).
		// Every one of those durably changes what the next REAL sync does or how
		// the feed reports its last real outcome — exactly the state a dry run
		// exists to leave untouched.
		//
		// Why this stays an explicit guard while streamContent uses a rolled-back
		// transaction instead. Two reasons, and they are the reasons — not an
		// oversight to be tidied up later:
		//
		//  1. This function's write set is closed and cannot grow the way an
		//     item-ingest loop grows: it finalizes one run row and stamps one feed
		//     row. One guard covers one block; there is no open set to lose track of.
		//  2. The keep/discard sets are INTERLEAVED. A dry run must still finalize
		//     its own run row — that is real working state, and finalizeRun's whole
		//     purpose is that the terminal transition is atomic. Rolling back here
		//     would mean lifting the run update out of the transaction and giving up
		//     that guarantee to buy uniformity. Not a trade worth making.
		if (feedId && !isDry) {
			const feedRows = (await sql`
      SELECT schedule, timezone FROM feeds WHERE id = ${feedId}
    `) as unknown as Array<{
				schedule: string | null;
				timezone: string | null;
			}>;

			// Manual feeds (no schedule) stay unscheduled after completion.
			const schedule = feedRows[0]?.schedule ?? null;
			const nextRun = schedule
				? nextRunAtFromCron(schedule, new Date(), feedRows[0]?.timezone ?? null)
				: null;
			const isSuccess = req.status === "success";

			// A connector that could not reach a required execution dependency never
			// reached the source. Preserve the last real source-health result, do not
			// consume the hard-pause budget, and keep the ordinary schedule armed.
			if (dependencyUnavailable) {
				await sql`
          UPDATE feeds
          SET last_error = ${req.error_message ?? null},
              next_run_at = ${nextRun},
              updated_at = current_timestamp
          WHERE id = ${feedId}
        `;
			} else {

			// Failure rescheduling (item 5, #2033):
			//  - On success: reset consecutive_failures to 0 and use the plain cron
			//    next_run_at so a recovered feed immediately resumes normal cadence.
			//  - On failure: apply exponential backoff on top of the cron cadence so
			//    a persistently-failing feed retries progressively less often instead
			//    of re-enqueueing every plain cadence (which hammered the connector,
			//    the worker lane, and upstream rate limits). The backoff is computed
			//    from the NEW consecutive_failures count (post-increment) directly in
			//    SQL so it stays correct under concurrent completions across replicas.
			//  - Hard auto-pause: once the NEW count crosses the pause threshold, the
			//    feed is paused (status='paused'; the DB trigger nulls next_run_at).
			//    Crossing the threshold emits feed.auto_paused so Automations can react.
			//    Manual feeds (no schedule) can't exponentially back off (nextRun is
			//    NULL) but still hard-pause.
			const backoffBaseMs = feedBackoff.baseMs;
			const backoffMaxMs = feedBackoff.maxMs;
			const pauseThreshold = feedBackoff.pauseThreshold;

			const feedUpdate = (await sql`
        UPDATE feeds
        SET last_sync_at = current_timestamp,
            last_sync_status = ${req.status},
            last_error = ${isSuccess ? null : (req.error_message ?? null)},
            consecutive_failures = ${isSuccess ? sql`0` : sql`consecutive_failures + 1`},
            first_failure_at = ${isSuccess ? sql`NULL` : sql`COALESCE(first_failure_at, current_timestamp)`},
            items_collected = ${isSuccess ? sql`items_collected + ${req.items_collected ?? 0}` : sql`items_collected`},
            checkpoint = ${isSuccess ? sql`COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint)` : sql`checkpoint`},
            status = ${
							isSuccess
								? sql`status`
								: sql`CASE WHEN consecutive_failures + 1 >= ${pauseThreshold} THEN 'paused' ELSE status END`
						},
            next_run_at = ${
							isSuccess
								? nextRun
								: sql`CASE
                    WHEN consecutive_failures + 1 >= ${pauseThreshold} THEN NULL
                    WHEN ${nextRun}::timestamptz IS NULL THEN NULL
                    ELSE GREATEST(
                      ${nextRun}::timestamptz,
                      current_timestamp + (LEAST(
                        ${backoffBaseMs}::bigint * (2 ^ LEAST(consecutive_failures, 30))::bigint,
                        ${backoffMaxMs}::bigint
                      ) || ' milliseconds')::interval
                    )
                  END`
						},
            updated_at = current_timestamp
        WHERE id = ${feedId}
        RETURNING consecutive_failures, status
      `) as Array<{ consecutive_failures: number; status: string }>;

			if (!isSuccess) {
				const after = feedUpdate[0];
				const consec = Number(after?.consecutive_failures ?? 0);
				// Emit when paused at/above threshold. delivery_id is stable per
				// failure episode (first_failure_at), so retries after a failed
				// activation are idempotent and do not double-queue Automations.
				try {
					await maybeEmitFeedAutoPausedAfterFailure({
						feedId,
						consecutiveFailures: consec,
						pauseThreshold,
						runId: req.run_id,
					});
				} catch (err) {
					// Feed is already paused; log hard so we notice lost activation,
					// but do not fail the worker complete ACK (run is terminal).
					logger.error(
						{ feed_id: feedId, error: errorMessage(err) },
						"[completeWorkerJob] maybeEmitFeedAutoPausedAfterFailure threw"
					);
				}
			}
			}
		}

		// Persist refreshed browser auth data on the auth profile.
		//
		// Deliberately NOT gated on dry_run: this is credential liveness, not
		// ingested data. Session-state connectors (browser cookies, Baileys creds)
		// rotate their tokens on every real connect — the connector genuinely ran,
		// so discarding the rotation would leave the profile holding invalidated
		// credentials and break the next REAL sync. "Persist nothing" means the
		// workspace's data, never the auth state the run consumed.
		const connectionId = runRows[0]?.connection_id;
		if (req.status === "success" && req.auth_update && connectionId) {
			const connectionRows = (await sql`
        SELECT c.organization_id, c.connector_key, c.auth_profile_id
        FROM connections c
        WHERE c.id = ${connectionId}
        LIMIT 1
      `) as Array<{
				organization_id: string;
				connector_key: string;
				auth_profile_id: number | null;
			}>;

			const connection = connectionRows[0];
			const authProfile =
				connection?.auth_profile_id != null
					? await getAuthProfileById(
							connection.organization_id,
							connection.auth_profile_id
						)
					: null;

			if (authProfile?.profile_kind === "browser_session") {
				const nextAuthData = {
					...(authProfile.auth_data ?? {}),
					...req.auth_update,
				};
				const nextStatus = (
					await getBrowserSessionReadiness(
						nextAuthData,
						connection.connector_key
					)
				).usable
					? "active"
					: "pending_auth";

				await sql`
          UPDATE auth_profiles
          SET auth_data = ${sql.json(nextAuthData)},
              status = ${nextStatus},
              updated_at = current_timestamp
          WHERE id = ${authProfile.id}
        `;

				await sql`
          UPDATE connections
          SET status = ${nextStatus === "active" ? "active" : "pending_auth"},
              updated_at = current_timestamp
          WHERE auth_profile_id = ${authProfile.id}
        `;

				await sql`
          UPDATE feeds f
          SET status = ${nextStatus === "active" ? "active" : "paused"},
              next_run_at = ${
								nextStatus === "active"
									? sql`COALESCE(f.next_run_at, NOW())`
									: sql`NULL`
							},
              updated_at = current_timestamp
          FROM connections c
          WHERE f.connection_id = c.id
            AND c.auth_profile_id = ${authProfile.id}
        `;

				if (nextStatus === "pending_auth") {
					notifyBrowserAuthExpired({
						orgId: connection.organization_id,
						connectionId,
						connectorKey: connection.connector_key,
						authProfileSlug: authProfile.slug,
					}).catch(() => {});
				}
			} else if (authProfile?.profile_kind === "interactive") {
				// Interactive profiles (e.g. WhatsApp/Baileys) manage their own session
				// tokens. Merge the connector's auth_update into auth_data. A sentinel
				// { creds: null } wipes the profile and forces re-pair.
				const update = (req.auth_update ?? {}) as Record<string, unknown>;
				const wiped = update.creds === null;
				const nextAuthData = wiped
					? {}
					: { ...(authProfile.auth_data ?? {}), ...update };
				const nextStatus = wiped ? "pending_auth" : "active";

				await sql`
          UPDATE auth_profiles
          SET auth_data = ${sql.json(nextAuthData)},
              status = ${nextStatus},
              updated_at = current_timestamp
          WHERE id = ${authProfile.id}
        `;

				if (wiped) {
					await sql`
            UPDATE connections
            SET status = 'pending_auth',
                updated_at = current_timestamp
            WHERE auth_profile_id = ${authProfile.id}
          `;
					await sql`
            UPDATE feeds f
            SET status = 'paused', next_run_at = NULL, updated_at = current_timestamp
            FROM connections c
            WHERE f.connection_id = c.id AND c.auth_profile_id = ${authProfile.id}
          `;
				}
			}
		}

		logger.info({ run_id: req.run_id, status: req.status }, "Run completed");

		return c.json({ success: true });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeWorkerJob] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * Prompt appended to the re-spawned CLI when a device Automation exited without
 * calling completeWindow. Module-level so a granted resume and its idempotent
 * replay hand the device byte-identical instructions.
 */
const MISSING_COMPLETE_WINDOW_NUDGE =
	"Device CLI exited without calling completeWindow. Re-run the Automation task and " +
	"finalize via the lobu skill + CLI (preferred): " +
	"`lobu memory exec` with client.knowledge.read({ automation_id }) then " +
	"client.automations.completeWindow({ window_token, extracted_data, run_id }). " +
	"MCP query_sdk/run_sdk is also fine if wired. Do not only print a summary.";

/**
 * POST /api/workers/me/runs/:runId/complete-automation
 *
 * Device-side EXIT REPORT for an automation run executed by a local CLI agent
 * (Claude Code, agy, etc.) on the user's machine. The Owletto Mac app's
 * `AutomationDispatcher` posts here once the subprocess exits.
 *
 * The agent is expected to complete window Automations itself — via Lobu MCP
 * tools (`query_sdk` / `run_sdk` → `completeWindow`) and/or the local
 * `lobu` CLI (`lobu memory exec` with the same ClientSDK calls). This
 * endpoint records process exit metadata and enforces the finalize contract:
 *
 * - body.error set → the subprocess crashed/timed out → run failed.
 * - clean exit + run already completed (by complete_window) → ack; stamp
 *   exit metadata and the window's wall-clock.
 * - clean exit + event-turn Automation still running → complete without a
 *   window (turn path has no completeWindow step).
 * - clean exit + window Automation still running + finalize budget left →
 *   status `resume` (run stays claimed/running; Mac re-spawns with nudge).
 * - clean exit + window Automation still running + budget exhausted →
 *   failed with reason_code `missing_complete_window`.
 * - a replay of a report already answered with a resume (body
 *   `finalize_attempt` behind the stored count, i.e. the device never saw the
 *   response) → the same `resume` again, consuming no further attempt.
 *
 * Authorization: the caller must own the claim — same gate as
 * /api/workers/complete (status='running' AND claimed_by === worker_id).
 */
export async function completeAutomationRun(c: Context<{ Bindings: Env }>) {
	const runIdParam = c.req.param("runId");
	if (!runIdParam) {
		return c.json({ error: "runId is required" }, 400);
	}
	const runId = Number(runIdParam);
	if (!Number.isFinite(runId) || runId <= 0) {
		return c.json({ error: "Invalid runId" }, 400);
	}

	const body = await parseJsonBody<CompleteAutomationRequest>(
		c,
		"Invalid or missing JSON body"
	);
	if (body instanceof Response) return body;

	// allowTerminal: when the CLI agent already completed the run via MCP
	// complete_window, the exit report arrives against a terminal run — that's
	// the happy path. Ownership (scope + claimed_by) is still enforced.
	const denied = await authorizeRunForWorker(c, runId, body.worker_id, {
		allowTerminal: true,
	});
	if (denied) return denied;

	const sql = getDb();
	// Reload the row now that authorization has cleared. Status drives the
	// exit-report decision; the status-and-claim predicates on the writes below
	// remain authoritative if this read races another terminal path.
	const runRows = (await sql`
    SELECT id, organization_id, automation_id, approved_input, run_type,
           claimed_at, claimed_by, status
    FROM runs
    WHERE id = ${runId}
    LIMIT 1
  `) as unknown as Array<{
		id: number;
		organization_id: string;
		automation_id: number | null;
		approved_input: Record<string, unknown> | null;
		run_type: string;
		claimed_at: string | Date | null;
		claimed_by: string | null;
		status: string;
	}>;
	const run = runRows[0];
	if (!run) return c.json({ error: "Run not found" }, 404);
	if (run.run_type !== "automation") {
		return c.json({ error: "Not an Automation run" }, 409);
	}
	if (run.automation_id == null) {
		return c.json({ error: "Automation run missing automation_id" }, 500);
	}
	if (run.claimed_by !== body.worker_id) {
		return c.json({ ok: true, status: run.status, idempotent: true });
	}

	const automationId = Number(run.automation_id);
	const approved = (run.approved_input ?? {}) as Record<string, unknown>;

	// Fix 2 (pi round-2): device-identity binding pinned to the OAuth token, not
	// the request body.
	//
	// The previous version looked up `(workerUserId, body.worker_id)` in
	// `device_workers`, but `body.worker_id` is client-supplied. A same-user
	// token could complete as a different registered worker by posting that
	// worker's id. The fix is the same trick `pollWorkerJob` already uses: if
	// the token was minted with a `workerId` binding (`device_worker:run`
	// PATs/OAuth tokens always are), require `body.worker_id === boundWorkerId`
	// AND, if the run is pinned to a device, the bound worker's
	// `device_workers.id` matches `approved_input.device_worker_id`.
	//
	// For legacy/admin tokens with no `workerId` binding we fall through to the
	// old user_id+worker_id lookup, but emit a warning so the audit trail can
	// catch this path if it ever fires in production (Lobu for Mac always
	// mints worker-bound tokens via /api/me/devices/mint-child-token).
	if (c.var.workerAuthMode === "user") {
		const workerUserId = c.var.workerUserId;
		const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
		const pinnedDeviceWorkerId =
			typeof approved.device_worker_id === "string"
				? approved.device_worker_id
				: null;

		if (boundWorkerId) {
			if (boundWorkerId !== body.worker_id) {
				logger.warn(
					{
						run_id: runId,
						body_worker_id: body.worker_id,
						bound_worker_id: boundWorkerId,
					},
					"[completeAutomationRun] body.worker_id != token-bound worker_id — rejecting"
				);
				return c.json(
					{
						error: "worker_id_mismatch",
						error_description: `this token is bound to worker_id '${boundWorkerId}'`,
					},
					403
				);
			}
			if (pinnedDeviceWorkerId && workerUserId) {
				const deviceRows = (await sql`
          SELECT id
          FROM device_workers
          WHERE user_id = ${workerUserId}
            AND worker_id = ${boundWorkerId}
          LIMIT 1
        `) as unknown as Array<{ id: string }>;
				const callerDeviceWorkerId = deviceRows[0]?.id ?? null;
				if (
					!callerDeviceWorkerId ||
					callerDeviceWorkerId !== pinnedDeviceWorkerId
				) {
					logger.warn(
						{
							run_id: runId,
							bound_worker_id: boundWorkerId,
							caller_device: callerDeviceWorkerId,
							pinned_device: pinnedDeviceWorkerId,
						},
						"[completeAutomationRun] device_worker_id mismatch — rejecting"
					);
					return c.json({ error: "Forbidden: device worker mismatch" }, 403);
				}
			}
		} else if (workerUserId && pinnedDeviceWorkerId) {
			// Legacy/admin path: no worker-bound token. Fall back to the
			// (user_id, body.worker_id) lookup; this is weaker than the bound path
			// but still gates on user ownership. Emit a warning so prod telemetry
			// can flag if any non-Mac caller hits this branch.
			logger.warn(
				{
					run_id: runId,
					worker_user_id: workerUserId,
					body_worker_id: body.worker_id,
				},
				"[completeAutomationRun] no token-bound workerId — falling back to user_id+worker_id check"
			);
			const deviceRows = (await sql`
        SELECT id
        FROM device_workers
        WHERE user_id = ${workerUserId}
          AND worker_id = ${body.worker_id}
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
			const callerDeviceWorkerId = deviceRows[0]?.id ?? null;
			if (
				!callerDeviceWorkerId ||
				callerDeviceWorkerId !== pinnedDeviceWorkerId
			) {
				logger.warn(
					{
						run_id: runId,
						body_worker_id: body.worker_id,
						caller_device: callerDeviceWorkerId,
						pinned_device: pinnedDeviceWorkerId,
					},
					"[completeAutomationRun] device_worker_id mismatch (legacy path) — rejecting"
				);
				return c.json({ error: "Forbidden: device worker mismatch" }, 403);
			}
		}
	}

	// The device CLI's stdout/stderr reach us verbatim, so both can carry NUL
	// (0x00) that Postgres rejects (see streamContent). Strip once here: these
	// two feed every downstream write — output_tail, the resume nudge's tail,
	// error_message, and the completion lifecycle event.
	if (typeof body.error === "string") body.error = stripNul(body.error);
	const hasError = typeof body.error === "string" && body.error.trim() !== "";
	const output = typeof body.output === "string" ? stripNul(body.output) : "";
	const durationMs =
		typeof body.duration_ms === "number" && Number.isFinite(body.duration_ms)
			? Math.max(0, Math.floor(body.duration_ms))
			: null;

	// Mark the run failed and, for non-event dispatches, tick the schedule
	// forward. The RETURNING guard keeps a concurrent duplicate POST from
	// advancing `next_run_at` twice and skipping a window.
	// The stdout tail is stashed for diagnosis (why didn't the agent call
	// complete_window?); the worker redacts before sending.
	const failRun = async (reason: string): Promise<boolean> => {
		return sql.begin(async (tx) => {
			const failedRows = (await tx`
        UPDATE runs
        SET status = 'failed',
            outcome = ${classifyRunOutcome({ status: "failed", errorMessage: reason })},
            completed_at = current_timestamp,
            error_message = ${reason},
            output_tail = ${output ? output.slice(-2000) : null},
            exit_code = ${body.exit_code ?? null},
            exit_signal = ${body.exit_signal ?? null},
            exit_reason = ${body.exit_reason ?? "error_message"}
        WHERE id = ${runId}
          ${runLeaseFence(tx, body.worker_id)}
        RETURNING id
      `) as unknown as Array<{ id: number }>;
			if (failedRows.length === 0) return false;
			await tx`
        UPDATE automations
        SET last_fired_at = NOW(), updated_at = NOW()
        WHERE id = ${automationId}
      `;
			await recordScheduledExecutionFailure(
				tx,
				automationId,
				typeof approved.dispatch_source === "string"
					? approved.dispatch_source
					: null
			);
			await advanceScheduleAfterTerminalFailure(
				tx,
				automationId,
				typeof approved.dispatch_source === "string"
					? approved.dispatch_source
					: null,
				deviceProviderQuotaResetNotBefore(reason)
			);
			return true;
		});
	};

	const emitCompletionEvent = (
		outcome: "completed" | "failed",
		detail?: string
	) => {
		// Fire-and-forget: a "change" event so the dashboard's metric_series picks
		// up the device-CLI completion the same way it picks up server-side ones.
		// LifecycleOp is restricted to created/updated/deleted — we use 'updated'
		// and put the actual ran/errored detail under `extra`.
		recordLifecycleEvent({
			organizationId: run.organization_id,
			entityType: "automation",
			op: "updated",
			entityId: String(automationId),
			summary:
				outcome === "failed"
					? `Automation run ${runId} failed on device CLI: ${detail ?? "unknown error"}`
					: `Automation run ${runId} completed via device CLI`,
			extra: {
				run_id: runId,
				source: "device_worker",
				outcome,
				duration_ms: durationMs,
			},
		});
	};

	if (hasError) {
		const transitioned = await failRun(body.error as string);
		if (!transitioned) {
			const finalRows = (await sql`
        SELECT status FROM runs WHERE id = ${runId} LIMIT 1
      `) as unknown as Array<{ status: string }>;
			return c.json({
				ok: true,
				status: finalRows[0]?.status ?? "failed",
				idempotent: true,
			});
		}
		emitCompletionEvent("failed", body.error ?? undefined);
		return c.json({ ok: true, status: "failed" });
	}

	// A standalone device daemon can be intentionally stopped while its local
	// CLI is still running. Preserve that terminal intent instead of sending the
	// run through the missing-completeWindow resume budget or failure taxonomy.
	if (body.exit_reason === "cancelled") {
		const cancelledRows = (await sql`
      UPDATE runs
      SET status = 'cancelled',
          completed_at = current_timestamp,
          error_message = NULL,
          output_tail = ${output ? output.slice(-2000) : null},
          exit_code = ${body.exit_code ?? null},
          exit_signal = ${body.exit_signal ?? null},
          exit_reason = 'cancelled'
      WHERE id = ${runId}
        ${runLeaseFence(sql, body.worker_id)}
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		if (cancelledRows.length === 0) {
			return c.json({ ok: true, status: run.status, idempotent: true });
		}
		await sql`
      UPDATE automations
      SET last_fired_at = NOW(), updated_at = NOW()
      WHERE id = ${automationId}
    `;
		return c.json({
			ok: true,
			status: "cancelled",
			reason_code: "device_daemon_shutdown",
			run_id: runId,
		});
	}

	// Clean exit + run already completed: the agent finished the job over MCP
	// (query_sdk → completeWindow) before the subprocess exited. Stamp
	// the device-side provenance the pipeline can't know — exit metadata and
	// the subprocess wall-clock — plus the cooldown bookkeeping. The
	// `exit_reason IS NULL` filter makes this first-report-only: a duplicate
	// exit report matches zero rows and acks without re-firing side effects.
	if (run.status === "completed") {
		const stamped = (await sql`
      UPDATE runs
      SET exit_code = ${body.exit_code ?? null},
          exit_signal = ${body.exit_signal ?? null},
          exit_reason = ${body.exit_reason ?? "ok"}
      WHERE id = ${runId}
        AND exit_reason IS NULL
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		if (stamped.length === 0) {
			return c.json({
				ok: true,
				status: "completed",
				run_id: runId,
				idempotent: true,
			});
		}
		const agentKind =
			typeof approved.agent_kind === "string" &&
			(approved.agent_kind as string).trim()
				? (approved.agent_kind as string).trim()
				: null;
		// The run's pinned agent_kind is trusted device provenance. An explicit
		// model passed by the agent still wins.
		await sql`
        UPDATE runs
        SET model_used = CASE
              WHEN model_used = 'external-client' OR model_used IS NULL
                THEN ${agentKind ? `device-cli:${agentKind}` : "device-cli"}
              ELSE model_used
            END,
            run_metadata = CASE
              -- jsonb_set is STRICT: a NULL new_value would null out the whole
              -- run_metadata. No duration from the device and none recorded →
              -- leave run_metadata untouched.
              WHEN COALESCE(
                ${durationMs}::bigint,
                (run_metadata->>'execution_time_ms')::bigint
              ) IS NULL THEN run_metadata
              ELSE jsonb_set(
                COALESCE(run_metadata, '{}'::jsonb),
                '{execution_time_ms}',
                to_jsonb(COALESCE(
                  ${durationMs}::bigint,
                  (run_metadata->>'execution_time_ms')::bigint
                ))
              )
            END
        WHERE id = ${runId}
      `;
		await sql`
      UPDATE automations
      SET last_fired_at = NOW(), updated_at = NOW()
      WHERE id = ${automationId}
    `;
		emitCompletionEvent("completed");
		return c.json({ ok: true, status: "completed", run_id: runId });
	}

	// Already failed/timed out (a concurrent report, the reconciler, or the
	// 2h sweep won): idempotent ack, no side effects.
	if (run.status !== "running") {
		return c.json({ ok: true, status: run.status, idempotent: true });
	}

	// Clean exit but the run is still `running`.
	// Event turns complete on agent reply — no completeWindow.
	if (approved.trigger_execution === "turn") {
		const agentKind =
			typeof approved.agent_kind === "string" &&
			(approved.agent_kind as string).trim()
				? (approved.agent_kind as string).trim()
				: null;
		const completedRows = await finalizeRun(sql, {
			runId,
			workerId: body.worker_id,
			status: "completed",
			extraSet: sql`,
        outcome = ${classifyRunOutcome({ status: "completed" })},
        error_message = NULL,
        model_used = COALESCE(
          NULLIF(model_used, 'external-client'),
          ${agentKind ? `device-cli:${agentKind}` : "device-cli"},
          model_used
        ),
        exit_code = ${body.exit_code ?? null},
        exit_signal = ${body.exit_signal ?? null},
        exit_reason = ${body.exit_reason ?? "ok"},
        output_tail = ${output ? output.slice(-2000) : null},
        run_metadata = CASE
          WHEN ${durationMs}::bigint IS NULL THEN COALESCE(run_metadata, '{}'::jsonb)
          ELSE jsonb_set(
            COALESCE(run_metadata, '{}'::jsonb),
            '{execution_time_ms}',
            to_jsonb(${durationMs}::bigint)
          )
        END`,
		});
		if (completedRows.length === 0) {
			const finalRows = (await sql`
        SELECT status FROM runs WHERE id = ${runId} LIMIT 1
      `) as unknown as Array<{ status: string }>;
			return c.json({
				ok: true,
				status: finalRows[0]?.status ?? "failed",
				idempotent: true,
			});
		}
		await sql`
      UPDATE automations
      SET last_fired_at = NOW(), updated_at = NOW()
      WHERE id = ${automationId}
    `;
		emitCompletionEvent("completed");
		return c.json({
			ok: true,
			status: "completed",
			reason_code: "event_turn",
			run_id: runId,
		});
	}

	// Window Automation: agent never called completeWindow. Bounded device-held
	// resume (same finalize_nudges budget as cloud) so the Mac can re-spawn.
	const automationRows = (await sql`
    SELECT execution_config
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `) as unknown as Array<{
		execution_config: Record<string, unknown> | null;
	}>;
	const budget = resolveFinalizeNudgeBudget(
		automationRows[0]?.execution_config ?? null
	);
	const nudgeCount = Number(approved.finalize_nudge_count ?? 0);
	const attemptsSoFar = Number.isFinite(nudgeCount) ? nudgeCount : 0;

	// Replay guard. `finalize_attempt` is the finalize_nudge_count the reporting
	// spawn ran under (0 = first spawn, N = the spawn a resume #N granted). When
	// the stored count is already past it, this exact exit report was answered
	// with a resume the device never saw — its POST committed and the response
	// was lost. That is an ambiguous delivery outcome, not a fresh attempt, so
	// re-serve the same grant. Consuming another attempt here would fail the run
	// one spawn early, reinterpreting a lost response as work that happened.
	//
	// A device that omits the field (a build older than this endpoint's resume
	// contract) reads as "reporting the attempt the server has", i.e. the
	// pre-existing semantics — the field is what makes a retry safe, so the Mac
	// retry loop and this guard ship together.
	const reportedAttempt =
		typeof body.finalize_attempt === "number" &&
		Number.isFinite(body.finalize_attempt)
			? Math.max(0, Math.trunc(body.finalize_attempt))
			: attemptsSoFar;
	if (reportedAttempt < attemptsSoFar) {
		logger.info(
			{ run_id: runId, reported: reportedAttempt, granted: attemptsSoFar },
			"[completeAutomationRun] replayed exit report — re-serving the granted resume"
		);
		return c.json({
			ok: true,
			status: "resume",
			reason_code: "missing_complete_window",
			attempt: attemptsSoFar,
			max_attempts: budget,
			nudge: MISSING_COMPLETE_WINDOW_NUDGE,
			error: MISSING_COMPLETE_WINDOW_NUDGE,
			idempotent: true,
		});
	}

	// attemptsSoFar is how many resumes already granted; next spawn is attempt+1.
	// Budget N means N extra spawns after the first (same as cloud).
	if (attemptsSoFar < budget) {
		const nextAttempt = attemptsSoFar + 1;
		const bumped = await bumpDeviceFinalizeNudge(
			sql,
			runId,
			body.worker_id,
			nextAttempt,
			output ? output.slice(-2000) : null
		);
		if (!bumped) {
			const finalRows = (await sql`
        SELECT status,
               claimed_by,
               approved_input->>'finalize_nudge_count' AS finalize_nudge_count
        FROM runs
        WHERE id = ${runId}
        LIMIT 1
      `) as unknown as Array<{
				status: string;
				claimed_by: string | null;
				finalize_nudge_count: string | null;
			}>;
			const final = finalRows[0];
			const grantedAttempt = Number(final?.finalize_nudge_count);
			// The CAS can lose to an identical concurrent report after both
			// requests read the same count. Reconcile that committed grant into
			// the same replayable response; returning plain `running` would make
			// the device stop without ever receiving its nudge.
			if (
				final?.status === "running" &&
				final.claimed_by === body.worker_id &&
				Number.isFinite(grantedAttempt) &&
				grantedAttempt > attemptsSoFar
			) {
				return c.json({
					ok: true,
					status: "resume",
					reason_code: "missing_complete_window",
					attempt: grantedAttempt,
					max_attempts: budget,
					nudge: MISSING_COMPLETE_WINDOW_NUDGE,
					error: MISSING_COMPLETE_WINDOW_NUDGE,
					idempotent: true,
				});
			}
			return c.json({
				ok: true,
				status: final?.status ?? "failed",
				idempotent: true,
			});
		}
		logger.info(
			{ run_id: runId, attempt: nextAttempt, max: budget },
			"[completeAutomationRun] missing completeWindow — device resume"
		);
		return c.json({
			ok: true,
			status: "resume",
			reason_code: "missing_complete_window",
			attempt: nextAttempt,
			max_attempts: budget,
			// Total spawns allowed = first + budget resumes.
			// attempt is the resume index (1..budget); Mac should re-spawn now
			// and report back with finalize_attempt = attempt.
			nudge: MISSING_COMPLETE_WINDOW_NUDGE,
			error: MISSING_COMPLETE_WINDOW_NUDGE,
		});
	}

	const reason =
		"Device CLI exited without calling completeWindow " +
		(budget > 0
			? `after ${budget + 1} attempt(s)`
			: "(finalize nudges disabled)") +
		". Use the lobu skill + `lobu memory exec` (knowledge.read → completeWindow) " +
		"or MCP query_sdk/run_sdk. Check lobu CLI login/org, gateway reachability, " +
		"and that the device token has mcp:write if using MCP.";
	const transitioned = await failRun(reason);
	if (!transitioned) {
		const finalRows = (await sql`
      SELECT status FROM runs WHERE id = ${runId} LIMIT 1
    `) as unknown as Array<{ status: string }>;
		return c.json({
			ok: true,
			status: finalRows[0]?.status ?? "failed",
			idempotent: true,
		});
	}
	emitCompletionEvent("failed", reason);
	return c.json({
		ok: true,
		status: "failed",
		reason_code: "missing_complete_window",
		attempt: attemptsSoFar,
		max_attempts: budget,
		error: reason,
	});
}

/**
 * POST /api/workers/fetch-events
 *
 * Worker fetches event content for embedding generation.
 * Returns event IDs and payload_text for the given IDs.
 */
export async function fetchEventsForEmbedding(c: Context<{ Bindings: Env }>) {
	try {
		const { event_ids } = await c.req.json<{ event_ids: number[] }>();

		if (!event_ids || event_ids.length === 0) {
			return c.json({ events: [] });
		}

		const sql = getDb();

		// Build safe IN clause
		const safeIds = event_ids.filter((id) => Number.isInteger(id) && id > 0);
		if (safeIds.length === 0) {
			return c.json({ events: [] });
		}

		// Return events that need (re)embedding under the configured model. The
		// shared predicate (NOT EXISTS anti-joins on event_embeddings) is identical
		// to the backfill discovery rule and, being multi-vector aware, also catches
		// long events that only have a chunk-0 vector. A correlated anti-join (not a
		// LEFT JOIN) also avoids fanning out one row per chunk now that an event can
		// have many embedding rows.
		const placeholders = safeIds.map((_, i) => `$${i + 1}`).join(",");
		const rows = await sql.unsafe(
			`SELECT e.id, e.payload_text, e.title
       FROM events e
       WHERE e.id IN (${placeholders})
         AND ${needsEmbeddingSql("e", getConfiguredEmbeddingModel())}`,
			safeIds
		);

		return c.json({
			events: rows.map((r) => ({
				id: Number(r.id),
				content: (r.payload_text as string) ?? "",
				title: (r.title as string) ?? null,
			})),
		});
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/complete-embeddings
 *
 * Worker submits generated embeddings for a batch of events.
 * Used by embed_backfill runs.
 */
export async function completeEmbeddings(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteEmbeddingsRequest>();

		// Ownership gate — a worker can only finalize runs it claimed. Mirrors the
		// other /complete handlers; without it a leaked worker token could mark
		// arbitrary runs terminal.
		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();

		if (!req.embeddings || req.embeddings.length === 0) {
			if (req.error_message) {
				// Guarded terminal transition (the status='running' AND claimed_by guard
				// inside finalizeRun won't resurrect a reaped run). Ownership is already
				// enforced by authorizeRunForWorker above. The message is worker-
				// reported text, so strip NUL first (see streamContent).
				req.error_message = stripNul(req.error_message);
				await finalizeRun(sql, {
					runId: req.run_id,
					workerId: req.worker_id,
					status: "failed",
					extraSet: sql`,
              error_message = ${req.error_message}`,
				});
				return c.json({ success: false, error: req.error_message }, 400);
			}
			// Empty batch means all events already had embeddings — mark completed
			// (best-effort; the guard makes it a no-op on an already-finalized run).
			await finalizeRun(sql, {
				runId: req.run_id,
				workerId: req.worker_id,
				status: "completed",
			});
			return c.json({ success: true, updated: 0 });
		}

		// Durability first, THEN finalize the run. Each (event, model)'s chunk set is
		// replaced in its OWN transaction (delete that model's rows, then insert):
		// per-(event, model) isolation so one bad write can't drop another's and so
		// old/new models can coexist during a zero-downtime swap. chunk_index
		// defaults to 0 for an older worker mid-deploy.
		const byEventModel = new Map<string, typeof req.embeddings>();
		for (const item of req.embeddings) {
			if (!item.embedding_model) continue; // unstamped vectors are unusable (search scopes by model)
			const key = `${item.event_id}\0${item.embedding_model}`;
			const group = byEventModel.get(key);
			if (group) group.push(item);
			else byEventModel.set(key, [item]);
		}
		let updated = 0;
		let failed = 0;
		for (const [, items] of byEventModel) {
			const eventId = items[0]!.event_id;
			const model = items[0]!.embedding_model!;
			try {
				await sql.begin(async (tx) => {
					// Serialize with insertEvent's supersede UPDATE before replacing the
					// vectors. FOR SHARE lets different model writers coexist, but makes a
					// concurrent superseder wait and delete anything written here after it
					// acquires the row.
					const liveEvent = await tx`
						SELECT id
						FROM events
						WHERE id = ${eventId}
						  AND superseded_by IS NULL
						FOR SHARE
					`;
					await tx`DELETE FROM event_embeddings WHERE event_id = ${eventId} AND embedding_model = ${model}`;
					// Superseded between backfill selection and now: the delete above is the
					// whole job. It counts toward `updated`, not `failed` — the event is
					// finished work (discovery already skips superseded rows), so failing
					// the run over it would re-queue a healthy backfill.
					if (liveEvent.length === 0) return;
					for (const item of items) {
						const vectorStr = `[${item.embedding.join(",")}]`;
						await tx.unsafe(
							`INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
               VALUES ($1, $2, $3::vector, $4)`,
							[eventId, item.chunk_index ?? 0, vectorStr, model]
						);
					}
				});
				updated++;
			} catch (err) {
				failed++;
				logger.error(
					{ event_id: eventId, model, error: err },
					"[completeEmbeddings] Failed to write embeddings for event (stays stale, will re-queue)"
				);
			}
		}

		// Finalize AFTER the writes, and only as completed if nothing failed — a
		// failed write must not be hidden behind a "completed" run; mark the run
		// failed so the events get re-queued and the failure is visible. Headless
		// backfills (run_id=-1) make finalizeRun a harmless no-op either way.
		await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: failed > 0 ? "failed" : "completed",
			...(failed > 0
				? {
						extraSet: sql`,
              error_message = ${`${failed}/${byEventModel.size} event embedding writes failed`}`,
					}
				: {}),
		});

		await sql`
      UPDATE runs
      SET items_collected = ${updated}
      WHERE id = ${req.run_id}
        ${runOwnerFence(sql, req.worker_id)}
    `;

		logger.info(
			{ run_id: req.run_id, total: req.embeddings.length, updated, failed },
			"Embedding backfill completed"
		);

		return c.json({ success: failed === 0, updated, failed });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeEmbeddings] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/emit-auth-artifact
 *
 * Worker streams an auth artifact (QR, redirect URL, prompt) into the run
 * checkpoint so the UI can render it.
 */
export async function emitAuthArtifact(c: Context<{ Bindings: Env }>) {
	try {
		const { run_id, artifact } = await c.req.json<EmitAuthArtifactRequest>();

		const sql = getDb();

		await sql`
      UPDATE runs
      SET checkpoint = ${sql.json({ artifact, emitted_at: new Date().toISOString() })},
          last_heartbeat_at = current_timestamp
      WHERE id = ${run_id}
    `;

		return c.json({ success: true });
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/poll-auth-signal
 *
 * Worker polls for a pending signal on an auth run. The signal is consumed
 * (cleared from the run row) when delivered.
 */
export async function pollAuthSignal(c: Context<{ Bindings: Env }>) {
	try {
		const { run_id, signal_name } = await c.req.json<PollAuthSignalRequest>();

		const sql = getDb();

		const consumed = await sql.begin(async (tx) => {
			const rows = (await tx`
        SELECT auth_signal FROM runs
        WHERE id = ${run_id}
        FOR UPDATE
      `) as Array<{ auth_signal: Record<string, unknown> | null }>;

			const current = rows[0]?.auth_signal ?? null;
			if (!current) return null;
			if (current.name !== signal_name) return null;

			await tx`UPDATE runs SET auth_signal = NULL WHERE id = ${run_id}`;
			return current.payload ?? {};
		});

		return c.json(consumed ? { signal: consumed } : {});
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/complete-auth
 *
 * Worker signals auth run completion. On success, credentials + metadata are
 * written to the linked auth_profiles row and the profile moves to 'active'.
 */
export async function completeAuthRun(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteAuthRequest>();

		// Strip NUL (0x00) from the worker-reported exit diagnostics before they
		// hit Postgres (see streamContent): output_tail is the raw subprocess
		// stdout tail and error_message its failure text.
		if (req.error_message) req.error_message = stripNul(req.error_message);
		if (req.output_tail) req.output_tail = stripNul(req.output_tail);

		// Ownership gate — a worker can only finalize runs it claimed. Mirrors the
		// other /complete handlers. Without it a leaked worker token could finalize
		// an arbitrary auth run and inject credentials into the linked auth_profiles
		// row. authorizeRunForWorker waves through token-auth (non-'user') mode, so
		// the claimant/status guard inside finalizeRun is what protects that path.
		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();
		const isBrowserAuth = await runUsesBrowserConnector(sql, req.run_id);
		if (isBrowserAuth) {
			req.error_message = sanitizeBrowserText(req.error_message) ?? undefined;
			req.output_tail = sanitizeBrowserText(req.output_tail) ?? undefined;
		}

		// Atomic terminal transition with the shared F2 guard (see finalizeRun), so
		// a late/reaped completion is a no-op rather than resurrecting the run and
		// double-applying the auth_profile/connection/feed side effects below. The
		// failed path also clears auth_signal and stamps exit diagnostics.
		const runRows = (await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: req.status === "failed" ? "failed" : "completed",
			extraSet:
				req.status === "failed"
					? sql`,
          error_message = ${req.error_message ?? null},
          auth_signal = NULL,
          output_tail = ${req.output_tail ?? null},
          exit_code = ${req.exit_code ?? null},
          exit_signal = ${req.exit_signal ?? null},
          exit_reason = ${req.exit_reason ?? null}`
					: sql`,
          error_message = ${req.error_message ?? null},
          auth_signal = NULL`,
			returning: sql`auth_profile_id, organization_id`,
		})) as unknown as Array<{
			auth_profile_id: number | null;
			organization_id: string;
		}>;

		if (runRows.length === 0) {
			// Already finalized (timeout race) or not the claimant. Skip all
			// auth_profile/connection/feed side effects and ack idempotently.
			logger.info(
				{
					run_id: req.run_id,
					worker_id: req.worker_id,
					claimed_status: req.status,
				},
				"[completeAuthRun] no-op: run already in terminal state (likely gateway timeout)"
			);
			return c.json({ success: false, reason: "already_finalized" });
		}

		const authProfileId = runRows[0]?.auth_profile_id ?? null;
		const organizationId = runRows[0]?.organization_id;

		if (
			req.status === "success" &&
			authProfileId &&
			req.credentials &&
			organizationId
		) {
			// The profile kind decides whether the returned credentials are
			// secret-ref'd (bearer kinds) or written through as session state
			// (browser_session / interactive) — see reactivateProfileCascade.
			const authProfile = await getAuthProfileById(
				organizationId,
				authProfileId
			);
			await reactivateProfileCascade(
				sql,
				authProfileId,
				organizationId,
				authProfile?.profile_kind ?? null,
				{
					credentials: req.credentials,
					metadata: req.metadata ?? {},
				}
			);

			if (organizationId) {
				emit(organizationId, { keys: ["connections", "auth-profiles"] });
			}
		} else if (req.status === "failed" && authProfileId) {
			await sql`
        UPDATE auth_profiles
        SET status = 'error',
            updated_at = current_timestamp
        WHERE id = ${authProfileId}
      `;
		}

		logger.info(
			{ run_id: req.run_id, status: req.status },
			"Auth run completed"
		);
		return c.json({ success: true });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeAuthRun] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/complete-action
 *
 * Worker signals action run completion (for async high-risk actions).
 */
export async function completeActionRun(c: Context<{ Bindings: Env }>) {
	let publishedActionArtifactIds: string[] = [];
	try {
		const req = await c.req.json<CompleteActionRequest>();

		// Strip NUL (0x00) from worker-reported output before it reaches Postgres
		// (see streamContent). An action's output and error text carry raw
		// subprocess bytes, so both the jsonb action_output and the text
		// error_message can arrive with a NUL an OS shell emitted.
		if (req.action_output) {
			req.action_output = stripNulDeep(req.action_output) as Record<
				string,
				unknown
			>;
		}
		if (req.error_message) req.error_message = stripNul(req.error_message);

		// Same ownership check as the other /complete endpoints — a worker
		// can only finalize runs it claimed. Without this, a leaked worker
		// token could overwrite action_output on arbitrary runs.
		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();
		const isBrowserAction = await runUsesBrowserConnector(sql, req.run_id);
		if (isBrowserAction) {
			req.action_output = sanitizeBrowserActionOutput(req.action_output);
			req.error_message = sanitizeBrowserText(req.error_message) ?? undefined;
		}
		const materializedActionOutput = req.action_output
			? await materializeActionOutputAttachments(req.run_id, req.action_output)
			: undefined;
		const actionOutput = materializedActionOutput?.output;
		publishedActionArtifactIds =
			materializedActionOutput?.publishedArtifactIds ?? [];

		// Atomic terminal-state transition with the shared F2 guard (see
		// finalizeRun) AND, for approval-gated runs, the card supersede in ONE
		// transaction, so a card INSERT failure rolls the run terminal state
		// back instead of leaving a terminal run whose timeline is stuck at the
		// prior card. Auto/no-approval runs (`approval_status='auto'`) have no
		// card and finalize normally — no supersede is attempted. A no-op (0
		// rows) means the row was already finalized by another path (e.g.
		// waitForDeviceActionRun timed out and marked it 'timeout'). Without it a
		// slow worker could overwrite a gateway-side timeout decision with
		// success — and the caller has already returned timeout to its caller, so
		// the action would double-finalize.
		const updatedRuns = await sql.begin(async (tx) => {
			const rows = await finalizeRun(tx, {
				runId: req.run_id,
				workerId: req.worker_id,
				status: req.status === "success" ? "completed" : "failed",
				extraSet: tx`,
					action_output = ${actionOutput ? tx.json(actionOutput) : null},
					error_message = ${req.error_message ?? null}`,
				returning: tx`organization_id, action_key, approval_status`,
			});
			if (rows.length === 0) return rows;

			const organizationId = (rows[0] as any)?.organization_id;
			const actionKey = (rows[0] as any)?.action_key ?? "Action";
			if (organizationId && (rows[0] as any)?.approval_status === "approved") {
				const newStatus = req.status === "success" ? "completed" : "failed";
				const eventId = await supersedeActionEvent(
					req.run_id,
					organizationId,
					newStatus,
					`${actionKey} — ${newStatus}`,
					req.status === "success"
						? `Action completed: ${actionKey}`
						: `Action failed: ${actionKey}${req.error_message ? ` — ${req.error_message}` : ""}`,
					req.status === "success"
						? { action_output: actionOutput }
						: { error_message: req.error_message },
					null,
					tx
				);
				if (eventId === undefined) {
					throw new Error(
						`Cannot finalize approval run ${req.run_id} as '${newStatus}': its approval card is missing`
					);
				}
			}
			return rows;
		});
		if (updatedRuns.length === 0) {
			await deleteMaterializedArtifacts(publishedActionArtifactIds);
			// Either the run was already finalized (timeout race) or the
			// worker isn't the claimant. authorizeRunForWorker already gated
			// ownership, so this is almost always the timeout race; return
			// a clear status so the worker's logs are informative.
			logger.info(
				{
					run_id: req.run_id,
					worker_id: req.worker_id,
					claimed_status: req.status,
				},
				"[completeActionRun] no-op: run already in terminal state (likely gateway timeout)"
			);
			return c.json({ success: false, reason: "already_finalized" });
		}

		// The transaction committed; from here these artifacts are durable run output.
		publishedActionArtifactIds = [];
		const organizationId = (updatedRuns[0] as any)?.organization_id;

		if (organizationId) {
			emit(organizationId, { keys: ["contents-filtered", "notifications"] });
		}

		logger.info(
			{ run_id: req.run_id, status: req.status },
			"Action run completed"
		);
		return c.json({ success: true });
	} catch (err: unknown) {
		await deleteMaterializedArtifacts(publishedActionArtifactIds);
		logger.error({ error: errorMessage(err) }, "[completeActionRun] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}
