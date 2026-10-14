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
 *      then dispatches through the connector's declared data hook (feeds that
 *      declare the delivery's event type), or else lands the raw delivery
 *      through the SAME event-log path as the per-connection ingest
 *      (`connector_key='webhook:<id>'`, reusing the dedupe index, size cap, and
 *      rate limit).
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

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createLogger } from "@lobu/core";
import type { StoredConnection } from "@lobu/core";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../../../db/client.js";
import {
	type ConnectorRecordJob,
	deliverConnectorWebhook,
	deliveryScalar,
	readDeliveryPath,
} from "../../../connectors/webhook-delivery.js";
import {
	handleWebhookIngest,
	readBodyWithCap,
	WEBHOOK_INGEST_MAX_BODY_BYTES,
} from "../../connections/webhook-ingest.js";
import type { SecretStore } from "../../secrets/index.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
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
	 * Optional: handle the delivery itself instead of storing a raw event —
	 * the declared feed dispatch (see {@link createDataWebhookDelivery}) or the
	 * Jira → Rovo hook. `triggered` reports whether a feed was marked due or a
	 * record committed (telemetry only — the router acks 200 either way; an
	 * unconfigured feed is a no-op, not an error). `handled: false` falls
	 * through to the raw ingest path.
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
		// Numbers are stringified (GitHub installation ids are integers).
		const raw = deliveryScalar(readDeliveryPath(body, path));
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

/**
 * Resolve the DATA-kind delivery hook for a connector, selected by what it
 * DECLARES — never a provider-name branch in the gateway wiring. A connector
 * whose webhook schema names an `eventType` dispatches generically to the
 * installation's feeds that declare the event (invalidate, or record through
 * the feed's `normalize`). Jira routes matching sites to Atlassian Rovo issue
 * feeds and explicitly falls through while no Rovo feed exists. Everything
 * else has no hook, so the router falls through to the raw event-ingest path.
 */
export function createDataWebhookDelivery(
	integration: { connectorKey: string; webhookSchema: ConnectorWebhookSchema },
	enqueueRecord: (job: ConnectorRecordJob) => Promise<unknown>,
): AppWebhookProvider["onDelivery"] | undefined {
	const { connectorKey, webhookSchema } = integration;
	const eventType = webhookSchema.eventType;
	if (eventType) {
		return ({ rawBody, headers, install, sql }) =>
			deliverConnectorWebhook({
				sql,
				rawBody,
				headers,
				eventType,
				organizationId: install.organizationId,
				connectorKey,
				scope: { installationRef: String(install.id) },
				enqueueRecord,
			});
	}
	if (connectorKey === "jira") return createJiraWebhookDelivery();
	return undefined;
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

		// 4. Data hooks handle the delivery without a raw event: the declared
		//    feed dispatch (feeds marked due or recorded; the poll stays the
		//    canonical record and resolves identity) or Jira → Rovo issues. A
		//    handler may return handled:false when its target is not configured
		//    yet; that falls through to the raw store below, as do providers
		//    without onDelivery.
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
