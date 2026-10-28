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
 *   1. verifies the delivery with the APP-LEVEL secret (provider plugin), or
 *      with the provider-signed token its connector declares (`verification`), then
 *   2. extracts the provider tenant tuple (provider_instance, provider_app_id,
 *      external_tenant_id) from the body/headers (provider plugin), then
 *   3. resolves the active `app_installations` row for that tuple → owning org,
 *      then dispatches through the connector's declared data hook: the feeds
 *      that declare the delivery's event type are marked due or recorded. A
 *      delivery no feed declares is acked with nothing triggered; nothing is
 *      ever stored raw.
 *
 * Verification + tenant extraction are GENERIC, derived entirely from the
 * connector's `ConnectorWebhookSchema`: {@link verifyDeclaredWebhook} computes
 * HMAC over the declared `signingBaseTemplate` (default `{body}` for
 * GitHub/Jira/Linear; `v0:{timestamp}:{body}` + freshness for Slack),
 * {@link verifyGoogleJwtWebhook} checks a declared provider-signed bearer
 * token (Google Chat), and {@link extractTenantFromSchema} reads the tenant
 * from the declared `routingKeyPath(s)` (+ optional `url-host` transform for
 * Jira). There is NO per-provider verify or extractor and NO provider-name
 * branch — one engine, one builder ({@link createDeclaredAppWebhookProvider}).
 *
 * Delivery before the install callback: a provider may deliver before the
 * OAuth/install callback has written the `app_installations` row. That is NOT
 * an error — we ack 200 and log, so the provider doesn't retry-storm; the
 * install reconciles on the callback and subsequent deliveries land. (§4.3.4)
 *
 * Multi-replica: stateless by construction — verify is pure, tenant resolution
 * and the feed dispatch read/write Postgres only; nothing is memoized per pod.
 * Any replica can serve any delivery.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify } from "jose";
import { createLogger } from "@lobu/core";
import type {
	ConnectorWebhookGoogleJwtVerification,
	ConnectorWebhookSchema,
} from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../../../db/client.js";
import {
	type ConnectorRecordJob,
	deliverConnectorWebhook,
	deliveryScalar,
	readDeliveryPath,
} from "../../../connectors/webhook-delivery.js";
import {
	readBodyWithCap,
	WEBHOOK_INGEST_MAX_BODY_BYTES,
} from "../../connections/webhook-ingest.js";
import type { SecretStore } from "../../secrets/index.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";

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
 * A registered provider: verifier + tenant extractor + optional per-KIND
 * delivery hooks. Every integration provider is built by the SINGLE generic
 * {@link createDeclaredAppWebhookProvider} from its declared
 * {@link ConnectorWebhookSchema} — no per-provider verify/extractor code. A new
 * provider is a connector DECLARATION, not a new plugin in this file.
 */
export interface AppWebhookProvider {
	provider: string;
	/**
	 * Verify the delivery against the APP-LEVEL webhook secret. Pure over
	 * (rawBody, headers, secret) — no I/O — so it's trivially multi-replica
	 * safe. Returns false on any miss (the router fails closed with 401).
	 */
	verify(
		rawBody: Uint8Array,
		headers: Headers,
		appWebhookSecret: string,
	): boolean | Promise<boolean>;
	/**
	 * False when `verify` authenticates without an app webhook secret (a
	 * provider-signed token). Default true: a missing secret fails closed.
	 */
	requiresAppSecret?: boolean;
	/**
	 * Pull the provider tenant tuple from the body/headers. Returns null when
	 * the delivery carries no resolvable tenant (e.g. a ping with no
	 * installation), in which case the router acks 200 without dispatching.
	 */
	extractTenant(rawBody: Uint8Array, headers: Headers): AppWebhookTenant | null;
	/**
	 * Optional: the declared feed dispatch (see
	 * {@link createDataWebhookDelivery}). `triggered` reports whether a feed was
	 * marked due or a record job queued (telemetry only — the router acks 200
	 * either way; an unconfigured feed is a no-op, not an error). A provider
	 * without it acks every delivery with nothing triggered.
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
	}): Promise<{ triggered: boolean }>;
	/**
	 * Optional: take over the ENTIRE delivery after `verify`, bypassing the
	 * router's `extractTenant` → `resolveActiveByTenant` (`app_installations`) →
	 * feed dispatch. A provider that defines this owns its own routing AND its
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
	 *  - A delivery is forwarded to a running adapter, not dispatched to feeds.
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

const GOOGLE_OIDC_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
// The skew google-auth-library (and so the Chat SDK) tolerates.
const GOOGLE_CLOCK_SKEW_SECONDS = 300;
// jose, not the transitive google-auth-library: one remote-JWKS verifier with
// built-in caching covers both audiences, where google-auth-library needs a
// hand-rolled x509 cert fetch and TTL for the self-signed project-number token.
// jose caches each key set and refetches on an unknown `kid` (rate-limited),
// so Google's key rotation needs no TTL of our own.
const googleKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function googleKeySet(url: string): ReturnType<typeof createRemoteJWKSet> {
	let keys = googleKeySets.get(url);
	if (!keys) {
		keys = createRemoteJWKSet(new URL(url));
		googleKeySets.set(url, keys);
	}
	return keys;
}

// jose's own error codes for a key set it could not obtain: a non-200 or
// unparseable response (the generic code), a timeout, or a malformed document.
// A network failure surfaces as a non-jose error. Every other jose code is a
// verdict on the token itself.
const KEY_SET_UNAVAILABLE_CODES = new Set([
	errors.JOSEError.code,
	errors.JWKSTimeout.code,
	errors.JWKSInvalid.code,
]);

function logGoogleJwtRejection(audience: "app_id" | "endpoint_url", error: unknown): void {
	const code = error instanceof errors.JOSEError ? error.code : undefined;
	const keySetUnavailable = code === undefined || KEY_SET_UNAVAILABLE_CODES.has(code);
	// Never the token or its claims: only which check failed and why.
	logger.warn(
		keySetUnavailable
			? "Google key set unavailable; webhook rejected"
			: "Google-signed webhook token rejected",
		{
			audience,
			reason: keySetUnavailable ? "key_set_unavailable" : "token_rejected",
			code: code ?? (error instanceof Error ? error.name : typeof error),
			message: error instanceof Error ? error.message : String(error),
		},
	);
}

/**
 * THE generic Google-signed bearer verifier for `verification.type:
 * 'google-jwt'`. Accepts either declared audience: a token self-signed by a
 * declared signer for the app id (checked against that service account's
 * published keys), or a Google OIDC ID token for the endpoint URL whose verified
 * `email` is a declared signer. Returns false on any miss.
 */
async function verifyGoogleJwtWebhook(
	headers: Headers,
	verification: ConnectorWebhookGoogleJwtVerification,
	target: { appId: string; endpointUrl?: string },
): Promise<boolean> {
	const authorization = headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	const token = authorization.slice("Bearer ".length).trim();
	const signers = verification.signers.map((signer) =>
		signer.replaceAll("{appId}", target.appId),
	);
	let issuer: unknown;
	try {
		issuer = decodeJwt(token).iss;
	} catch {
		return false;
	}
	if (typeof issuer !== "string") return false;
	// Pick the declared audience the issuer can sign for: a declared signer
	// self-signs for the app id; Google's OIDC issuers sign for the endpoint.
	const audience =
		verification.audiences.includes("app_id") && signers.includes(issuer)
			? "app_id"
			: verification.audiences.includes("endpoint_url") &&
					target.endpointUrl &&
					GOOGLE_OIDC_ISSUERS.includes(issuer)
				? "endpoint_url"
				: null;
	if (!audience) return false;
	try {
		if (audience === "app_id") {
			await jwtVerify(
				token,
				googleKeySet(
					`https://www.googleapis.com/service_accounts/v1/jwk/${encodeURIComponent(issuer)}`,
				),
				{ issuer, audience: target.appId, clockTolerance: GOOGLE_CLOCK_SKEW_SECONDS },
			);
			return true;
		}
		const { payload } = await jwtVerify(
			token,
			googleKeySet("https://www.googleapis.com/oauth2/v3/certs"),
			{
				issuer: GOOGLE_OIDC_ISSUERS,
				audience: target.endpointUrl,
				clockTolerance: GOOGLE_CLOCK_SKEW_SECONDS,
			},
		);
		return (
			payload.email_verified === true &&
			typeof payload.email === "string" &&
			signers.includes(payload.email)
		);
	} catch (error) {
		logGoogleJwtRejection(audience, error);
		return false;
	}
}

/**
 * THE generic tenant extractor. Reads the external tenant id from the body via
 * the schema's ordered `routingKeyPaths` (or single `routingKeyPath`), first
 * non-empty match wins, then applies the declared `routingKeyTransform`
 * (`url-host` → the value's URL host, for Jira's `self` URLs). Returns null when
 * no path resolves (e.g. an app-level ping) → the router acks without dispatching.
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
	/** Optional per-KIND trigger handler (see {@link AppWebhookProvider.onDelivery}). */
	onDelivery?: AppWebhookProvider["onDelivery"];
	/** Optional per-KIND full-delivery takeover (chat adapters; {@link AppWebhookProvider.handleDelivery}). */
	handleDelivery?: AppWebhookProvider["handleDelivery"];
	/** This provider's public endpoint URL, the `endpoint_url` JWT audience. */
	endpointUrl?: string;
}): AppWebhookProvider {
	const { provider, appId, webhookSchema, providerInstance } = options;
	const verification = webhookSchema.verification;
	if (!webhookSchema.signatureHeader && !verification) {
		throw new Error(
			`App-webhook provider "${provider}" requires a webhook signatureHeader ` +
				`or a declared verification (a non-signing provider can't be verified — fail closed).`,
		);
	}
	return {
		provider,
		...(verification
			? {
					requiresAppSecret: false,
					verify: (_rawBody: Uint8Array, headers: Headers) =>
						verifyGoogleJwtWebhook(headers, verification, {
							appId,
							endpointUrl: options.endpointUrl,
						}),
				}
			: {
					verify: (rawBody: Uint8Array, headers: Headers, appWebhookSecret: string) =>
						verifyDeclaredWebhook(rawBody, headers, appWebhookSecret, webhookSchema),
				}),
		extractTenant(rawBody) {
			return extractTenantFromSchema(
				rawBody,
				webhookSchema,
				appId,
				providerInstance,
			);
		},
		...(options.onDelivery ? { onDelivery: options.onDelivery } : {}),
		...(options.handleDelivery ? { handleDelivery: options.handleDelivery } : {}),
	};
}

/**
 * Resolve the DATA-kind delivery hook for a connector, selected by what it
 * DECLARES — never a provider-name branch in the gateway wiring. A connector
 * whose webhook schema names an `eventType` dispatches generically to the
 * installation's feeds that declare the event (invalidate, or record through
 * the feed's `normalize`). A connector that names no event type has no hook:
 * its deliveries are verified, routed and acked with nothing triggered.
 */
export function createDataWebhookDelivery(
	integration: { connectorKey: string; webhookSchema: ConnectorWebhookSchema },
	enqueueRecord: (job: ConnectorRecordJob) => Promise<unknown>,
): AppWebhookProvider["onDelivery"] | undefined {
	const { connectorKey, webhookSchema } = integration;
	const eventType = webhookSchema.eventType;
	if (!eventType) return undefined;
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
 * Registered like the other public routes (`app.route("", ...)`).
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
		//    deliveries just because its secret went unconfigured. A provider-
		//    signed token (declared `verification`) needs no secret.
		let appSecret = "";
		if (provider.requiresAppSecret !== false) {
			const secret = await deps.resolveAppWebhookSecret(providerName);
			if (!secret) {
				routeLogger.warn(
					{ provider: providerName },
					"[app-webhook] no app webhook secret configured — rejecting delivery",
				);
				return json(401, { error: "Unauthorized" });
			}
			appSecret = secret;
		}
		if (!(await provider.verify(rawBody, c.req.raw.headers, appSecret))) {
			routeLogger.warn(
				{ provider: providerName },
				"[app-webhook] signature verification failed — rejecting delivery",
			);
			return json(401, { error: "Unauthorized" });
		}

		// 1b. Providers that own their own routing (chat adapters: Slack, Google
		//     Chat) take over here, after the edge signing check. They do NOT
		//     resolve an `app_installations` row — Slack's primary target is a
		//     BYO `connections` chat row (slug `agentconn-…`) that has no install
		//     row, so the generic resolveActiveByTenant would 200-ack the live
		//     bot's traffic into oblivion. They run their own precedence chain
		//     and return their own Response; the generic install/dispatch
		//     pipeline below is skipped entirely.
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

		// 4. Dispatch to the feeds that declare the delivery's event (marked due
		//    or recorded; the poll stays the canonical record and resolves
		//    identity). A connector with no data hook, or a delivery no feed
		//    declares, is acked with nothing triggered — nothing is stored raw.
		if (!provider.onDelivery) {
			return json(200, { ok: true, triggered: false });
		}
		try {
			const { triggered } = await provider.onDelivery({
				rawBody,
				headers: c.req.raw.headers,
				install,
				sql: getDb(),
			});
			return json(200, { ok: true, triggered });
		} catch (error) {
			routeLogger.error(
				{ provider: providerName, installationId: install.id, error: String(error) },
				"[app-webhook] onDelivery trigger failed",
			);
			return json(500, { error: "Failed to handle delivery" });
		}
	});

	return router;
}
