import { createHash } from "node:crypto";
import type { NotificationDelivery } from "@lobu/core/contracts/tools/manage-operations";

type Attempt = NotificationDelivery["targets"][number]["attempts"][number];

/** The existing event receipt, including destinations that have not posted yet. */
export interface DeliveryRecord {
	connectionId: string;
	channelKey?: string;
	conversationId?: string;
	platform?: string;
	messageId?: string;
	threadId?: string;
	attempts?: Attempt[];
	taskRunId?: number;
	taskAttempt?: number;
}

export interface DeliveryTaskContext {
	taskRunId: number;
	attempt: number;
}

export function storedDeliveryRecords(metadata: Record<string, unknown>): DeliveryRecord[] {
	return (Array.isArray(metadata.delivery) ? metadata.delivery : []).filter(
		(entry): entry is DeliveryRecord => entry != null && typeof entry.connectionId === "string",
	);
}

export function deliveryAttempt(
	eventId: number,
	target: { connectionId: string; channelKey?: string },
	attempt: number,
	status: Attempt["status"],
): Attempt {
	return {
		attempt,
		// One destination identity for all retries, independent of pod or queue claim.
		idempotency_key: createHash("sha256")
			.update(JSON.stringify([eventId, target.connectionId, target.channelKey]))
			.digest("hex"),
		status,
		observed_at: new Date().toISOString(),
		provider_timestamp: null,
		provider_message_id: null,
		error: null,
	};
}

export class NotificationDeliveryError extends Error {
	constructor(readonly code: string, message: string, readonly retryable = true) {
		super(message);
	}
}

/** Classify structure at the delivery boundary; never persist provider prose or responses. */
export function deliveryError(error: unknown): NonNullable<Attempt["error"]> {
	if (error instanceof NotificationDeliveryError) {
		return { code: error.code, retryable: error.retryable };
	}
	const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
	const status = value?.status ?? value?.statusCode ?? value?.response?.status;
	const code = value?.code;
	if (status === 429 || code === "RATE_LIMITED") return { code: "provider_rate_limited", retryable: true };
	if (status === 401 || code === "AUTH_FAILED") return { code: "provider_authentication", retryable: false };
	if (status === 403 || code === "PERMISSION_DENIED") return { code: "provider_permission", retryable: false };
	if (status === 404 || code === "NOT_FOUND") return { code: "provider_not_found", retryable: false };
	if (status === 408 || code === "NETWORK_ERROR") return { code: "provider_unavailable", retryable: true };
	if ((typeof status === "number" && status >= 500) || code === "ECONNRESET" || code === "ETIMEDOUT") {
		return { code: "provider_unavailable", retryable: true };
	}
	if ((typeof status === "number" && status >= 400 && status < 500) || code === "VALIDATION_ERROR") {
		return { code: "provider_rejected", retryable: false };
	}
	return { code: "delivery_unknown", retryable: true };
}

/** Bounded per-event projection; never scans task or event history on a read path. */
export function projectDelivery(
	eventId: number,
	automationId: number | null,
	runId: number | null,
	metadata: Record<string, unknown>,
): NotificationDelivery | undefined {
	const request = metadata.delivery_request as {
		strictAutomationTarget?: boolean;
		targets: DeliveryRecord[];
		ownerDm?: { connectionId: string; platform: string } | null;
	} | undefined;
	const records = storedDeliveryRecords(metadata);
	if (!request && records.length === 0) return undefined;
	const destinations = request?.ownerDm
		? [{ ...request.ownerDm, channelKey: "dm" }]
		: request?.targets ?? [];
	for (const target of destinations) {
		if (!records.some((record) => record.connectionId === target.connectionId && record.channelKey === target.channelKey)) {
			records.push(target);
		}
	}
	const statuses = records.map((record) => record.attempts?.at(-1)?.status ??
		(record.messageId ? "provider_accepted" : "queued"));
	const outcome = statuses.length === 0
		? request?.strictAutomationTarget ? "failed" : "no_target"
		: statuses.every((status) => status === statuses[0]) ? statuses[0]! : "partial";
	return {
		outcome,
		event_id: eventId,
		automation_id: automationId,
		run_id: runId,
		targets: records.map((record) => ({
			connection_id: record.connectionId,
			channel: record.channelKey ?? "",
			platform: record.platform ?? destinations.find((target) => target.connectionId === record.connectionId)?.platform ?? "",
			// Older message pointers have no observed timestamp/attempt history to invent.
			attempts: (record.attempts ?? []).map((attempt) => ({
				attempt: attempt.attempt,
				idempotency_key: attempt.idempotency_key,
				status: attempt.status,
				observed_at: attempt.observed_at,
				provider_timestamp: attempt.provider_timestamp,
				provider_message_id: attempt.provider_message_id,
				error: attempt.error ? { code: attempt.error.code, retryable: attempt.error.retryable } : null,
			})),
		})),
	};
}
