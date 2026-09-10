import { getErrorMessage } from "@lobu/core";
import { getDb } from "../db/client";
import { fetchCredentialedPublicUrl } from "@lobu/connector-worker/egress";
import { LOST_LEASE_MESSAGE, runLeaseFence } from "../runs/run-lease";
import { resolveCredentialsByConnectionId } from "../mcp-proxy/credential-resolver";
import { readResponseTextWithLimit } from "../utils/bounded-response";
import { stripNul, stripNulDeep } from "../utils/strip-nul";
import type { OperationDescriptor } from "./types";

const DEFAULT_HTTP_OPERATION_FETCH_TIMEOUT_MS = 120_000;
const MAX_HTTP_OPERATION_RESPONSE_BYTES = 4 * 1024 * 1024;

export type HttpOperationExecutionResult =
	| {
			status: "completed";
			output: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	| { status: "failed"; error_message: string; output?: Record<string, unknown> };

export interface HttpOperationConnection {
	id: number;
	connector_key: string;
}

function buildResolvedUrl(
	serverUrl: string,
	pathTemplate: string,
	input: Record<string, unknown>,
): URL {
	const pathValues =
		input.path && typeof input.path === "object"
			? (input.path as Record<string, unknown>)
			: {};
	const queryValues =
		input.query && typeof input.query === "object"
			? (input.query as Record<string, unknown>)
			: {};
	let path = pathTemplate;
	for (const [key, value] of Object.entries(pathValues)) {
		path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
	}

	const url = new URL(
		path,
		serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`,
	);
	for (const [key, value] of Object.entries(queryValues)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) url.searchParams.append(key, String(item));
		} else {
			url.searchParams.set(key, String(value));
		}
	}
	return url;
}

function pickInterestingHeaders(
	headers: Headers,
): Record<string, unknown> | undefined {
	const interestingHeaders = [
		"content-type",
		"x-ratelimit-remaining",
		"x-ratelimit-reset",
		"link",
	];
	const values = Object.fromEntries(
		interestingHeaders
			.map((header) => [header, headers.get(header)])
			.filter(([, value]) => value !== null),
	);
	return Object.keys(values).length > 0 ? values : undefined;
}

async function failRun(
	runId: number,
	organizationId: string,
	errorMessage: string,
	deferTerminalWrite: boolean,
	claimedBy: string,
): Promise<HttpOperationExecutionResult> {
	// Upstream response text reaches here through getErrorMessage, so the
	// message can carry NUL (0x00) that Postgres rejects (see streamContent).
	const message = stripNul(errorMessage);
	if (!deferTerminalWrite) {
		// Same lease fence as the completed/failed lanes below: a config refusal
		// or a thrown request still terminalizes the run, and must not overwrite
		// an outcome the reaper or a re-claim already recorded.
		const sql = getDb();
		const rows = await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${message} WHERE id = ${runId} AND organization_id = ${organizationId} ${runLeaseFence(sql, claimedBy)} RETURNING id`;
		if (rows.length === 0)
			return { status: "failed", error_message: LOST_LEASE_MESSAGE };
	}
	return { status: "failed", error_message: message };
}

function requestAbortSignal(parent?: AbortSignal): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const configuredTimeout = Number(
		process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS ??
			DEFAULT_HTTP_OPERATION_FETCH_TIMEOUT_MS,
	);
	const timeoutMs =
		Number.isFinite(configuredTimeout) && configuredTimeout > 0
			? configuredTimeout
			: DEFAULT_HTTP_OPERATION_FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const relayParentAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) {
		relayParentAbort();
	} else {
		parent?.addEventListener("abort", relayParentAbort, { once: true });
	}
	const timeout = setTimeout(
		() =>
			controller.abort(
				new Error(`HTTP operation timed out after ${timeoutMs}ms`),
			),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", relayParentAbort);
		},
	};
}

async function readHttpOperationResponse(response: Response): Promise<string> {
	return stripNul(
		await readResponseTextWithLimit(
			response,
			MAX_HTTP_OPERATION_RESPONSE_BYTES,
			"HTTP operation response too large",
		),
	);
}

function fetchAuthenticatedHttpOperation(
	url: string | URL,
	init: RequestInit,
): Promise<Response> {
	return fetchCredentialedPublicUrl(url, init);
}

export const __httpOperationTestOnly = {
	fetchAuthenticatedHttpOperation,
	MAX_HTTP_OPERATION_RESPONSE_BYTES,
	readHttpOperationResponse,
	requestAbortSignal,
};

/** Execute one OpenAPI-derived HTTP operation and finalize its run row. */
export async function executeHttpOperation(
	runId: number,
	organizationId: string,
	connection: HttpOperationConnection,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	abortSignal: AbortSignal | undefined,
	deferTerminalWrite: boolean,
	claimedBy: string,
): Promise<HttpOperationExecutionResult> {
	const sql = getDb();
	if (operation.backend_config.backend !== "http_operation") {
		return failRun(
			runId,
			organizationId,
			"Invalid HTTP operation backend config",
			deferTerminalWrite,
			claimedBy,
		);
	}

	try {
		const credentials = await resolveCredentialsByConnectionId(
			connection.id,
			organizationId,
		);
		if (!credentials) {
			return failRun(
				runId,
				organizationId,
				`No active OAuth credentials found for '${connection.connector_key}'.`,
				deferTerminalWrite,
				claimedBy,
			);
		}

		const headersInput =
			actionInput.headers && typeof actionInput.headers === "object"
				? (actionInput.headers as Record<string, unknown>)
				: {};
		const headers = new Headers();
		for (const [key, value] of Object.entries(headersInput)) {
			if (
				/^(authorization|host)$/i.test(key) ||
				value === undefined ||
				value === null
			) {
				continue;
			}
			headers.set(key, String(value));
		}
		headers.set(
			"Authorization",
			`${credentials.tokenType} ${credentials.accessToken}`,
		);

		const body = actionInput.body;
		let requestBody: string | undefined;
		if (body !== undefined) {
			requestBody = typeof body === "string" ? body : JSON.stringify(body);
			if (
				!headers.has("content-type") &&
				typeof body === "object" &&
				body !== null
			) {
				headers.set("content-type", "application/json");
			}
		}

		const url = buildResolvedUrl(
			operation.backend_config.serverUrl,
			operation.backend_config.pathTemplate,
			actionInput,
		);

		const requestAbort = requestAbortSignal(abortSignal);
		let response: Response;
		let text: string;
		try {
			response = await fetchAuthenticatedHttpOperation(url, {
				method: operation.backend_config.method,
				headers,
				body: ["GET", "HEAD"].includes(operation.backend_config.method)
					? undefined
					: requestBody,
				redirect: "manual",
				signal: requestAbort.signal,
			});
			text = await readHttpOperationResponse(response);
		} finally {
			requestAbort.cleanup();
		}

		let parsedBody: unknown = text;
		try {
			parsedBody = text ? JSON.parse(text) : null;
		} catch {
			// Keep non-JSON responses as text.
		}
		parsedBody = stripNulDeep(parsedBody);
		const output = { body: parsedBody } as Record<string, unknown>;
		const metadata: Record<string, unknown> = {
			http_status: response.status,
		};
		const headerMetadata = pickInterestingHeaders(response.headers);
		if (headerMetadata) {
			metadata.response_headers = headerMetadata;
			const rateLimits = Object.fromEntries(
				Object.entries(headerMetadata).filter(([key]) =>
					key.startsWith("x-ratelimit"),
				),
			);
			if (Object.keys(rateLimits).length > 0) metadata.rate_limits = rateLimits;
			if (headerMetadata.link) {
				metadata.pagination = { link: headerMetadata.link };
			}
		}

		if (!response.ok) {
			const errorText =
				typeof parsedBody === "string" ? parsedBody : `HTTP ${response.status}`;
			if (!deferTerminalWrite) {
				const updated = await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), action_output = ${sql.json(output)}, error_message = ${errorText} WHERE id = ${runId} AND organization_id = ${organizationId} ${runLeaseFence(sql, claimedBy)} RETURNING id`;
				if (updated.length === 0)
					return { status: "failed", error_message: LOST_LEASE_MESSAGE };
			}
			return { status: "failed", error_message: errorText, output };
		}

		if (!deferTerminalWrite) {
			const updated = await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId} ${runLeaseFence(sql, claimedBy)} RETURNING id`;
			if (updated.length === 0)
				return { status: "failed", error_message: LOST_LEASE_MESSAGE };
		}
		return { status: "completed", output, metadata };
	} catch (error) {
		return failRun(
			runId,
			organizationId,
			getErrorMessage(error),
			deferTerminalWrite,
			claimedBy,
		);
	}
}
