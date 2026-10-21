import { retryWithBackoff } from "@lobu/core";
import type { ActingPrincipal } from "../authz/entity-policy";
import type { EntityWriteOperation } from "../authz/entity-row-validation";
import type { DbClient } from "../db/client";
import { currentMcpActivityEventMetadata } from "../lobu/stores/mcp-client-conversations";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "./errors";
import { insertConnectionlessAuditEvent } from "./insert-event";
import logger from "./logger";
import { isUniqueViolation } from "./pg-errors";
import { stripNul } from "./strip-nul";
import { eventClientId } from "../auth/event-client-id";

export interface EntityWriteDenialDescription {
	denialSource: "policy" | "rule";
	operation: EntityWriteOperation;
	reason: string;
	deniedFields: string[];
	entityId: number | null;
	entityType: string | null;
	entityOrganizationId: string | null;
}

export interface EntityWriteDenialAudit extends EntityWriteDenialDescription {
	organizationId: string;
	ctx?: ToolContext;
	attemptId: string;
	actor: Pick<ActingPrincipal, "kind" | "id">;
	automationId: number | null;
	runId?: number | null;
	createdBy?: string | null;
	clientId?: string | null;
	/** A healthy caller-owned transaction, never the transaction that rejected. */
	sql?: DbClient;
}

/** Explicitly marks a policy refusal that originated inside a transaction. */
export class EntityPolicyDenialError extends ToolUserError {
	readonly denial: EntityWriteDenialDescription;

	constructor(denial: Omit<EntityWriteDenialDescription, "denialSource">) {
		super(denial.reason, 403);
		this.name = "EntityPolicyDenialError";
		this.denial = { ...denial, denialSource: "policy" };
	}
}

const LOAD_BEARING_AUDIT_RETRY = {
	maxRetries: 1,
	baseDelay: 500,
} as const;

const AUDIT_IDEMPOTENCY_INDEX = "idx_events_org_idempotency_key";

/**
 * Persist one privacy-safe, append-only entity-write denial.
 *
 * Pool writes retry once and reconcile through the existing event idempotency
 * key. Caller-owned transaction writes use a savepoint so a concurrent replay
 * cannot poison the surrounding completion transaction. Automation rows and
 * approvals supply durable attempt ids; manage_entity supplies one UUID per
 * invocation because its transport exposes no stable cross-delivery id.
 */
export async function recordEntityWriteDenial(
	params: EntityWriteDenialAudit,
): Promise<void> {
	const {
		organizationId,
		ctx,
		attemptId,
		denialSource,
		operation,
		reason,
		deniedFields,
		entityId,
		entityType,
		entityOrganizationId,
		actor,
		automationId,
		sql,
	} = params;
	const runId = params.runId ?? ctx?.actingRunId ?? null;
	const createdBy = params.createdBy ?? ctx?.userId ?? null;
	const clientId = params.clientId ?? (ctx ? eventClientId(ctx) : null);
	const sameOrgEntityIds =
		entityId !== null && entityOrganizationId === organizationId
			? [entityId]
			: [];
	const originId = `entity_write_denial:v1:${attemptId}:${operation}`;
	// insertEvent strips NUL from originId before deriving the persisted key, so
	// strip here too or the reconciliation SELECT below looks up a key that was
	// never stored.
	const idempotencyKey = `audit:${stripNul(originId)}`;
	const event = {
		entityIds: sameOrgEntityIds,
		organizationId,
		originId,
		title: `Entity ${operation} denied by ${denialSource}`,
		payloadType: "empty" as const,
		semanticType: "change" as const,
		originType: "entity_write_denial",
		metadata: {
			category: "entity_write_denial",
			denial_source: denialSource,
			operation,
			reason,
			denied_fields: deniedFields,
			entity_id: entityId,
			entity_type: entityType,
			principal_kind: actor.kind,
			principal_id: actor.id,
			automation_id: automationId,
			run_id: runId,
			tool_call_id_or_equivalent: attemptId,
			...(ctx ? currentMcpActivityEventMetadata(ctx) : {}),
		},
		createdBy,
		clientId,
		automationId,
		runId,
	};

	const insertOnPool = () =>
		insertConnectionlessAuditEvent(
			event,
			{ subject: "entity", op: "denied" },
			{ lockAndPruneEntityRefs: true },
		);
	// `metadata ? '_lobu_idempotency_key'` restates the partial index's own
	// predicate. Postgres cannot derive it from the `->>` equality, so without it
	// the planner falls back to `idx_events_organization_id` and filters — a scan
	// of the org's whole event history on every denial. With it, the lookup is a
	// single probe of `idx_events_org_idempotency_key`.
	const findExisting = (db: DbClient) => db<{ id: number }>`
		SELECT id FROM events
		WHERE organization_id = ${organizationId}
		  AND metadata ? '_lobu_idempotency_key'
		  AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
		LIMIT 1
	`;
	const insertOnTransaction = async (tx: DbClient): Promise<void> => {
		if ((await findExisting(tx)).length > 0) return;
		try {
			await tx.savepoint((sp) =>
				insertConnectionlessAuditEvent(
					event,
					{ subject: "entity", op: "denied" },
					{ sql: sp, lockAndPruneEntityRefs: true },
				),
			);
		} catch (error) {
			if (
				!isUniqueViolation(error, AUDIT_IDEMPOTENCY_INDEX) ||
				(await findExisting(tx)).length === 0
			) {
				throw error;
			}
		}
	};

	try {
		if (sql) {
			await insertOnTransaction(sql);
		} else {
			await retryWithBackoff(insertOnPool, LOAD_BEARING_AUDIT_RETRY);
		}
	} catch (err) {
		logger.error(
			{
				err,
				organizationId,
				attemptId,
				operation,
				denialSource,
				reason,
				entityId,
				entityType,
				principalKind: actor.kind,
				principalId: actor.id,
				automationId,
				runId,
			},
			"[entity-write-denial] load-bearing denial audit failed; entity mutation remains blocked",
		);
		throw new Error(
			"Entity write was blocked, but its denial audit could not be persisted",
			{ cause: err },
		);
	}
}
