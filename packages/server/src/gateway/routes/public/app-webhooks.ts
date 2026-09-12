/**
 * Shared multi-tenant app-webhook router (PR4 of the app-installation design,
 * docs/design/app-installation.md §4.3).
 *
 * `POST /api/v1/app-webhooks/:provider` is ONE public endpoint per provider for
 * an installed Lobu App (GitHub App, Slack app, Jira Connect). Unlike the
 * per-connection ingest route (`/api/v1/webhooks/:connectionId`), the sender
 * here is a single app-level webhook configured ONCE on the provider side; the
 * delivery carries no Lobu connection id. The router therefore:
 *
 *   1. verifies the delivery with the APP-LEVEL secret (provider plugin), then
 *   2. extracts the provider tenant tuple (provider_instance, provider_app_id,
 *      external_tenant_id) from the body/headers (provider plugin), then
 *   3. resolves the active `app_installations` row for that tuple → owning org,
 *      and lands the raw delivery through the SAME event-log path as the
 *      per-connection ingest (`connector_key='webhook:<id>'`, reusing the
 *      dedupe index, size cap, and rate limit).
 *
 * Verification + tenant extraction are GENERIC, derived entirely from the
 * connector's `ConnectorWebhookSchema`: {@link verifyDeclaredWebhook} computes
 * HMAC over the declared `signingBaseTemplate` (default `{body}` for
 * GitHub/Jira/Linear; `v0:{timestamp}:{body}` + freshness for Slack) and
 * {@link extractTenantFromSchema} reads the tenant from the declared
 * `routingKeyPath(s)` (+ optional `url-host` transform for Jira). There is NO
 * per-provider verify or extractor and NO provider-name branch — one engine,
 * one builder ({@link createDeclaredAppWebhookProvider}).
 *
 * Delivery before the install callback: a provider may deliver before the
 * OAuth/install callback has written the `app_installations` row. That is NOT
 * an error — we ack 200 and log, so the provider doesn't retry-storm; the
 * install reconciles on the callback and subsequent deliveries land. (§4.3.4)
 *
 * Multi-replica: stateless by construction — verify is pure, tenant resolution
 * and the landing insert read/write Postgres only; nothing is memoized per pod.
 * Any replica can serve any delivery.
 */

import { requestFeedSync } from '../../../runs/feed-notifications';
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createLogger } from "@lobu/core";
import type { StoredConnection } from "@lobu/core";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../../../db/client.js";
import {
	handleWebhookIngest,
	readBodyWithCap,
	WEBHOOK_INGEST_MAX_BODY_BYTES,
} from "../../connections/webhook-ingest.js";
import type { SecretStore } from "../../secrets/index.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { insertEvent } from "../../../utils/insert-event.js";
import {
	githubKeyForOriginId,
	githubUserIdentityKey,
} from "@lobu/connectors/github-identity";
import { extractGithubActor, resolveGithubWebhookActor } from "./github-webhook-actor.js";
import { createJiraWebhookDelivery } from "./jira-mcp-webhook-delivery.js";

const logger = createLogger("app-webhook-routes");

/** The provider tenant tuple a plugin extracts to route a delivery. */
export interface AppWebhookTenant {
	/** 'cloud' | GHES host | atlassian site class. */
	providerInstance: string;
	/** Which Lobu App (GitHub App id, Slack app id, Jira app key). */
	providerAppId: string;
	/** installation_id / team_id / cloudId. */
	externalTenantId: string;
}

/**
 * `events.title` / `events.source_url` for the landed row. Extracted per
 * provider, not via a config JSON pointer: a comment's title lives on its parent
 * subject, so where the title/url live varies by event type.
 */
export interface AppWebhookContent {
	title?: string;
	sourceUrl?: string;
}

/**
 * A registered provider: verifier + tenant extractor + optional per-KIND
 * delivery hooks. Every integration provider is built by the SINGLE generic
 * {@link createDeclaredAppWebhookProvider} from its declared
 * {@link ConnectorWebhookSchema} — no per-provider verify/extractor code. A new
 * provider is a connector DECLARATION, not a new plugin in this file.
 */
export interface AppWebhookProvider {
	provider: string;
	/**
	 * The provider's raw-body HMAC scheme, used by the router to synthesize the
	 * ingest connection config so `handleWebhookIngest` re-verifies against the
	 * SAME header/algorithm/prefix the provider just verified — not a hardcoded
	 * GitHub scheme. `dedupeHeader` is the provider's per-delivery id header
	 * (when one exists); absent → ingest dedupes on a body hash.
	 */
	webhookScheme: {
		signatureHeader: string;
		algorithm: "sha256" | "sha1";
		signaturePrefix?: string;
		dedupeHeader?: string;
	};
	/**
	 * Verify the delivery against the APP-LEVEL webhook secret. Pure over
	 * (rawBody, headers, secret) — no I/O — so it's trivially multi-replica
	 * safe. Returns false on any miss (the router fails closed with 401).
	 */
	verify(
		rawBody: Uint8Array,
		headers: Headers,
		appWebhookSecret: string,
	): boolean;
	/**
	 * Pull the provider tenant tuple from the body/headers. Returns null when
	 * the delivery carries no resolvable tenant (e.g. a ping with no
	 * installation), in which case the router acks 200 without landing.
	 */
	extractTenant(rawBody: Uint8Array, headers: Headers): AppWebhookTenant | null;
	/** Optional title/source_url for the landed row; omitted → empty fields. */
	extractContent?(rawBody: Uint8Array, headers: Headers): AppWebhookContent;
	/**
	 * Optional: resolve the delivery's authoring actor to a tenant-scoped
	 * `person` → entity ids + identifier metadata slots for the landed row. The
	 * org is the caller's resolved install, so resolution never crosses orgs.
	 * Invoked lazily by handleWebhookIngest on the winning insert only; `sql` is
	 * that insert's transaction, so the graph writes commit atomically with it.
	 */
	resolveActor?(params: {
		organizationId: string;
		rawBody: Uint8Array;
		headers: Headers;
		sql: DbClient;
	}): Promise<{ entityIds: number[]; metadata: Record<string, string> } | null>;
	/**
	 * Optional: handle the delivery itself instead of storing a raw event. For
	 * connectors with a sync mapping (github) the canonical record is the poll, so
	 * the provider decides per event type (see the github plugin):
	 *  - TRIGGER (most events) — mark the affected feed due (`next_run_at = now()`)
	 *    and let the poll fetch the complete record (dedupes/supersedes by stable
	 *    origin_id). No identity resolution here — the poll resolves it once.
	 *  - STORE (event-complete signals, e.g. stars) — resolve the actor and insert
	 *    the structured event directly, keyed on the same origin_id the poll uses.
	 * No raw blob is stored either way. Providers that define this NEVER fall
	 * through to the raw ingest path; providers without it keep raw store
	 * (jira/linear). `triggered` reports whether a feed was marked due OR an event
	 * stored (telemetry only — the router acks 200 either way; an unconfigured
	 * repo/feed is a no-op, not an error).
	 */
	onDelivery?(params: {
		rawBody: Uint8Array;
		headers: Headers;
		install: {
			id: number | string;
			organizationId: string;
			externalTenantId: string;
		};
		sql: DbClient;
	}): Promise<{ triggered: boolean; handled?: boolean }>;
	/**
	 * Optional: take over the ENTIRE delivery after `verify`, bypassing the
	 * router's `extractTenant` → `resolveActiveByTenant` (`app_installations`) →
	 * ingest pipeline. A provider that defines this owns its own routing AND its
	 * own HTTP response; the router returns the Response verbatim.
	 *
	 * This exists for Slack, whose live messaging path does NOT fit the
	 * resolve-install-then-store model:
	 *  - Slack's PRIMARY routing target is a BYO `connections` row (slug
	 *    `agentconn-…`) keyed on team_id — there is NO `app_installations` row
	 *    for it, so the generic
	 *    `resolveActiveByTenant` would 200-ack the delivery and the live bot would
	 *    stop receiving events. The precedence (BYO connection → active OAuth
	 *    install → preview connection → OAuth-fallback chat) and the live forward
	 *    to a running chat adapter (url_verification challenges, replies) live in
	 *    {@link SlackConnectionCoordinator.handleAppWebhook} and must be preserved
	 *    exactly.
	 *  - A delivery is forwarded to a running adapter, not stored as a raw event.
	 *
	 * `verify` still runs first (fail-closed signing check at the edge); only the
	 * post-verify routing is delegated. `rawBody` is the already-read body; the
	 * provider reconstructs a Request from it as needed.
	 */
	handleDelivery?(params: {
		rawBody: Uint8Array;
		headers: Headers;
		url: string;
		method: string;
	}): Promise<Response>;
}

/** Parse the raw JSON body once; returns undefined on malformed JSON. */
function parseJson(rawBody: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return undefined;
	}
}

/** Narrow an unknown JSON node to a string field, or undefined. */
function strField(node: unknown, key: string): string | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const value = (node as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Follow a dotted JSON path (`a.b.c`) into a parsed body and return the leaf as
 * a non-empty string, or undefined. Numbers are stringified (GitHub installation
 * ids are integers). Used by the generic tenant extractor — no provider literal.
 */
function readPath(body: unknown, path: string): string | undefined {
	let node: unknown = body;
	for (const segment of path.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	if (typeof node === "string") return node.length > 0 ? node : undefined;
	if (typeof node === "number" && Number.isFinite(node)) return String(node);
	return undefined;
}

/**
 * THE generic webhook verifier. Computes HMAC over the schema's rendered signing
 * base (`{body}` and `{timestamp}` substituted) with the declared
 * algorithm/prefix, compares constant-time against `signatureHeader`, and
 * optionally rejects stale timestamps. Pure over (rawBody, headers, secret) — no
 * I/O — so it is trivially multi-replica safe. Returns false on any miss.
 *
 * Coverage by declaration alone (no provider branch):
 *  - GitHub/Jira/Linear: default base `{body}` → plain raw-body HMAC.
 *  - Slack: base `v0:{timestamp}:{body}` + `timestampHeader` +
 *    `freshnessSeconds: 300` → the full `v0` scheme.
 */
export function verifyDeclaredWebhook(
	rawBody: Uint8Array,
	headers: Headers,
	secret: string,
	schema: ConnectorWebhookSchema,
): boolean {
	const signatureHeader = schema.signatureHeader;
	if (!signatureHeader) return false;
	const provided = headers.get(signatureHeader);
	if (!provided) return false;
	const algorithm = schema.algorithm ?? "sha256";
	const prefix = schema.signaturePrefix;

	// Resolve the timestamp once: it feeds both the signing base and the optional
	// freshness guard. Required only when the template references it.
	const template = schema.signingBaseTemplate ?? "{body}";
	const needsTimestamp = template.includes("{timestamp}");
	let timestamp: string | undefined;
	if (needsTimestamp || schema.freshnessSeconds !== undefined) {
		if (!schema.timestampHeader) return false;
		timestamp = headers.get(schema.timestampHeader) ?? undefined;
		if (!timestamp) return false;
		if (schema.freshnessSeconds !== undefined) {
			const ts = Number.parseInt(timestamp, 10);
			if (!Number.isFinite(ts)) return false;
			const nowSec = Math.floor(Date.now() / 1000);
			if (Math.abs(nowSec - ts) > schema.freshnessSeconds) return false;
		}
	}

	// Render the signing base. `{body}` is the raw bytes (kept as bytes so binary
	// payloads sign correctly); the template is split around `{body}` so the body
	// is concatenated, not decoded.
	const tsPart = timestamp ?? "";
	const withTimestamp = template.replace(/\{timestamp\}/g, tsPart);
	const segments = withTimestamp.split("{body}");
	const parts: Buffer[] = [];
	segments.forEach((seg: string, i: number) => {
		if (i > 0) parts.push(Buffer.from(rawBody));
		if (seg) parts.push(Buffer.from(seg, "utf8"));
	});
	const base = Buffer.concat(parts);

	const expectedHex = createHmac(algorithm, secret).update(base).digest("hex");
	const expected = (prefix ?? "") + expectedHex;
	const providedBuf = Buffer.from(provided, "utf8");
	const expectedBuf = Buffer.from(expected, "utf8");
	if (providedBuf.length !== expectedBuf.length) return false;
	try {
		return timingSafeEqual(providedBuf, expectedBuf);
	} catch {
		return false;
	}
}

/**
 * THE generic tenant extractor. Reads the external tenant id from the body via
 * the schema's ordered `routingKeyPaths` (or single `routingKeyPath`), first
 * non-empty match wins, then applies the declared `routingKeyTransform`
 * (`url-host` → the value's URL host, for Jira's `self` URLs). Returns null when
 * no path resolves (e.g. an app-level ping) → the router acks without landing.
 */
export function extractTenantFromSchema(
	rawBody: Uint8Array,
	schema: ConnectorWebhookSchema,
	providerAppId: string,
	providerInstance = "cloud",
): AppWebhookTenant | null {
	const paths =
		schema.routingKeyPaths ??
		(schema.routingKeyPath ? [schema.routingKeyPath] : []);
	if (paths.length === 0) return null;
	const body = parseJson(rawBody);
	for (const path of paths) {
		const raw = readPath(body, path);
		if (!raw) continue;
		let externalTenantId = raw;
		if (schema.routingKeyTransform === "url-host") {
			try {
				externalTenantId = new URL(raw).host;
			} catch {
				continue;
			}
			if (!externalTenantId) continue;
		}
		return { providerInstance, providerAppId, externalTenantId };
	}
	return null;
}

/**
 * Build an {@link AppWebhookProvider} entirely from a connector's DECLARED
 * {@link ConnectorWebhookSchema} — verify ({@link verifyDeclaredWebhook}) and
 * tenant extraction ({@link extractTenantFromSchema}) are both generic, so this
 * one builder covers every integration provider (GitHub/Jira/Linear/Slack) with
 * NO provider-name branch. The only per-KIND parts are the optional delivery
 * hooks (`onDelivery` for poll-canonical triggers, `handleDelivery` for chat
 * adapters), injected by the caller — they are Phase-D concerns and carry no
 * verify/tenant/registration knowledge.
 *
 * `signatureHeader` is REQUIRED: an app-webhook endpoint must fail closed, so a
 * provider that signs nothing has no derivable verify. We throw at construction
 * rather than silently accept unverifiable deliveries.
 */
export function createDeclaredAppWebhookProvider(options: {
	/** The `:provider` path segment + `app_installations.provider` value. */
	provider: string;
	/** Receiving Lobu App id, stamped as `provider_app_id`. */
	appId: string;
	/** The connector's declared webhook scheme; verify + tenant derive from it. */
	webhookSchema: ConnectorWebhookSchema;
	/** Provider instance (default `'cloud'`). */
	providerInstance?: string;
	/** Optional title/source_url projector for the landed row. */
	extractContent?: AppWebhookProvider["extractContent"];
	/** Optional actor → person resolver (see {@link AppWebhookProvider.resolveActor}). */
	resolveActor?: AppWebhookProvider["resolveActor"];
	/** Optional per-KIND trigger handler (see {@link AppWebhookProvider.onDelivery}). */
	onDelivery?: AppWebhookProvider["onDelivery"];
	/** Optional per-KIND full-delivery takeover (chat adapters; {@link AppWebhookProvider.handleDelivery}). */
	handleDelivery?: AppWebhookProvider["handleDelivery"];
}): AppWebhookProvider {
	const { provider, appId, webhookSchema, providerInstance } = options;
	const signatureHeader = webhookSchema.signatureHeader;
	if (!signatureHeader) {
		throw new Error(
			`App-webhook provider "${provider}" requires a webhook signatureHeader ` +
				`(a non-signing provider can't be verified — fail closed).`,
		);
	}
	const algorithm = webhookSchema.algorithm ?? "sha256";
	const signaturePrefix = webhookSchema.signaturePrefix;
	return {
		provider,
		webhookScheme: {
			signatureHeader,
			algorithm,
			...(signaturePrefix ? { signaturePrefix } : {}),
			...(webhookSchema.dedupeHeader
				? { dedupeHeader: webhookSchema.dedupeHeader }
				: {}),
		},
		verify(rawBody, headers, appWebhookSecret) {
			return verifyDeclaredWebhook(rawBody, headers, appWebhookSecret, webhookSchema);
		},
		extractTenant(rawBody) {
			return extractTenantFromSchema(
				rawBody,
				webhookSchema,
				appId,
				providerInstance,
			);
		},
		...(options.extractContent ? { extractContent: options.extractContent } : {}),
		...(options.resolveActor ? { resolveActor: options.resolveActor } : {}),
		...(options.onDelivery ? { onDelivery: options.onDelivery } : {}),
		...(options.handleDelivery ? { handleDelivery: options.handleDelivery } : {}),
	};
}

/** Webhook routing for one feed: which feed a delivery updates, and how. */
interface WebhookRoute {
	feedKey: string;
	mode: "trigger" | "store";
}

/**
 * Build the github event → feed routing from the org's connector definition
 * feeds_schema, where each feed declares `webhook: { events, mode }`. Read from
 * the DB — the same persisted surface the poll path reads its entity-link rules
 * from — so the server hardcodes NO provider event types or feed names. A
 * per-delivery query (webhooks are low-frequency); an org with no active github
 * definition yields an empty map → deliveries ack as no-ops.
 *
 * Routing strategies (declared by the connector per feed):
 *  - TRIGGER — the poll brings strictly more than the webhook (an `issues`
 *    payload omits computed counts; a `push` lacks the immutable github user id
 *    `/commits` returns), so the delivery marks THAT feed due and the poll
 *    fetches the complete record.
 *  - STORE — the payload is event-complete (a `star` carries actor + starred_at)
 *    and re-polling the whole list is waste, so the event is stored directly.
 */
async function loadGithubWebhookRoutes(
	organizationId: string,
	connectorKey: string,
): Promise<Map<string, WebhookRoute>> {
	const rows = await getDb()`
		SELECT feeds_schema FROM connector_definitions
		WHERE key = ${connectorKey} AND organization_id = ${organizationId} AND status = 'active'
		ORDER BY updated_at DESC
		LIMIT 1
	`;
	const routes = new Map<string, WebhookRoute>();
	const feedsSchema = rows[0]?.feeds_schema as
		| Record<string, { webhook?: { events?: unknown; mode?: unknown } }>
		| null
		| undefined;
	if (!feedsSchema) return routes;
	for (const [feedKey, feed] of Object.entries(feedsSchema)) {
		const events = feed?.webhook?.events;
		if (!Array.isArray(events)) continue;
		const mode = feed.webhook?.mode === "store" ? "store" : "trigger";
		for (const event of events) {
			if (typeof event === "string" && event) routes.set(event, { feedKey, mode });
		}
	}
	return routes;
}

/**
 * GitHub's per-KIND delivery hook (poll-canonical trigger/store), built
 * separately from the generic provider so it can be injected via
 * {@link createDeclaredAppWebhookProvider}'s `onDelivery`. This is the only
 * GitHub-specific code left in this file; relocating it out of the gateway core
 * is the Phase-D per-kind delivery work. Verify + tenant + registration are
 * fully generic (no GitHub branch).
 *
 * Routing comes from {@link loadGithubWebhookRoutes} (the connector's
 * feeds_schema), not a hardcoded map. Most events TRIGGER the affected feed's
 * poll; event-complete signals (stars) are STORED directly, consolidating with
 * the poll on origin_id.
 */
export function createGithubWebhookDelivery(options: {
	/**
	 * The connector key whose feeds/connections this delivery routes to and
	 * whose value is stamped on any stored event — threaded from the delivery
	 * context (BundledIntegrationConnector.connectorKey), never a literal.
	 */
	connectorKey: string;
	/**
	 * Land event-complete deliveries (stars) directly instead of re-polling.
	 * Default true. Set false to make every delivery a trigger (the scheduled
	 * poll then captures stars on its next backstop run).
	 */
	storeWebhookEvents?: boolean;
}): NonNullable<AppWebhookProvider["onDelivery"]> {
	const { connectorKey } = options;
	const storeWebhookEvents = options.storeWebhookEvents ?? true;
	return async ({ rawBody, headers, install, sql }) => {
		const event = headers.get("x-github-event");
		if (!event) return { triggered: false };
		// Routing is declared by the connector (feeds_schema), read from the DB.
		const route = (
			await loadGithubWebhookRoutes(install.organizationId, connectorKey)
		).get(event);
		if (!route) return { triggered: false };
		const payload = parseJson(rawBody);
		const repo = extractGithubRepo(payload);
		if (!repo) return { triggered: false };

		// STORE (event-complete signals, e.g. stars): land the structured event
		// directly, consolidating with the poll on origin_id — no wasteful
		// re-poll. Resolution happens here because the poll won't run for this
		// feed on the webhook's account. Gated by storeWebhookEvents; when off,
		// fall through to a trigger so the scheduled poll picks it up.
		if (route.mode === "store" && storeWebhookEvents) {
			const stored = await storeGithubWebhookEvent({
				sql,
				connectorKey,
				install,
				repo,
				event,
				feedKey: route.feedKey,
				payload,
			});
			return { triggered: stored };
		}

		// TRIGGER: the poll brings more, so mark THAT feed due and let the poll
		// fetch the complete record (dedupes/supersedes by origin_id) and resolve
		// the person once — no webhook-side resolution (avoids double work).
		const triggered = await markGithubFeedDue({
			sql,
			connectorKey,
			install,
			repo,
			feedKey: route.feedKey,
		});
		return { triggered };
	};
}

/**
 * Resolve the DATA-kind delivery hook for a connector, selected by its KIND of
 * data delivery — NOT by a provider-name branch in the gateway wiring. A data
 * integration whose deliveries are POLL-CANONICAL (GitHub: trigger the affected
 * feed / store event-complete signals) ships a hook here; data integrations that
 * RAW-STORE their deliveries (Linear) ship none, so the router falls through to
 * the raw event-ingest path. Jira routes matching sites to Atlassian Rovo
 * issue feeds and explicitly falls through while no Rovo feed exists. This
 * lookup lives in the data-delivery module, so the gateway selects `data` vs
 * `chat` by deliveryKind and delegates the per-connector data hook to this —
 * gateway core stays free of provider literals. A new hook-shipping data
 * integration adds its hook here; everything else needs no change.
 */
export function createDataWebhookDelivery(
	connectorKey: string,
): AppWebhookProvider["onDelivery"] | undefined {
	if (connectorKey === "github") {
		return createGithubWebhookDelivery({
			connectorKey,
			storeWebhookEvents: process.env.GITHUB_WEBHOOK_STORE_EVENTS !== "false",
		});
	}
	if (connectorKey === "jira") return createJiraWebhookDelivery();
	return undefined;
}

/** Extract the {owner, name} of the repo a GitHub delivery is about, or null. */
function extractGithubRepo(
	body: unknown,
): { owner: string; name: string } | null {
	if (body === null || typeof body !== "object") return null;
	const repository = (body as Record<string, unknown>).repository;
	if (repository === null || typeof repository !== "object") return null;
	const repo = repository as Record<string, unknown>;
	const name = typeof repo.name === "string" ? repo.name : undefined;
	const owner = strField(repo.owner, "login");
	if (owner && name) return { owner, name };
	// Fall back to full_name ("owner/name") when the split fields are absent.
	const fullName = typeof repo.full_name === "string" ? repo.full_name : undefined;
	if (fullName?.includes("/")) {
		const [o, n] = fullName.split("/", 2);
		if (o && n) return { owner: o, name: n };
	}
	return null;
}

/**
 * Mark the active github feed for (install, repo, feedKey) due NOW so the
 * orchestrator syncs it on its next tick — the webhook becomes the "when to run"
 * signal, with the schedule as the self-covering backstop. Scoped to the one
 * feed the event belongs to, so unrelated feeds aren't re-polled. Idempotent:
 * redeliveries just re-stamp `next_run_at`. Returns whether the feed matched
 * (telemetry only — an unconfigured repo/feed is a no-op, not an error).
 */
async function markGithubFeedDue(params: {
	sql: DbClient;
	connectorKey: string;
	install: { id: number | string; organizationId: string };
	repo: { owner: string; name: string };
	feedKey: string;
}): Promise<boolean> {
	const { sql, connectorKey, install, repo, feedKey } = params;
	const rows = await requestFeedSync(sql, sql`
		SELECT f.id FROM feeds f, connections c
		WHERE f.connection_id = c.id
		  AND c.organization_id = ${install.organizationId}
		  AND c.connector_key = ${connectorKey}
		  AND c.status = 'active'
		  AND c.deleted_at IS NULL
		  AND (c.config->>'installation_ref') = ${String(install.id)}
		  AND f.feed_key = ${feedKey}
		  AND lower(f.config->>'repo_owner') = lower(${repo.owner})
		  AND lower(f.config->>'repo_name') = lower(${repo.name})
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
	`);
	return rows.length > 0;
}

/**
 * OAuth/PAT GitHub connection path: mark the single connection's matching feed
 * due. Same poll-canonical contract as {@link markGithubFeedDue}, but keyed by
 * connection id rather than app installation_ref.
 */
async function markGithubFeedDueForConnection(params: {
	sql: DbClient;
	connectorKey: string;
	connectionId: number;
	organizationId: string;
	repo: { owner: string; name: string };
	feedKey: string;
}): Promise<boolean> {
	const { sql, connectorKey, connectionId, organizationId, repo, feedKey } =
		params;
	const rows = await requestFeedSync(sql, sql`
		SELECT f.id FROM feeds f, connections c
		WHERE f.connection_id = c.id
		  AND c.id = ${connectionId}
		  AND c.organization_id = ${organizationId}
		  AND c.connector_key = ${connectorKey}
		  AND c.status = 'active'
		  AND c.deleted_at IS NULL
		  AND f.feed_key = ${feedKey}
		  AND lower(f.config->>'repo_owner') = lower(${repo.owner})
		  AND lower(f.config->>'repo_name') = lower(${repo.name})
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
	`);
	return rows.length > 0;
}

/**
 * Poll-canonical handling for a GitHub connector connection webhook
 * (`POST /api/v1/webhooks/:connectionId` after the OAuth/PAT bridge).
 * TRIGGER events mark the feed due so the next CheckDueFeeds tick runs the
 * poll and attaches automation_signals; STORE events land structured rows under
 * the real github connector_key. Never raw-stores under webhook:<id>.
 */
export async function deliverGithubConnectorConnectionWebhook(params: {
	sql: DbClient;
	connectionId: number;
	organizationId: string;
	connectorKey: string;
	rawBody: Uint8Array;
	headers: Headers;
	storeWebhookEvents?: boolean;
}): Promise<{ triggered: boolean }> {
	const {
		sql,
		connectionId,
		organizationId,
		connectorKey,
		rawBody,
		headers,
	} = params;
	const storeWebhookEvents = params.storeWebhookEvents ?? true;
	const event = headers.get("x-github-event");
	if (!event) return { triggered: false };
	const route = (await loadGithubWebhookRoutes(organizationId, connectorKey)).get(
		event,
	);
	if (!route) return { triggered: false };
	const payload = parseJson(rawBody);
	const repo = extractGithubRepo(payload);
	if (!repo) return { triggered: false };

	if (route.mode === "store" && storeWebhookEvents) {
		// Reuse the install-shaped store path by resolving the feed on this
		// connection only (installation_ref match is bypassed via a synthetic
		// install id that won't match — call connection-scoped store).
		const stored = await storeGithubWebhookEventForConnection({
			sql,
			connectorKey,
			connectionId,
			organizationId,
			repo,
			event,
			feedKey: route.feedKey,
			payload,
		});
		return { triggered: stored };
	}

	const triggered = await markGithubFeedDueForConnection({
		sql,
		connectorKey,
		connectionId,
		organizationId,
		repo,
		feedKey: route.feedKey,
	});
	return { triggered };
}

/**
 * The active github feed matching (install, repo, feedKey) and its connection.
 * The store path is gated on this exactly like the trigger path
 * ({@link markGithubFeedDue}) — a repo with no such feed configured is a no-op,
 * not an unconfigured event. The connection id is the feed's own, so the stored
 * event shares the poll's (connection_id, origin_id) and consolidates.
 */
async function resolveGithubFeedTarget(params: {
	sql: DbClient;
	connectorKey: string;
	install: { id: number | string; organizationId: string };
	repo: { owner: string; name: string };
	feedKey: string;
}): Promise<{
	connectionId: number;
	feedId: number;
	owner: string;
	name: string;
} | null> {
	const { sql, connectorKey, install, repo, feedKey } = params;
	// GitHub owner/repo are case-insensitive; match accordingly and return the
	// feed config's canonical casing so the store builds the SAME origin_id the
	// poll does (the connector keys origin_id off the feed config, not the
	// webhook payload's display casing) — otherwise consolidation would break.
	const [row] = await sql`
		SELECT f.id AS feed_id, f.connection_id,
		       f.config->>'repo_owner' AS repo_owner, f.config->>'repo_name' AS repo_name
		FROM feeds f
		JOIN connections c ON c.id = f.connection_id
		WHERE c.organization_id = ${install.organizationId}
		  AND c.connector_key = ${connectorKey}
		  AND c.status = 'active'
		  AND c.deleted_at IS NULL
		  AND (c.config->>'installation_ref') = ${String(install.id)}
		  AND f.feed_key = ${feedKey}
		  AND lower(f.config->>'repo_owner') = lower(${repo.owner})
		  AND lower(f.config->>'repo_name') = lower(${repo.name})
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
		LIMIT 1
	`;
	return row
		? {
				connectionId: Number(row.connection_id),
				feedId: Number(row.feed_id),
				owner: String(row.repo_owner),
				name: String(row.repo_name),
			}
		: null;
}

/**
 * Land an event-complete github delivery (star/watch) as a structured event
 * instead of re-polling. The origin_id mirrors the github connector's stargazer
 * scheme (`stargazer_<owner>_<repo>_<github_user_id:ID | github_login:login>`,
 * non-alnum → `_`) and the event is stored under the install's github
 * connection, so the scheduled `/stargazers` poll supersedes/dedupes it on the
 * SAME (connection_id, origin_id). The actor is resolved to a person here (the
 * poll won't run on the webhook's account). Unstars are transient — not tracked
 * (the user opted out of delete signals). Returns false (no-op) when no active
 * matching feed is configured for the repo or the delivery isn't a new star.
 */
async function storeGithubWebhookEvent(params: {
	sql: DbClient;
	connectorKey: string;
	install: { id: number | string; organizationId: string };
	repo: { owner: string; name: string };
	event: string;
	feedKey: string;
	payload: unknown;
}): Promise<boolean> {
	const target = await resolveGithubFeedTarget({
		sql: params.sql,
		connectorKey: params.connectorKey,
		install: params.install,
		repo: params.repo,
		feedKey: params.feedKey,
	});
	if (!target) return false;
	return landGithubStarEvent({
		...params,
		organizationId: params.install.organizationId,
		target,
	});
}

/** Connection-scoped store for OAuth/PAT GitHub star webhooks. */
async function storeGithubWebhookEventForConnection(params: {
	sql: DbClient;
	connectorKey: string;
	connectionId: number;
	organizationId: string;
	repo: { owner: string; name: string };
	event: string;
	feedKey: string;
	payload: unknown;
}): Promise<boolean> {
	const target = await resolveGithubFeedTargetForConnection(params);
	if (!target) return false;
	return landGithubStarEvent({
		sql: params.sql,
		connectorKey: params.connectorKey,
		organizationId: params.organizationId,
		repo: params.repo,
		event: params.event,
		feedKey: params.feedKey,
		payload: params.payload,
		target,
	});
}

async function resolveGithubFeedTargetForConnection(params: {
	sql: DbClient;
	connectorKey: string;
	connectionId: number;
	organizationId: string;
	repo: { owner: string; name: string };
	feedKey: string;
}): Promise<{
	connectionId: number;
	feedId: number;
	owner: string;
	name: string;
} | null> {
	const { sql, connectorKey, connectionId, organizationId, repo, feedKey } =
		params;
	const [row] = await sql`
		SELECT f.id AS feed_id, f.connection_id,
		       f.config->>'repo_owner' AS repo_owner, f.config->>'repo_name' AS repo_name
		FROM feeds f
		JOIN connections c ON c.id = f.connection_id
		WHERE c.id = ${connectionId}
		  AND c.organization_id = ${organizationId}
		  AND c.connector_key = ${connectorKey}
		  AND c.status = 'active'
		  AND c.deleted_at IS NULL
		  AND f.feed_key = ${feedKey}
		  AND lower(f.config->>'repo_owner') = lower(${repo.owner})
		  AND lower(f.config->>'repo_name') = lower(${repo.name})
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
		LIMIT 1
	`;
	return row
		? {
				connectionId: Number(row.connection_id),
				feedId: Number(row.feed_id),
				owner: String(row.repo_owner),
				name: String(row.repo_name),
			}
		: null;
}

async function landGithubStarEvent(params: {
	sql: DbClient;
	connectorKey: string;
	organizationId: string;
	repo: { owner: string; name: string };
	event: string;
	feedKey: string;
	payload: unknown;
	target: {
		connectionId: number;
		feedId: number;
		owner: string;
		name: string;
	};
}): Promise<boolean> {
	const {
		sql,
		connectorKey,
		organizationId,
		event,
		feedKey,
		payload,
		target,
	} = params;
	const root =
		payload && typeof payload === "object"
			? (payload as Record<string, unknown>)
			: null;
	if (!root) return false;
	// `star` → action created/deleted; `watch` → action started. Only a NEW star
	// is landed; unstars/transient states are intentionally ignored.
	const action = strField(root, "action");
	if (event === "star" && action !== "created") return false;
	if (event === "watch" && action !== "started") return false;

	const actor = extractGithubActor(payload);
	if (!actor) return false;
	const { owner, name } = target;

	// origin_id mirrors the connector poll path (githubUserIdentityKey + sanitizer).
	const key = githubUserIdentityKey({
		userId: actor.author_id,
		login: actor.author_login,
	});
	const originId = `stargazer_${owner}_${name}_${githubKeyForOriginId(key)}`;
	const starredAt = strField(root, "starred_at") ?? new Date().toISOString();
	const profileUrl =
		strField(root.sender, "html_url") ??
		`https://github.com/${actor.author_login}`;

	// Resolve the actor → person so the star is attributed exactly like the poll.
	// Best-effort by design: a failure leaves the event unattributed (the poll
	// backstop re-resolves on its next run), but we log it so it isn't invisible.
	const resolution = await resolveGithubWebhookActor({
		organizationId,
		connectionId: target.connectionId,
		githubEvent: event,
		payload,
		sql,
	}).catch((error) => {
		logger.warn(
			{ event, originId, error: String(error) },
			"[app-webhook] github star actor resolution failed; storing unattributed",
		);
		return null;
	});

	await insertEvent(
		{
			organizationId,
			connectorKey,
			connectionId: target.connectionId,
			feedKey,
			feedId: target.feedId,
			originId,
			originType: "stargazer",
			semanticType: "content",
			title: `${actor.author_login} starred ${owner}/${name}`,
			authorName: actor.author_login,
			sourceUrl: profileUrl,
			occurredAt: starredAt,
			score: 1,
			entityIds: resolution?.entityIds ?? [],
			metadata: {
				action: "starred",
				starred_at: starredAt,
				source: "github_star_webhook",
				author_login: actor.author_login,
				...(actor.author_id ? { author_id: actor.author_id } : {}),
				...(resolution?.metadata ?? {}),
			},
		},
		{ onConflictUpdate: true },
	);
	return true;
}

/**
 * The CHAT-kind full-delivery hook: forward a verified delivery to the chat
 * adapter for its provider (the coordinator's routing chain — for Slack: BYO
 * connection → active OAuth install → preview → OAuth fallback, incl. the
 * url_verification challenge echo). Built separately so it can be injected via
 * {@link createDeclaredAppWebhookProvider}'s `handleDelivery`; the generic
 * provider still runs the declarative verify at the edge first. Provider-generic:
 * the caller supplies the per-provider forward (see
 * `ChatInstanceManager.handleChatAppWebhook`), so a new chat platform reuses this
 * unchanged.
 */
export function createChatWebhookDelivery(options: {
	/**
	 * Delegate to the chat adapter's full routing chain for the delivery's
	 * provider. Given the verified raw bytes + original headers, returns the
	 * adapter's Response.
	 */
	handleChatAppWebhook(request: Request): Promise<Response>;
}): NonNullable<AppWebhookProvider["handleDelivery"]> {
	return async ({ rawBody, headers, url, method }) => {
		// Reconstruct the verified delivery as a Request the coordinator can
		// re-read (it calls `request.text()` + reads content-type). The raw bytes
		// pass through unchanged so the adapter's own downstream `verifySignature`
		// over `v0:{ts}:{body}` still passes.
		const request = new Request(url, {
			method,
			headers,
			body:
				method === "GET" || method === "HEAD"
					? undefined
					: Buffer.from(rawBody),
		});
		return options.handleChatAppWebhook(request);
	};
}

/** Dependencies the router needs, injected at registration (testable). */
export interface AppWebhookRouterDeps {
	installationStore: AppInstallationStore;
	secretStore: SecretStore;
	/** Optional logger override for route-level verification tests. */
	logger?: Pick<typeof logger, "info" | "warn" | "error">;
	/** Provider plugins keyed by `provider` (the `:provider` path param). */
	providers: AppWebhookProvider[];
	/**
	 * Resolve the APP-LEVEL webhook secret for a provider. Returns undefined
	 * when no secret is configured — the router then fails closed (401), never
	 * accepting an unverifiable delivery.
	 */
	resolveAppWebhookSecret(provider: string): Promise<string | undefined>;
}

/**
 * Default app-webhook secret resolver. Resolution order per provider:
 *  1. the env var the connector DECLARES as `webhookSecretKey` (passed via
 *     `declaredSecretEnvKeys`), so the gateway holds NO provider-specific env
 *     literal and NO `<PROVIDER>_APP_WEBHOOK_SECRET` naming convention — the
 *     connector declaration is the single source of truth (e.g. Slack's signing
 *     secret IS its webhook secret, declared as `SLACK_SIGNING_SECRET`);
 *  2. a conventional secret-store ref (`secret://app-webhook/<provider>`) so
 *     prod can seal it like any other credential.
 * Plaintext env wins for local/dev parity (`.env` is the single source of truth).
 */
export function createDefaultAppWebhookSecretResolver(
	secretStore: SecretStore,
	declaredSecretEnvKeys: Record<string, string | undefined> = {},
): (provider: string) => Promise<string | undefined> {
	return async (provider) => {
		const declaredKey = declaredSecretEnvKeys[provider];
		if (declaredKey && process.env[declaredKey]) return process.env[declaredKey];
		return (await secretStore.get(`secret://app-webhook/${provider}`)) ?? undefined;
	};
}

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Build the public app-webhook router.
 *
 * Registered like the other public routes (`app.route("", ...)`), so it shares
 * the global `peerRemoteAddress` middleware var used for per-source rate
 * limiting in the landing path.
 */
export function createAppWebhookRoutes(deps: AppWebhookRouterDeps): Hono {
	const router = new Hono();
	const providers = new Map(deps.providers.map((p) => [p.provider, p]));
	const routeLogger = deps.logger ?? logger;

	router.post("/api/v1/app-webhooks/:provider", async (c) => {
		const providerName = c.req.param("provider");
		const provider = providers.get(providerName);
		if (!provider) {
			// Unknown provider: no plugin to verify with. 404, not 500.
			return json(404, { error: "Unknown webhook provider" });
		}

		// Read the raw body under the same cap as connection ingest. We need the
		// bytes BEFORE we can HMAC-verify (the signature is over the raw body) and
		// before we can extract the tenant, so this is a single capped read.
		const rawBody = await readBodyWithCap(c.req.raw, WEBHOOK_INGEST_MAX_BODY_BYTES);
		if (rawBody === null) {
			return json(413, { error: "Payload too large" });
		}

		// 1. Verify with the app-level secret. Fail closed when the secret is
		//    missing — an app-webhook endpoint must never accept unverifiable
		//    deliveries just because its secret went unconfigured.
		const appSecret = await deps.resolveAppWebhookSecret(providerName);
		if (!appSecret) {
			routeLogger.warn(
				{ provider: providerName },
				"[app-webhook] no app webhook secret configured — rejecting delivery",
			);
			return json(401, { error: "Unauthorized" });
		}
		if (!provider.verify(rawBody, c.req.raw.headers, appSecret)) {
			routeLogger.warn(
				{ provider: providerName },
				"[app-webhook] signature verification failed — rejecting delivery",
			);
			return json(401, { error: "Unauthorized" });
		}

		// 1b. Providers that own their own routing (Slack) take over here, after
		//     the edge signing check. They do NOT resolve an `app_installations`
		//     row — Slack's primary target is a BYO `connections` chat row
		//     (slug `agentconn-…`) that has no install row, so the generic
		//     resolveActiveByTenant would 200-ack the live bot's traffic into
		//     oblivion. They run their own precedence chain and return their own
		//     Response; the generic install/ingest pipeline below is skipped entirely.
		if (provider.handleDelivery) {
			try {
				return await provider.handleDelivery({
					rawBody,
					headers: c.req.raw.headers,
					url: c.req.raw.url,
					method: c.req.raw.method,
				});
			} catch (error) {
				routeLogger.error(
					{ provider: providerName, error: String(error) },
					"[app-webhook] handleDelivery failed",
				);
				return json(500, { error: "Failed to handle delivery" });
			}
		}

		// 2. Extract the provider tenant tuple. A delivery with no resolvable
		//    tenant (e.g. an app-level ping) is acked without landing.
		const tenant = provider.extractTenant(rawBody, c.req.raw.headers);
		if (!tenant) {
			routeLogger.info(
				{ provider: providerName },
				"[app-webhook] delivery carries no tenant — acked without landing",
			);
			return json(200, { ok: true, landed: false });
		}

		// 3. Resolve the active installation for the tuple → owning org. A miss
		//    means the delivery arrived before the install callback wrote the row
		//    (§4.3.4): ack 200 + log, never 500 — the provider must not retry-storm,
		//    and the install reconciles on its callback.
		const install = await deps.installationStore.resolveActiveByTenant({
			provider: providerName,
			providerInstance: tenant.providerInstance,
			providerAppId: tenant.providerAppId,
			externalTenantId: tenant.externalTenantId,
		});
		if (!install) {
			routeLogger.info(
				{
					provider: providerName,
					providerInstance: tenant.providerInstance,
					providerAppId: tenant.providerAppId,
					externalTenantId: tenant.externalTenantId,
				},
				"[app-webhook] no active installation for tenant — acked, awaiting install callback",
			);
			return json(200, { ok: true, landed: false });
		}

		// 4. Structured-delivery providers handle the delivery as a sync signal
		//    (GitHub: resolve identity + mark the affected repo's feeds due, no raw
		//    event — the poll stays the canonical record, so push and backfill are
		//    one consolidated dataset) or as a structured connector event (Jira →
		//    Rovo issues feed). A handler may return handled:false when its target
		//    is not configured yet; that falls through to the raw store below,
		//    preserving the staged migration (Atlassian Rovo before the legacy Jira
		//    connector is removed). Providers without onDelivery (linear) fall
		//    through the same way.
		if (provider.onDelivery) {
			try {
				const { triggered, handled } = await provider.onDelivery({
					rawBody,
					headers: c.req.raw.headers,
					install,
					sql: getDb(),
				});
				if (handled !== false) {
					return json(200, { ok: true, triggered });
				}
			} catch (error) {
				routeLogger.error(
					{ provider: providerName, installationId: install.id, error: String(error) },
					"[app-webhook] onDelivery trigger failed",
				);
				return json(500, { error: "Failed to handle delivery" });
			}
		}

		// 5. Land the RAW delivery through the same event-log path as connection
		//    ingest. We synthesize a StoredConnection scoped to the install's org
		//    and keyed on the install id, replaying the PROVIDER's signature scheme
		//    (from `provider.webhookScheme`, not a hardcoded GitHub one) with the
		//    app secret as a plaintext config value so handleWebhookIngest
		//    re-verifies and lands under connector_key='webhook:app_install:<id>'
		//    (matches the `webhook:%` dedupe index + size cap + rate limit). A
		//    fresh Request carries the same raw bytes + headers; the original body
		//    stream was already consumed above.
		const scheme = provider.webhookScheme;
		const synthesized: StoredConnection = {
			id: `app_install:${install.id}`,
			platform: "webhook",
			organizationId: install.organizationId,
			config: {
				platform: "webhook",
				// Replay the provider's HMAC scheme so the ingest handler's own verify
				// passes against the app secret (plaintext passes resolveSecretValue
				// through untouched). Providers without a per-delivery id header
				// (Jira/Linear) omit dedupeHeader → ingest dedupes on a body hash.
				signatureHeader: scheme.signatureHeader,
				algorithm: scheme.algorithm,
				...(scheme.signaturePrefix
					? { signaturePrefix: scheme.signaturePrefix }
					: {}),
				signatureSecret: appSecret,
				...(scheme.dedupeHeader ? { dedupeHeader: scheme.dedupeHeader } : {}),
				semanticType: "content",
			},
			settings: {},
			metadata: {},
			status: "active",
			createdAt: install.createdAt,
			updatedAt: install.updatedAt,
		};

		const ingestRequest = new Request(c.req.raw.url, {
			method: "POST",
			headers: c.req.raw.headers,
			body: rawBody,
		});

		// Title/source_url for the landed row; a miss leaves them empty.
		const content = provider.extractContent?.(rawBody, c.req.raw.headers);

		// Resolution runs lazily inside handleWebhookIngest on the winning insert
		// only — resolving here would mutate the graph for deduped redeliveries.
		// `sql` is the persist transaction, threaded so the actor writes are atomic.
		const resolveActor = provider.resolveActor
			? (sql: DbClient) =>
					provider.resolveActor!({
						organizationId: install.organizationId,
						rawBody,
						headers: c.req.raw.headers,
						sql,
					})
			: undefined;

		try {
			return await handleWebhookIngest(
				synthesized,
				ingestRequest,
				deps.secretStore,
				c.var.peerRemoteAddress,
				content || resolveActor
					? {
							title: content?.title,
							sourceUrl: content?.sourceUrl,
							resolveActor,
						}
					: undefined,
			);
		} catch (error) {
			routeLogger.error(
				{ provider: providerName, installationId: install.id, error: String(error) },
				"[app-webhook] failed to land delivery",
			);
			return json(500, { error: "Failed to land delivery" });
		}
	});

	return router;
}
