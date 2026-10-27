/**
 * Resolve app-installation credentials from the connector's DECLARED auth schema
 * instead of hardcoding `process.env.GITHUB_*` / `SLACK_*` literals in the server.
 *
 * The connector's `app_installation` method declares the *names* of the env vars
 * that hold each credential (`appIdKey`, `privateKeyKey`, `appSlugKey`,
 * `clientIdKey`, `clientSecretKey`, `webhookSecretKey`) plus the `installUrlTemplate`.
 * This module reads those declared names and returns the resolved values, so the
 * server holds no provider-specific env literal.
 *
 * Two sources, by context (this split fixes the prior compile-in-route fragility):
 *  - PER-ORG ROUTES (have an orgId): read the method from the org's
 *    `connector_definitions.auth_schema` row — the same declaration the install UI
 *    seeded and the hourly refresh-cron keeps synced from bundled source. No
 *    connector compile in a request path.
 *  - ORG-LESS STARTUP (gateway wiring): prime from the bundled connector on disk
 *    once at boot, then read synchronously. Env-var names are deployment-wide
 *    constants, so one resolve per (connectorKey, provider) per process is correct.
 */

import type {
	ConnectorAuthAppInstallation,
	ConnectorWebhookSchema,
} from "@lobu/connector-sdk";
import { getDb } from "../../db/client.js";
import {
	getAppInstallationAuthMethods,
	getOAuthAuthMethods,
	normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import {
	compileConnectorForIsolateFromFile,
	findBundledConnectorFile,
	listCatalogConnectorDefinitions,
} from "../../utils/connector-catalog.js";
import { extractConnectorMetadata } from "../../utils/connector-compiler.js";

function pickMethod(
	authSchema: unknown,
	provider?: string,
): ConnectorAuthAppInstallation | null {
	const methods = getAppInstallationAuthMethods(
		normalizeConnectorAuthSchema(authSchema),
	);
	return methods.find((m) => !provider || m.provider === provider) ?? null;
}

/**
 * The declared `app_installation` method for a connector AS INSTALLED FOR ONE ORG
 * (read from `connector_definitions.auth_schema`). The per-org row is the source
 * of truth for routes — never compile the bundled connector in a request path.
 */
export async function getOrgAppInstallationMethod(
	organizationId: string,
	connectorKey: string,
	provider?: string,
): Promise<ConnectorAuthAppInstallation | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT auth_schema FROM connector_definitions
		WHERE key = ${connectorKey}
			AND organization_id = ${organizationId}
			AND status = 'active'
		LIMIT 1
	`) as unknown as Array<{ auth_schema: unknown }>;
	if (rows.length === 0) return null;
	return pickMethod(rows[0].auth_schema, provider);
}

// ---- org-less startup path (bundled connector) ----------------------------

const bundledMethodCache = new Map<
	string,
	ConnectorAuthAppInstallation | null
>();

async function resolveBundledMethod(
	connectorKey: string,
	provider?: string,
): Promise<ConnectorAuthAppInstallation | null> {
	const cacheKey = `${connectorKey}::${provider ?? ""}`;
	const cached = bundledMethodCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const file = findBundledConnectorFile(connectorKey);
	if (!file) {
		bundledMethodCache.set(cacheKey, null);
		return null;
	}
	const code = await compileConnectorForIsolateFromFile(file);
	const metadata = await extractConnectorMetadata(code);
	const method = pickMethod(metadata.authSchema, provider);
	bundledMethodCache.set(cacheKey, method);
	return method;
}

/**
 * Synchronous read of a primed bundled-connector method, for synchronous wiring
 * (gateway route registration). Returns undefined when not primed — callers must
 * {@link primeAppInstallationMethods} during async boot first.
 */
export function getPrimedBundledMethod(
	connectorKey: string,
	provider?: string,
): ConnectorAuthAppInstallation | null | undefined {
	return bundledMethodCache.get(`${connectorKey}::${provider ?? ""}`);
}

/** Warm the bundled-method cache at async boot so sync gateway wiring can read it. */
export async function primeAppInstallationMethods(
	specs: Array<{ connectorKey: string; provider?: string }>,
): Promise<void> {
	await Promise.all(
		specs.map(async (spec) => {
			try {
				await resolveBundledMethod(spec.connectorKey, spec.provider);
			} catch {
				// leave unprimed; getPrimedBundledMethod returns undefined
			}
		}),
	);
}

/**
 * One bundled integration connector that receives app-level webhook deliveries:
 * its key, its declared app-installation auth method (when it declares one), and
 * its declared webhook schema. Drives data-driven app-webhook provider
 * registration — the gateway iterates these instead of a hardcoded provider list.
 */
export interface BundledIntegrationConnector {
	connectorKey: string;
	provider: string;
	/**
	 * Connector classification: `'integration'` (pure app/auth, no feeds — Slack)
	 * vs `'data'` (default — GitHub/Jira/Linear poll + receive data webhooks). The
	 * delivery DISPATCH keys off the webhook's `deliveryKind`, not this — `kind`
	 * records what the connector IS (captured from its declaration).
	 */
	kind: "data" | "integration";
	/** The app-installation auth method, when the connector declares one (github/slack). */
	method: ConnectorAuthAppInstallation | null;
	/** The declared webhook schema (signing scheme + routing + deliveryKind). */
	webhookSchema: ConnectorWebhookSchema;
	/**
	 * Resolved Lobu App id (`provider_app_id`), read from the connector's declared
	 * env-var name: the app-installation method's `appIdKey` (github), else its /
	 * the OAuth method's `clientIdKey` (slack/jira/linear). Undefined when the
	 * deployment hasn't configured the app id → that provider isn't registered.
	 */
	appId?: string;
	/** Declared env-var name holding the app-webhook secret, when declared (slack: SLACK_SIGNING_SECRET). */
	webhookSecretKey?: string;
}

/**
 * Discover every bundled connector whose webhook declares
 * `delivery: 'app_installation'` and prime it, returning one
 * {@link BundledIntegrationConnector} per declaration. This is the single source
 * the gateway iterates to register app-webhook providers — no hardcoded
 * github/slack/jira/linear list, no provider-name branch. `provider` comes from
 * the connector's app-installation method when present, else its connector key
 * (jira/linear authenticate via OAuth but still receive app-level webhooks).
 */
export async function primeBundledIntegrationConnectors(): Promise<
	BundledIntegrationConnector[]
> {
	const defs = await listCatalogConnectorDefinitions();
	// Narrow to candidates BEFORE compiling. The catalog manifest already carries
	// each connector's `webhook` block, so we can pick the (few) connectors that
	// declare `delivery: 'app_installation'` without spawning a metadata-extract
	// subprocess for all ~37 bundled connectors — that bulk compile is slow and,
	// under boot load, races the 30s per-connector extract timeout (a swallowed
	// timeout silently dropped a real provider). When the manifest predates the
	// `webhook` field (no candidate carries one), fall back to scanning all.
	const declared = defs.filter(
		(d) =>
			(d.webhook as ConnectorWebhookSchema | null)?.delivery ===
			"app_installation",
	);
	const candidates = declared.length > 0 ? declared : defs;
	const result: BundledIntegrationConnector[] = [];
	for (const def of candidates) {
		const file = findBundledConnectorFile(def.key);
		if (!file) continue;
		let webhookSchema: ConnectorWebhookSchema | null = null;
		let method: ConnectorAuthAppInstallation | null = null;
		try {
			const code = await compileConnectorForIsolateFromFile(file);
			const metadata = await extractConnectorMetadata(code);
			webhookSchema =
				(metadata.webhook as ConnectorWebhookSchema | null) ?? null;
			if (!webhookSchema || webhookSchema.delivery !== "app_installation") {
				continue;
			}
			const authSchema = normalizeConnectorAuthSchema(metadata.authSchema);
			method = pickMethod(metadata.authSchema);
			const oauth = getOAuthAuthMethods(authSchema)[0];
			const provider = method?.provider ?? def.key;
			// The Lobu App id (`provider_app_id`) is the GitHub App id when the
			// connector declares an app_installation method with `appIdKey`, else the
			// OAuth client id (slack/jira/linear), else the app id a provider-signed
			// `verification` declares (a Google Cloud project number). Read by the
			// DECLARED env-var name — no hardcoded `process.env.GITHUB_APP_ID`/`JIRA_CLIENT_ID` literal.
			const appIdKey =
				method?.appIdKey ??
				method?.clientIdKey ??
				oauth?.clientIdKey ??
				webhookSchema.verification?.appIdKey;
			const appId = appIdKey ? process.env[appIdKey] : undefined;
			const webhookSecretKey = method?.webhookSecretKey;
			// Cache the resolved method for synchronous wiring accessors.
			bundledMethodCache.set(`${def.key}::${provider}`, method);
			bundledMethodCache.set(`${def.key}::`, method);
			const kind = metadata.kind === "integration" ? "integration" : "data";
			result.push({
				connectorKey: def.key,
				provider,
				kind,
				method,
				webhookSchema,
				...(appId ? { appId } : {}),
				...(webhookSecretKey ? { webhookSecretKey } : {}),
			});
		} catch {
			// Skip connectors that fail to compile/extract; they simply won't be
			// registered as app-webhook providers.
		}
	}
	return result;
}

/** Test-only: drop the primed bundled methods. */
export function clearBundledMethodCache(): void {
	bundledMethodCache.clear();
}

// ---- pure credential resolution -------------------------------------------

export interface ResolvedAppInstallCredentials {
	appId?: string;
	privateKey?: string;
	appSlug?: string;
	clientId?: string;
	clientSecret?: string;
	webhookSecret?: string;
	installUrlTemplate?: string;
	/** Declared env-var names, stamped onto the install row so token minting reads the right vars. */
	appIdKey?: string;
	privateKeyKey?: string;
	/** Declared env-var name for the app-webhook secret (so the webhook resolver prefers it). */
	webhookSecretKey?: string;
}

/** Read each declared credential env var by the NAME the connector declares. */
export function resolveAppInstallCredentials(
	method: ConnectorAuthAppInstallation,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedAppInstallCredentials {
	const read = (key?: string): string | undefined =>
		key ? env[key] : undefined;
	return {
		appId: read(method.appIdKey),
		privateKey: read(method.privateKeyKey),
		appSlug: read(method.appSlugKey),
		clientId: read(method.clientIdKey),
		clientSecret: read(method.clientSecretKey),
		webhookSecret: read(method.webhookSecretKey),
		installUrlTemplate: method.installUrlTemplate,
		appIdKey: method.appIdKey,
		privateKeyKey: method.privateKeyKey,
		webhookSecretKey: method.webhookSecretKey,
	};
}

/**
 * Build the App install URL from the connector's declared `installUrlTemplate`,
 * substituting `{{app_slug}}` and stamping the CSRF `state`. Null when no template.
 */
export function renderAppInstallUrl(
	template: string | undefined,
	appSlug: string | undefined,
	state: string,
): string | null {
	if (!template) return null;
	const filled = template.replace(
		/\{\{\s*app_slug\s*\}\}/g,
		encodeURIComponent(appSlug ?? ""),
	);
	const url = new URL(filled);
	url.searchParams.set("state", state);
	return url.toString();
}
