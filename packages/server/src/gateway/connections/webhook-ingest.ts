/**
 * Inbound webhook ingest for `platform: "webhook"` connections (#1235).
 *
 * A webhook connection is NOT a chat platform: there is no Chat SDK adapter,
 * no mention/DM handlers, no thread semantics. It is a push-source primitive —
 * any external system (Sentry, GitHub, Stripe, healthchecks) POSTs JSON to
 * `POST /api/v1/webhooks/:connectionId` and the payload is persisted as an
 * `events` row (`connector_key = 'webhook:<connectionId>'`). The durable insert
 * atomically queues matching `webhook / delivery.received` Automations through
 * the ordinary connector-event path; scheduled/manual Automations may also read
 * the rows later through checkpointed SQL sources.
 *
 * Request pipeline (persist BEFORE ack — a 202 issued before the insert
 * commits would lose the delivery on pod crash, and providers won't retry a
 * 2xx):
 *   1. body size cap (256 KB)                          → 413
 *   2. pre-auth rate limit per (connection, source IP) → 429
 *   3. token auth (constant-time)                      → 401
 *   4. authenticated per-connection budget (120/min)   → 429
 *   5. dedupe key: configured header value, else sha256(raw body)
 *   6. synchronous event insert                        → 202 {"ok":true,"id":<eventId>}
 *
 * Idempotency: `events.connection_id` is a bigint FK to the connector
 * `connections` row and `events.origin_id` is only
 * indexed, not unique — so redelivery dedupe rides the partial unique index
 * `events_webhook_ingest_dedupe` on `(organization_id, connector_key,
 * origin_id) WHERE connector_key LIKE 'webhook:%'` (see
 * db/migrations/20260612210000_webhook_ingest_dedupe.sql): pre-check first,
 * and treat a 23505 from a concurrent duplicate as success.
 *
 * Multi-replica: stateless by construction — every step reads the connection
 * row and writes Postgres; nothing is memoized per pod.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import type { StoredConnection } from "@lobu/core";
import {
	activateAutomationSignal,
	type AutomationActivationResult,
	dispatchAutomationRunsBestEffort,
} from "../../automations/activation.js";
import { type DbClient, getDb } from "../../db/client.js";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection.js";
import { constantTimeEqual } from "../../utils/constant-time-equal.js";
import { insertEvent } from "../../utils/insert-event.js";
import logger from "../../utils/logger.js";
import { getClientIP, getRateLimiter } from "../../utils/rate-limiter.js";
import { resolveSecretValue, type SecretStore } from "../secrets/index.js";
import type { WebhookIngestPlatformConfig } from "./types.js";

/** Raw-body cap. Oversized deliveries are rejected, so stored payloads stay bounded. */
export const WEBHOOK_INGEST_MAX_BODY_BYTES = 256 * 1024;

/**
 * Authenticated per-connection delivery budget (cluster-wide, fail-open like
 * every limiter use). Counted only AFTER token verification — otherwise an
 * attacker spamming bad tokens at a guessable connection id (apply-created
 * ids are deterministic) could exhaust the budget and 429 real deliveries.
 */
export const WEBHOOK_INGEST_RATE_LIMIT = {
	limit: 120,
	windowSeconds: 60,
	errorMessage:
		"Webhook rate limit exceeded. Maximum 120 deliveries per minute.",
};

/**
 * Pre-auth attempt budget per (connection, source IP). Bounds secret-store
 * reads and brute-force attempts without letting unauthenticated traffic
 * starve the authenticated budget above: a flooding source only exhausts its
 * own bucket. Roomier than the delivery budget so a legitimate sender behind
 * one egress IP (Sentry, GitHub) never trips it before the authenticated
 * limit applies.
 */
export const WEBHOOK_INGEST_PREAUTH_RATE_LIMIT = {
	limit: 240,
	windowSeconds: 60,
	errorMessage:
		"Too many webhook requests from this source. Try again shortly.",
};

/** Header-based alternative to `Authorization: Bearer` for senders that reserve it. */
const TOKEN_HEADER = "x-lobu-webhook-token";

type WebhookIngestConfig = WebhookIngestPlatformConfig;

/**
 * Auto-generate a strong bearer token when the caller didn't supply one, so
 * an ingest endpoint is never created unauthenticated — same posture as the
 * Telegram `secretToken` auto-generation. The field name matches
 * `isSecretField`, so persistence turns it into a `secret://` ref like any
 * other credential.
 */
export function prepareWebhookIngestConfig(
	config: Record<string, unknown>,
): void {
	if (typeof config.token !== "string" || config.token.length === 0) {
		config.token = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
	}
}

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Constant-time token equality. The presented/configured tokens vary in length,
 * which `constantTimeEqual` (and `timingSafeEqual`) can't compare directly — so
 * hash both to fixed-length sha256 hex digests first and compare THOSE. Equal
 * tokens hash equal; the length-revealing path can never fire on the digests.
 */
function tokensMatch(presented: string, configured: string): boolean {
	return constantTimeEqual(
		createHash("sha256").update(presented).digest("hex"),
		createHash("sha256").update(configured).digest("hex"),
	);
}

/**
 * Verify a provider's HMAC signature over the raw request body — the auth
 * scheme for connector-owned webhooks (GitHub `x-hub-signature-256`, Linear
 * `linear-signature`, Jira `x-hub-signature`). The provider signs the exact
 * bytes it sent, so we HMAC `rawBody` (never the re-serialized JSON) with the
 * shared secret and constant-time compare against the header digest. Returns
 * false on any miss (no header, malformed hex) — the caller fails closed.
 */
export function verifyWebhookSignature(
	rawBody: Uint8Array,
	headerValue: string | null,
	secret: string,
	algorithm: "sha256" | "sha1",
	prefix: string | undefined,
): boolean {
	if (!headerValue) return false;
	const presented = prefix && headerValue.startsWith(prefix)
		? headerValue.slice(prefix.length)
		: headerValue;
	const expected = createHmac(algorithm, secret).update(rawBody).digest();
	// Buffer.from(hex) silently TRUNCATES on invalid hex, so a right-length but
	// non-hex header would slip past a hex-string length check and then make
	// timingSafeEqual throw. Compare the DECODED byte lengths instead — a
	// malformed signature decodes short → length mismatch → false (clean 401).
	const presentedBuf = Buffer.from(presented, "hex");
	if (presentedBuf.length !== expected.length) return false;
	return timingSafeEqual(presentedBuf, expected);
}

function isQueryTokenAllowed(config: WebhookIngestConfig): boolean {
	return config.allowQueryAuth === true || config.allowQueryAuth === "true";
}

/**
 * Whether to project the payload into `payload_text` so the row is embedded
 * and recallable via `search_memory`. Off by default — store-only rows stay
 * cheap and keep high-volume webhook noise out of semantic memory; automations
 * read them via SQL regardless. Accepts the string spelling because
 * declarative (`lobu apply`) configs carry string values only.
 */
function isSearchableEnabled(config: WebhookIngestConfig): boolean {
	return config.searchable === true || config.searchable === "true";
}

/**
 * Extract the presented token: `Authorization: Bearer`, the dedicated header,
 * or — only when the connection opted in — the `?token=` query param.
 */
function extractPresentedToken(
	request: Request,
	config: WebhookIngestConfig,
): string | undefined {
	const authorization = request.headers.get("authorization");
	if (authorization) {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		if (match) return match[1];
	}
	const headerToken = request.headers.get(TOKEN_HEADER);
	if (headerToken) return headerToken;
	if (isQueryTokenAllowed(config)) {
		const queryToken = new URL(request.url).searchParams.get("token");
		if (queryToken) return queryToken;
	}
	return undefined;
}

/**
 * Read the request body, bailing as soon as the cap is exceeded — a
 * Content-Length lie (or chunked encoding) must not buffer an unbounded
 * body into memory. Returns null when over the cap.
 */
export async function readBodyWithCap(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** RFC 6901 JSON-pointer lookup; returns undefined on any miss. */
function resolveJsonPointer(root: unknown, pointer: string): unknown {
	if (!pointer.startsWith("/")) return undefined;
	let current: unknown = root;
	for (const rawSegment of pointer.slice(1).split("/")) {
		const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(segment)) {
				return undefined;
			}
			const index = Number.parseInt(segment, 10);
			if (index >= current.length) {
				return undefined;
			}
			current = current[index];
		} else if (current !== null && typeof current === "object") {
			if (!Object.hasOwn(current as object, segment)) return undefined;
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}

/** Cap on the rendered `payload_text` so a large delivery can't bloat the
 * search index / embedding input. The raw payload is always preserved in
 * full in `payload_data` — this is only the searchable text projection. */
export const WEBHOOK_PAYLOAD_TEXT_MAX_CHARS = 8 * 1024;

/** Bound path construction and traversal for adversarially deep/sparse JSON. */
const WEBHOOK_PAYLOAD_TEXT_MAX_DEPTH = 64;
const WEBHOOK_PAYLOAD_TEXT_MAX_NODES = 10_000;

/**
 * Render the parsed payload into a flat text document for `events.payload_text`.
 * Without this the column is null, so the embed-backfill (which skips rows with
 * empty payload_text) never embeds the row and it stays invisible to semantic
 * recall / `search_memory` — reachable only by Automation SQL. Leaf scalars become
 * `dotted.path: value` lines, so the JSON structure doubles as searchable
 * context (e.g. `event.title: ZeroDivisionError`). Bounded by
 * WEBHOOK_PAYLOAD_TEXT_MAX_CHARS.
 */
export function renderPayloadText(payload: unknown): string {
	const lines: string[] = [];
	let budget = WEBHOOK_PAYLOAD_TEXT_MAX_CHARS;
	const push = (text: string): void => {
		if (budget <= 0) return;
		const clipped = text.length > budget ? text.slice(0, budget) : text;
		lines.push(clipped);
		budget -= clipped.length + 1; // + newline
	};
	type NodeFrame = {
		kind: "node";
		node: unknown;
		path: string;
		depth: number;
	};
	type ChildrenFrame = {
		kind: "children";
		iterator: Iterator<[string, unknown]>;
		path: string;
		depth: number;
	};
	type Frame = NodeFrame | ChildrenFrame;
	function* children(node: object): Generator<[string, unknown]> {
		if (Array.isArray(node)) {
			for (let i = 0; i < node.length; i += 1) {
				yield [String(i), node[i]];
			}
			return;
		}
		const record = node as Record<string, unknown>;
		for (const key in record) {
			if (Object.hasOwn(record, key)) yield [key, record[key]];
		}
	}
	const stack: Frame[] = [
		{ kind: "node", node: payload, path: "", depth: 0 },
	];
	let visited = 0;
	while (
		stack.length > 0 &&
		budget > 0 &&
		visited < WEBHOOK_PAYLOAD_TEXT_MAX_NODES
	) {
		const frame = stack.pop();
		if (!frame) break;
		if (frame.kind === "children") {
			const next = frame.iterator.next();
			if (!next.done) {
				stack.push(frame);
				const [key, value] = next.value;
				stack.push({
					kind: "node",
					node: value,
					path: frame.path ? `${frame.path}.${key}` : key,
					depth: frame.depth + 1,
				});
			}
			continue;
		}
		visited += 1;
		const { node, path, depth } = frame;
		if (
			node === null ||
			typeof node === "string" ||
			typeof node === "number" ||
			typeof node === "boolean"
		) {
			push(path ? `${path}: ${String(node)}` : String(node));
			continue;
		}
		if (depth >= WEBHOOK_PAYLOAD_TEXT_MAX_DEPTH) {
			push(path ? `${path}: [nested value]` : "[nested value]");
			continue;
		}
		if (typeof node === "object") {
			stack.push({
				kind: "children",
				iterator: children(node),
				path,
				depth,
			});
		}
	}
	return lines.join("\n");
}

/** Stable connector event exposed by the built-in webhook catalog. */
export const WEBHOOK_DELIVERY_RECEIVED_EVENT = "delivery.received";

/**
 * Normalize an authenticated webhook delivery into the same connector signal
 * consumed by feed syncs and chat transports. The durable event remains the
 * source of truth; this bounded envelope only decides which Automations wake.
 */
export function buildWebhookAutomationSignal(args: {
	connectionId: number;
	eventId: number;
	originId: string;
	semanticType: string;
	title?: string | null;
	payload: Record<string, unknown>;
	occurredAt: Date;
}): ConnectorTriggerSignal {
	const fallbackLabel = `Webhook delivery: ${args.semanticType}`;
	const inputText = renderPayloadText(args.payload);
	return {
		connector_key: "webhook",
		connection_id: args.connectionId,
		resource_type:
			args.semanticType.length <= 100 ? args.semanticType : undefined,
		...(args.originId.length <= 500
			? { resource_ref: args.originId }
			: {}),
		event_type: WEBHOOK_DELIVERY_RECEIVED_EVENT,
		// events.id is globally bounded and avoids sender-controlled btree keys.
		delivery_id: `webhook:event:${args.eventId}`,
		label: (args.title?.trim() || fallbackLabel).slice(0, 300),
		input_text: inputText || fallbackLabel,
		occurred_at: args.occurredAt.toISOString(),
		// Only trusted, connection-configured routing metadata belongs in every
		// fan-out run. The complete sender payload remains on the durable event.
		attributes: { semantic_type: args.semanticType.slice(0, 1_000) },
	};
}

function extractTitle(
	payload: unknown,
	titlePath: string | undefined,
): string | undefined {
	if (!titlePath) return undefined;
	const value = resolveJsonPointer(payload, titlePath);
	if (typeof value === "string" && value.length > 0) return value.slice(0, 500);
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function isUniqueViolation(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "23505";
}

async function findExistingDeliveryId(
	organizationId: string,
	connectorKey: string,
	originId: string,
): Promise<number | undefined> {
	const rows = await getDb()`
    SELECT id FROM events
    WHERE organization_id = ${organizationId}
      AND connector_key = ${connectorKey}
      AND origin_id = ${originId}
    LIMIT 1
  `;
	return (rows[0] as { id: number } | undefined)?.id;
}

/**
 * Caller-supplied projections for `events.title` / `events.source_url`.
 *
 * Connection ingest reads `events.title` from a static `config.titlePath` JSON
 * pointer and never sets a source url. App-webhook deliveries (GitHub App) carry
 * provider-specific shapes a single pointer can't express — a comment's title
 * lives on its parent issue, the url is `html_url` on a different object per
 * event type. The app-webhook router therefore extracts these per provider and
 * passes them here; when set they take precedence over `config.titlePath`.
 */
/** Entity attribution for the landed row, produced by {@link WebhookIngestOverrides.resolveActor}. */
export interface WebhookActorAttribution {
	/** Entity ids → events.entity_ids (the webhook path has no feed, so read-time JOINs need this). */
	entityIds?: number[];
	/** Canonical identifier namespace slots (e.g. github_login) merged onto the row for read-time JOINs. */
	metadata?: Record<string, unknown>;
}

export interface WebhookIngestOverrides {
	title?: string | null;
	sourceUrl?: string | null;
	/**
	 * The caller verified this is a real generic `webhook` connection, rather
	 * than a synthetic webhook envelope for a connector/app installation.
	 * Fail-closed so provider bridges cannot activate an unrelated generic
	 * webhook connection whose generated slug happens to collide.
	 */
	activateGenericAutomationEvent?: boolean;
	/** Provider-specific bearer verification (Atlassian OAuth webhook JWTs). */
	verifyBearerToken?: (token: string) => Promise<boolean>;
	/**
	 * Resolve the authoring actor → a person. Invoked only on the WINNING insert,
	 * inside the persist transaction (the `sql` handle IS that tx), so the actor
	 * graph writes commit atomically with the event and a deduped/lost-race
	 * delivery never mutates the graph. A null/throw lands the row unattributed.
	 */
	resolveActor?: (sql: DbClient) => Promise<WebhookActorAttribution | null>;
	/**
	 * After auth + size/rate limits, handle the delivery instead of persisting a
	 * raw `webhook:<id>` event. Used by poll-canonical connectors (GitHub) so
	 * OAuth/PAT webhooks mark the matching feed due (or store event-complete
	 * signals) the same way app-webhooks do — Automation signals then ride the
	 * poll path with full envelopes. Returning a Response short-circuits insert.
	 */
	handleInsteadOfPersist?: (ctx: {
		rawBody: Uint8Array;
		headers: Headers;
		parsed: unknown;
		organizationId: string;
		connectionId: string;
	}) => Promise<Response>;
}

/**
 * Handle one inbound delivery for a `platform: "webhook"` connection.
 *
 * The caller passes the RAW stored row (config still holding `secret://`
 * refs) — never a sanitized connection, whose redacted token could not
 * authenticate anything. Tokens are never logged; this handler logs only
 * connection ids and outcome codes.
 */
export async function handleWebhookIngest(
	stored: StoredConnection,
	request: Request,
	secretStore: SecretStore,
	peerAddress?: string | null,
	overrides?: WebhookIngestOverrides,
): Promise<Response> {
	const organizationId = stored.organizationId;
	if (!organizationId) {
		// Pre-Phase-C rows only; the storage layer requires org scoping today.
		logger.error(
			{ connectionId: stored.id },
			"[webhook-ingest] connection has no organization_id — refusing delivery",
		);
		return json(500, { error: "Connection is not org-scoped" });
	}
	const config = stored.config as WebhookIngestConfig;

	// 1. Size cap. Trust Content-Length only to reject early; the capped body
	//    read below enforces the limit for chunked/lying senders.
	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (declaredLength > WEBHOOK_INGEST_MAX_BODY_BYTES) {
		return json(413, { error: "Payload too large" });
	}

	// 2. Pre-auth rate limit, keyed by (connection, source IP) so a flood of
	//    bad-token requests can't exhaust the authenticated delivery budget
	//    below (cluster-wide counters, fail-open on DB trouble — matching
	//    every other limiter call site).
	const preauthRate = getRateLimiter().checkLimit(
		`webhook-ingest-preauth:${stored.id}:${getClientIP(request, peerAddress)}`,
		WEBHOOK_INGEST_PREAUTH_RATE_LIMIT,
	);
	if (!preauthRate.allowed) {
		return new Response(JSON.stringify({ error: preauthRate.errorMessage }), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(preauthRate.resetInSeconds),
			},
		});
	}

	// 3. Auth. A delivery authenticates by a matching bearer token, a verified
	//    provider HMAC signature (connector webhooks: GitHub/Linear sign), or a
	//    provider-verified bearer JWT (Atlassian OAuth-app webhooks). Fail closed
	//    when no method is configured.
	// Resolve both candidate secrets concurrently — either (or both) may gate
	// this delivery, so we need them before deciding auth.
	const [configuredToken, signatureSecret] = await Promise.all([
		resolveSecretValue(
			secretStore,
			typeof config.token === "string" ? config.token : undefined,
		),
		resolveSecretValue(
			secretStore,
			typeof config.signatureSecret === "string" ? config.signatureSecret : undefined,
		),
	]);
	if (!configuredToken && !signatureSecret && !overrides?.verifyBearerToken) {
		logger.warn(
			{ connectionId: stored.id },
			"[webhook-ingest] no resolvable token or signature secret — rejecting delivery",
		);
		return json(401, { error: "Unauthorized" });
	}
	// Token check is decisive pre-body when no signature is configured (preserves
	// the fast-reject path for plain ingest connections). When a signature IS
	// configured, a token miss isn't fatal yet — the signature is verified after
	// the body is read below (HMAC needs the raw bytes).
	const presentedToken = extractPresentedToken(request, config);
	let authenticated =
		!!configuredToken &&
		!!presentedToken &&
		tokensMatch(presentedToken, configuredToken);
	if (
		!authenticated &&
		presentedToken &&
		overrides?.verifyBearerToken
	) {
		authenticated = await overrides.verifyBearerToken(presentedToken);
	}
	if (!authenticated && !signatureSecret) {
		return json(401, { error: "Unauthorized" });
	}

	// 4. Authenticated per-connection delivery budget — only verified senders
	//    spend it.
	const rate = getRateLimiter().checkLimit(
		`webhook-ingest:${stored.id}`,
		WEBHOOK_INGEST_RATE_LIMIT,
	);
	if (!rate.allowed) {
		return new Response(JSON.stringify({ error: rate.errorMessage }), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(rate.resetInSeconds),
			},
		});
	}

	const rawBody = await readBodyWithCap(request, WEBHOOK_INGEST_MAX_BODY_BYTES);
	if (rawBody === null) {
		return json(413, { error: "Payload too large" });
	}

	// Complete auth: when the token didn't already authenticate and a signature
	// secret is configured, the provider's HMAC over the raw body must verify.
	if (!authenticated && signatureSecret) {
		const ok =
			typeof config.signatureHeader === "string" &&
			!!config.signatureHeader &&
			verifyWebhookSignature(
				rawBody,
				request.headers.get(config.signatureHeader),
				signatureSecret,
				config.algorithm === "sha1" ? "sha1" : "sha256",
				typeof config.signaturePrefix === "string"
					? config.signaturePrefix
					: undefined,
			);
		if (!ok) {
			return json(401, { error: "Unauthorized" });
		}
		authenticated = true;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return json(400, { error: "Request body must be valid JSON" });
	}

	// Poll-canonical connectors (GitHub OAuth/PAT) replace raw webhook:<id>
	// storage with feed-due / structured-store handling so Automation activations
	// share the same envelope path as scheduled polls. Auth above is identical.
	if (overrides?.handleInsteadOfPersist) {
		return overrides.handleInsteadOfPersist({
			rawBody,
			headers: request.headers,
			parsed,
			organizationId,
			connectionId: stored.id,
		});
	}

	// 5. Dedupe key: provider delivery id header when configured and present,
	//    else a content hash. Either way redeliveries map to the same origin_id.
	let originId: string | undefined;
	let dedupeSource: "header" | "body-hash" = "body-hash";
	if (typeof config.dedupeHeader === "string" && config.dedupeHeader) {
		const headerValue = request.headers.get(config.dedupeHeader);
		if (headerValue) {
			// Sender-controlled value feeding a btree index — keep entries bounded.
			// Real delivery ids (UUIDs etc.) pass through verbatim; anything
			// oversized collapses to its hash, which dedupes identically.
			originId =
				headerValue.length <= 256
					? headerValue
					: createHash("sha256").update(headerValue).digest("hex");
			dedupeSource = "header";
		}
	}
	if (!originId) {
		originId = createHash("sha256").update(rawBody).digest("hex");
	}

	const connectorKey = `webhook:${stored.id}`;
	const payloadData =
		parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: { payload: parsed };
	const semanticType =
		typeof config.semanticType === "string" && config.semanticType
			? config.semanticType
			: "content";

	// 6. Persist, then ack. Actor resolution is tied to the winning insert (see
	//    the transaction below). Fast-path a sequential duplicate first.
	const existingId = await findExistingDeliveryId(
		organizationId,
		connectorKey,
		originId,
	);
	if (existingId !== undefined) {
		return json(202, { ok: true, id: existingId, duplicate: true });
	}

	const eventMetadata: Record<string, unknown> = {
		webhook_connection_id: stored.id,
		dedupe_source: dedupeSource,
	};
	const eventTitle =
		overrides?.title != null && overrides.title.length > 0
			? overrides.title.slice(0, 500)
			: extractTitle(parsed, config.titlePath);
	const eventContent = isSearchableEnabled(config) ? renderPayloadText(parsed) : null;

	try {
		const landed = await getDb().begin(async (tx) => {
			let automationConnectionId: number | null = null;
			if (overrides?.activateGenericAutomationEvent) {
				if (/^\d+$/.test(stored.id)) {
					// Bridged connector-connection path: stored.id IS the numeric
					// connections.id (the route resolved it before falling through
					// to legacy lookup). Go direct — a slug lookup first could
					// match an unrelated legacy projection for a numeric stable
					// id (agentconn-<id>) in the same org and activate the wrong
					// connection's Automations.
					const [direct] = await tx<{ id: number }>`
						SELECT id
						FROM connections
						WHERE id = ${Number(stored.id)}
						  AND organization_id = ${organizationId}
						  AND connector_key = 'webhook'
						  AND deleted_at IS NULL
						LIMIT 1
					`;
					if (!direct) {
						throw new Error(
							`Generic webhook connection ${stored.id} has no active projection`,
						);
					}
					automationConnectionId = Number(direct.id);
				} else {
					const [projected] = await tx<{ id: number }>`
						SELECT id
						FROM connections
						WHERE organization_id = ${organizationId}
						  AND slug = ${runtimeConnectionIdToSlug(stored.id)}
						  AND connector_key = 'webhook'
						  AND deleted_at IS NULL
						LIMIT 1
					`;
					if (!projected) {
						throw new Error(
							`Generic webhook connection ${stored.id} has no active projection`,
						);
					}
					automationConnectionId = Number(projected.id);
				}
			}

			// Insert FIRST (empty entity_ids). A concurrent duplicate trips the
			// delivery-unique index → 23505 → this tx rolls back, so the loser never
			// reaches actor resolution. Only the winner continues.
			const occurredAt = new Date();
			const inserted = await insertEvent(
				{
					entityIds: [],
					organizationId,
					originId,
					connectorKey,
					...(automationConnectionId != null
						? { connectionId: automationConnectionId }
						: {}),
					semanticType,
					payloadType: "json_template",
					payloadData,
					content: eventContent,
					title: eventTitle,
					sourceUrl: overrides?.sourceUrl ?? null,
					occurredAt,
					metadata: eventMetadata,
				},
				{ sql: tx as unknown as ReturnType<typeof getDb> },
			);

			// Winner-only resolution in the same tx: exactly one resolveActor per
			// landed event, and no window where the row is visible with empty
			// entity_ids. Best-effort — a miss/throw leaves the row unattributed.
			let attribution: WebhookActorAttribution | null = null;
			if (overrides?.resolveActor) {
				try {
					attribution = await overrides.resolveActor(
						tx as unknown as DbClient,
					);
				} catch (error) {
					logger.warn(
						{ connectionId: stored.id, error: String(error) },
						"[webhook-ingest] actor resolution failed — landing delivery unattributed",
					);
				}
			}
			if (
				attribution &&
				((attribution.entityIds && attribution.entityIds.length > 0) ||
					(attribution.metadata && Object.keys(attribution.metadata).length > 0))
			) {
				const entityIdsValue =
					attribution.entityIds && attribution.entityIds.length > 0
						? `{${attribution.entityIds.join(",")}}`
						: null;
				await tx`
					UPDATE events
					SET entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
					    metadata = metadata || ${tx.json(attribution.metadata ?? {})},
					    linked_org_ids = (
					      SELECT COALESCE(array_agg(DISTINCT x.o), '{}'::text[])
					      FROM (
					        SELECT ent.organization_id AS o
					        FROM public.entities ent
					        WHERE ent.id = ANY(COALESCE(${entityIdsValue}::bigint[], events.entity_ids))
					        UNION ALL
					        SELECT c.organization_id AS o
					        FROM public.connections c
					        WHERE c.id = events.connection_id
					      ) x
					      WHERE x.o IS NOT NULL
					        AND (x.o <> events.organization_id OR events.organization_id IS NULL)
					    )
					WHERE id = ${inserted.id}
				`;
			}

			// Persisted event + matching Automation runs commit together. Connector
			// scheduling stays independent: this is the same durable event seam used
			// by polled feeds, so no webhook-specific scheduler or subscription row
			// is introduced. Only the generic-webhook route opts in; provider bridges
			// keep interpreting their own event vocabulary.
			let activationRuns: AutomationActivationResult[] = [];
			if (automationConnectionId != null) {
				activationRuns = await activateAutomationSignal({
					organizationId,
					signal: buildWebhookAutomationSignal({
						connectionId: automationConnectionId,
						eventId: inserted.id,
						originId,
						semanticType,
						title: eventTitle,
						payload: payloadData,
						occurredAt,
					}),
					db: tx,
				});
			}
			return { eventId: inserted.id, activationRuns };
		});
		// The committed run rows are authoritative. Wake dispatch for low latency,
		// but never hold the sender's acknowledgement open on agent/session HTTP.
		// The periodic Automation tick recovers a pending run if this pod exits.
		void dispatchAutomationRunsBestEffort(landed.activationRuns);
		logger.info(
			{ connectionId: stored.id, eventId: landed.eventId, dedupeSource },
			"[webhook-ingest] delivery persisted",
		);
		return json(202, { ok: true, id: landed.eventId });
	} catch (error) {
		if (isUniqueViolation(error)) {
			// Lost the concurrent race: the winner's row exists; ack as a duplicate.
			// The rolled-back tx means we never resolved the actor here.
			const racedId = await findExistingDeliveryId(
				organizationId,
				connectorKey,
				originId,
			);
			if (racedId !== undefined) {
				return json(202, { ok: true, id: racedId, duplicate: true });
			}
		}
		logger.error(
			{ connectionId: stored.id, error: String(error) },
			"[webhook-ingest] failed to persist delivery",
		);
		// Non-2xx so the provider retries; nothing was acked.
		return json(500, { error: "Failed to persist delivery" });
	}
}
