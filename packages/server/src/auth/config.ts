import { getDb } from "../db/client";
import type { Env } from "../index";
import {
	getPrimaryAuthProfileForKind,
	normalizeAuthValues,
} from "../utils/auth-profiles";
import { listCatalogConnectorDefinitions } from "../utils/connector-catalog";
import { TtlCache } from "../utils/ttl-cache";
import { safeParseUrl } from "./base-url";

interface AuthConfig {
	social: Record<string, boolean>;
	/** Connector display metadata; keys mirror the enabled providers in `social`. */
	socialMeta: Record<string, { name: string; faviconDomain: string | null }>;
	magicLink: boolean;
	phone: boolean;
	emailPassword: boolean;
	passkey: boolean;
	// True iff this deployment runs in single-user mode (LOBU_SINGLE_USER=1).
	// The SPA branches signup/sign-in copy on this — "Set up your local install"
	// vs "Sign up for Lobu" — and skips affordances that don't apply.
	singleUserMode: boolean;
	// True iff at least one (non-legacy-bootstrap) user already exists. The SPA
	// routes `/` → /sign-up when this is false in single-user mode, so the
	// operator lands on the right page on first launch without typing a URL.
	hasUser: boolean;
}

type TokenEndpointAuthMethod =
	| "client_secret_post"
	| "client_secret_basic"
	| "none";

export interface EnabledLoginProviderConfig {
	connectorKey: string;
	provider: string;
	displayName: string;
	faviconDomain: string | null;
	loginScopes: string[];
	clientIdKey: string;
	clientSecretKey: string;
	authorizationUrl?: string;
	tokenUrl?: string;
	userinfoUrl?: string;
	tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
	/** PKCE for non-OIDC / public-client OAuth2 flows. */
	usePkce?: boolean;
	/** Extra params merged into the authorization URL (e.g. `prompt`, `access_type`). */
	authParams?: Record<string, string>;
}

interface AuthConfigOptions {
	request?: Request;
	organizationId?: string | null;
}

type OAuthMethod = {
	type: string;
	provider?: string;
	requiredScopes?: string[];
	loginScopes?: string[];
	clientIdKey?: string;
	clientSecretKey?: string;
	authorizationUrl?: string;
	tokenUrl?: string;
	userinfoUrl?: string;
	tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
	usePkce?: boolean;
	authParams?: Record<string, string>;
	loginProvisioning?: {
		autoCreateConnection?: boolean;
	};
};

type LoginProviderConfigRow = {
	key: string;
	name?: string | null;
	favicon_domain?: string | null;
	auth_schema: { methods?: OAuthMethod[] } | string | null;
};

function normalizeScopes(
	scopes: readonly string[] | undefined,
): string[] | null {
	if (!scopes) return null;
	const normalized = scopes
		.map((scope) => scope.trim())
		.filter((scope) => scope.length > 0);
	return normalized.length > 0 ? normalized : null;
}

/**
 * Returns the login scopes declared by the connector method, or null if none.
 * Login support is connector-owned: a connector opts into sign-in by declaring
 * `loginScopes` on its oauth method. Core never assumes scopes for a provider.
 */
export function getLoginProviderScopes(
	_provider: string,
	explicitScopes?: readonly string[],
): string[] | null {
	return normalizeScopes(explicitScopes);
}

function getOAuthMethodsFromSchema(
	authSchema: LoginProviderConfigRow["auth_schema"],
): OAuthMethod[] {
	const parsedAuthSchema =
		typeof authSchema === "string"
			? (() => {
					try {
						return JSON.parse(authSchema) as { methods?: OAuthMethod[] };
					} catch {
						return null;
					}
				})()
			: authSchema;

	return parsedAuthSchema?.methods ?? [];
}

export function collectEnabledLoginProviderConfigs(
	rows: LoginProviderConfigRow[],
	// The catalog-derived baseline scans EVERY bundled connector, so it expects to
	// see OAuth connectors without login scopes (e.g. read-only feed connectors)
	// and several connectors per provider (calendar/gmail/youtube all = google).
	// Those are normal there, not misconfiguration — `quiet` suppresses the warns
	// that are only meaningful for an explicit per-org `login_enabled` set.
	options: { quiet?: boolean } = {},
): EnabledLoginProviderConfig[] {
	const configs: EnabledLoginProviderConfig[] = [];
	const seenProviders = new Map<string, string>();

	for (const row of rows) {
		const connectorKey = String(row.key);
		const methods = getOAuthMethodsFromSchema(row.auth_schema);

		for (const method of methods) {
			if (method.type !== "oauth" || typeof method.provider !== "string")
				continue;

			const provider = method.provider.trim().toLowerCase();
			if (!provider) continue;

			const loginScopes = getLoginProviderScopes(provider, method.loginScopes);
			if (!loginScopes || loginScopes.length === 0) {
				if (!options.quiet) {
					console.warn(
						`[Auth] Ignoring login-enabled connector '${connectorKey}' for unsupported provider '${provider}'.`,
					);
				}
				continue;
			}

			const existingConnectorKey = seenProviders.get(provider);
			if (existingConnectorKey) {
				if (existingConnectorKey !== connectorKey && !options.quiet) {
					console.warn(
						`[Auth] Multiple login-enabled connectors configured for provider '${provider}'. ` +
							`Using '${existingConnectorKey}' and ignoring '${connectorKey}'.`,
					);
				}
				continue;
			}

			const providerUpper = provider.toUpperCase();
			seenProviders.set(provider, connectorKey);
			configs.push({
				connectorKey,
				provider,
				displayName: row.name?.trim() || provider.charAt(0).toUpperCase() + provider.slice(1),
				faviconDomain: row.favicon_domain?.trim() || null,
				loginScopes,
				clientIdKey: hasValue(method.clientIdKey)
					? method.clientIdKey!
					: `${providerUpper}_CLIENT_ID`,
				clientSecretKey: hasValue(method.clientSecretKey)
					? method.clientSecretKey!
					: `${providerUpper}_CLIENT_SECRET`,
				...(hasValue(method.authorizationUrl) && {
					authorizationUrl: method.authorizationUrl,
				}),
				...(hasValue(method.tokenUrl) && { tokenUrl: method.tokenUrl }),
				...(hasValue(method.userinfoUrl) && {
					userinfoUrl: method.userinfoUrl,
				}),
				...(method.tokenEndpointAuthMethod && {
					tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
				}),
				...(method.usePkce === true && { usePkce: true }),
				...(method.authParams &&
					typeof method.authParams === "object" && {
						authParams: method.authParams,
					}),
			});
		}
	}

	return configs;
}

function hasValue(value?: string): boolean {
	return Boolean(value && value.trim().length > 0);
}

/**
 * A self-describing OAuth login provider mapped onto Better Auth's
 * provider-agnostic `genericOAuth` plugin config. Field names follow the
 * plugin's `GenericOAuthConfig` (note `userInfoUrl` casing, `authentication`,
 * `pkce`, `authorizationUrlParams`).
 */
export interface GenericOAuthEntry {
	providerId: string;
	clientId: string;
	clientSecret: string;
	authorizationUrl: string;
	tokenUrl: string;
	userInfoUrl: string;
	scopes?: string[];
	pkce?: boolean;
	authentication?: "basic" | "post";
	authorizationUrlParams?: Record<string, string>;
	mapProfileToUser: (profile: Record<string, unknown>) => {
		id: string;
		email?: string;
		name?: string;
		image?: string;
		emailVerified?: boolean;
	};
}

function betterAuthTokenAuth(
	method?: TokenEndpointAuthMethod,
): "basic" | "post" | undefined {
	if (method === "client_secret_basic") return "basic";
	if (method === "client_secret_post") return "post";
	// `none` (public client) has no client-secret auth — fall back to the
	// plugin default and rely on PKCE; callers without a secret are filtered
	// out upstream.
	return undefined;
}

// Standard OIDC claim mapping — no provider special-casing. A self-describing
// `userInfoUrl` (e.g. Slack's openid.connect.userInfo) returns `sub` (stable
// user id) plus the usual email/name/picture claims.
function mapOidcProfileToUser(profile: Record<string, unknown>) {
	const nonempty = (value: unknown): string | undefined =>
		typeof value === "string" && value.trim().length > 0
			? value.trim()
			: undefined;
	const email = typeof profile.email === "string" ? profile.email : undefined;
	const emailPrefix =
		typeof email === "string" && email.includes("@")
			? nonempty(email.split("@")[0])
			: undefined;
	return {
		id: String(profile.sub ?? ""),
		email,
		// AgentID permits inboxes with no display name, and Better Auth will
		// not create a user without one (the callback fails with
		// error=name_is_missing). Fall back through the stable handle, the
		// email local-part, then sub — never an owner claim, which is human
		// PII the sign-in may not even have granted.
		name:
			nonempty(profile.name) ??
			nonempty(profile.preferred_username) ??
			emailPrefix ??
			nonempty(profile.sub),
		image: typeof profile.picture === "string" ? profile.picture : undefined,
		emailVerified: profile.email_verified === true,
	};
}

/**
 * Map a self-describing login provider onto a Better Auth `genericOAuth` entry,
 * or `null` if it isn't self-describing (no authorize/token/userinfo endpoints —
 * those route to the built-in `socialProviders` map instead). Threads the
 * non-OIDC knobs (`usePkce`, `tokenEndpointAuthMethod`, `authParams`) through to
 * the plugin so PKCE / basic-auth / extra-param providers can actually sign in.
 */
export function buildGenericOAuthEntry(
	row: EnabledLoginProviderConfig,
	clientId: string,
	clientSecret: string,
): GenericOAuthEntry | null {
	if (!(row.authorizationUrl && row.tokenUrl && row.userinfoUrl)) return null;
	const authentication = betterAuthTokenAuth(row.tokenEndpointAuthMethod);
	return {
		providerId: row.provider,
		clientId,
		clientSecret,
		authorizationUrl: row.authorizationUrl,
		tokenUrl: row.tokenUrl,
		userInfoUrl: row.userinfoUrl,
		...(row.loginScopes.length > 0 && { scopes: row.loginScopes }),
		...(row.usePkce && { pkce: true }),
		...(authentication && { authentication }),
		...(row.authParams &&
			Object.keys(row.authParams).length > 0 && {
				authorizationUrlParams: row.authParams,
			}),
		mapProfileToUser: mapOidcProfileToUser,
	};
}

const RESERVED_TOP_LEVEL_ROUTES = new Set([
	"api",
	"auth",
	"connect",
	"dashboard",
	"oauth",
	"account",
]);

function extractSlugFromPath(pathname: string): string | null {
	const firstSegment = pathname
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean)[0];
	if (!firstSegment) return null;
	if (RESERVED_TOP_LEVEL_ROUTES.has(firstSegment.toLowerCase())) return null;
	return firstSegment;
}

function addSlugFromUrl(
	rawUrl: string | undefined | null,
	target: Set<string>,
): void {
	const parsed = safeParseUrl(rawUrl, "http://localhost");
	if (!parsed) return;
	const slug = extractSlugFromPath(parsed.pathname);
	if (slug) target.add(slug);

	const nestedCallbackUrl =
		parsed.searchParams.get("callbackURL") ||
		parsed.searchParams.get("callbackUrl");
	if (nestedCallbackUrl && nestedCallbackUrl !== rawUrl) {
		addSlugFromUrl(nestedCallbackUrl, target);
	}
}

async function extractCandidateOrgSlugs(request?: Request): Promise<string[]> {
	if (!request) return [];

	const slugs = new Set<string>();
	addSlugFromUrl(request.url, slugs);
	addSlugFromUrl(request.headers.get("referer"), slugs);

	try {
		const requestUrl = new URL(request.url);
		addSlugFromUrl(requestUrl.searchParams.get("callbackURL"), slugs);
		addSlugFromUrl(requestUrl.searchParams.get("callbackUrl"), slugs);
	} catch {
		// Ignore invalid request URL.
	}

	const contentType = (request.headers.get("content-type") || "").toLowerCase();
	if (
		request.method.toUpperCase() === "POST" &&
		contentType.includes("application/json")
	) {
		try {
			const body = (await request.clone().json()) as Record<string, unknown>;
			const callbackRaw =
				(typeof body.callbackURL === "string" && body.callbackURL) ||
				(typeof body.callbackUrl === "string" && body.callbackUrl) ||
				null;
			addSlugFromUrl(callbackRaw, slugs);
		} catch {
			// Ignore malformed body.
		}
	}

	return Array.from(slugs);
}

export async function resolveRequestOrganizationId(
	request?: Request,
): Promise<string | null> {
	const candidateSlugs = await extractCandidateOrgSlugs(request);
	if (candidateSlugs.length === 0) return null;

	const db = getDb();
	for (const slug of candidateSlugs) {
		const rows = await db`
      SELECT id
      FROM "organization"
      WHERE slug = ${slug}
      LIMIT 1
    `;
		if (rows.length > 0) {
			return String((rows[0] as { id: string }).id);
		}
	}

	return null;
}

export async function resolveLoginProviderCredentials(params: {
	env: Env;
	provider: string;
	connectorKey: string;
	clientIdKey?: string;
	clientSecretKey?: string;
	organizationId?: string | null;
}): Promise<{ clientId: string | null; clientSecret: string | null }> {
	const providerUpper = params.provider.toUpperCase();
	const clientIdKey = params.clientIdKey || `${providerUpper}_CLIENT_ID`;
	const clientSecretKey =
		params.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;

	const appProfile = params.organizationId
		? await getPrimaryAuthProfileForKind({
				organizationId: params.organizationId,
				connectorKey: params.connectorKey,
				profileKind: "oauth_app",
				provider: params.provider,
			})
		: null;

	const authValues = normalizeAuthValues(appProfile?.auth_data ?? {});
	const envRecord = params.env as Record<string, string | undefined>;
	const clientId =
		authValues[clientIdKey] ||
		envRecord[clientIdKey] ||
		process.env[clientIdKey] ||
		null;
	const clientSecret =
		authValues[clientSecretKey] ||
		envRecord[clientSecretKey] ||
		process.env[clientSecretKey] ||
		null;
	return { clientId, clientSecret };
}

/**
 * Global baseline login providers.
 *
 * Every bundled connector that declares `loginScopes` is a login candidate on
 * every deployment, independent of any organization. Whether a candidate
 * actually renders is decided downstream by credential resolution (env vars or
 * an org's OAuth-app auth profile) — see getAuthConfig / createAuth.
 *
 * This is the connector-owned model applied globally: core still never assumes
 * scopes for a provider (the connector declares them), it just no longer needs
 * a designated "default org" to carry the standard providers. The old
 * AUTH_DEFAULT_ORGANIZATION_SLUG pointer — and the silent empty-provider page
 * for any org that hadn't enabled its own connectors — are gone.
 */
const loginProviderCache = new TtlCache<EnabledLoginProviderConfig[]>(60_000);
const baselineProviderCache = new TtlCache<EnabledLoginProviderConfig[]>(
	60_000,
);
const BASELINE_CACHE_KEY = "__baseline__";

/**
 * Drop the cached baseline + per-org provider configs. Tests that vary the
 * catalog or org connector rows between cases must call this, or a stale 60s
 * cache entry serves the wrong set.
 */
export function clearLoginProviderCachesForTests(): void {
	loginProviderCache.clear();
	baselineProviderCache.clear();
}

async function getBaselineLoginProviderConfigs(): Promise<
	EnabledLoginProviderConfig[]
> {
	const cached = baselineProviderCache.get(BASELINE_CACHE_KEY);
	if (cached) return cached;

	// Same catalog source as `manage_catalog list_catalog` / GET /catalog
	// (`LOBU_CATALOG_URIS`, defaulting to dist/catalogs/connectors.json).
	const defs = await listCatalogConnectorDefinitions();
	const rows: LoginProviderConfigRow[] = defs.map((def) => ({
		key: def.key,
		name: def.name,
		favicon_domain: def.favicon_domain,
		auth_schema:
			(def.auth_schema as LoginProviderConfigRow["auth_schema"]) ?? null,
	}));
	const configs = collectEnabledLoginProviderConfigs(rows, { quiet: true });

	baselineProviderCache.set(BASELINE_CACHE_KEY, configs);
	return configs;
}

/**
 * Merge org-specific login providers onto the global baseline. An org bringing
 * its own OAuth app for a provider (e.g. `google`) shadows the global one for
 * that provider; everything else is additive. The union guarantees a branded
 * org login page can never silently end up with *fewer* providers than the
 * default — it can only add. (Narrowing to org-only — enterprise SSO-only mode
 * — would be a future explicit flag, deliberately not inferred here.)
 */
export function mergeLoginProviderConfigs(
	baseline: EnabledLoginProviderConfig[],
	orgConfigs: EnabledLoginProviderConfig[],
): EnabledLoginProviderConfig[] {
	const byProvider = new Map<string, EnabledLoginProviderConfig>();
	for (const config of baseline) byProvider.set(config.provider, config);
	for (const config of orgConfigs) byProvider.set(config.provider, config);
	return Array.from(byProvider.values());
}

export async function getEnabledLoginProviderConfigs(
	organizationId?: string | null,
): Promise<EnabledLoginProviderConfig[]> {
	const baseline = await getBaselineLoginProviderConfigs();
	const orgId = organizationId ?? null;
	if (!orgId) return baseline;

	const cached = loginProviderCache.get(orgId);
	if (cached) return mergeLoginProviderConfigs(baseline, cached);

	const db = getDb();
	const rows = await db`
    SELECT key, name, favicon_domain, auth_schema
    FROM connector_definitions
    WHERE login_enabled = true
      AND status = 'active'
      AND organization_id = ${orgId}
    ORDER BY key ASC
  `;
	const orgConfigs = collectEnabledLoginProviderConfigs(
		rows as LoginProviderConfigRow[],
	);

	loginProviderCache.set(orgId, orgConfigs);
	return mergeLoginProviderConfigs(baseline, orgConfigs);
}

/**
 * Get auth configuration by checking connector definitions and resolved OAuth credentials.
 */
export async function getAuthConfig(
	env: Env,
	options: AuthConfigOptions = {},
): Promise<AuthConfig> {
	const organizationId =
		options.organizationId !== undefined
			? options.organizationId
			: ((await resolveRequestOrganizationId(options.request)) ?? null);
	const providerConfigs = await getEnabledLoginProviderConfigs(organizationId);
	const runtimeNodeEnv = env.NODE_ENV || process.env.NODE_ENV || "development";
	const isProduction = runtimeNodeEnv === "production";

	const social: AuthConfig["social"] = {};
	const socialMeta: AuthConfig["socialMeta"] = {};

	const envRecord = env as Record<string, string | undefined>;
	const allowedGlobalProviders = hasValue(envRecord.LOBU_GLOBAL_LOGIN_PROVIDERS)
		? envRecord.LOBU_GLOBAL_LOGIN_PROVIDERS!.split(",").map((s) => s.trim().toLowerCase())
		: null;

	for (const config of providerConfigs) {
		if (allowedGlobalProviders && !organizationId && !allowedGlobalProviders.includes(config.provider)) {
			continue;
		}

		const { clientId, clientSecret } = await resolveLoginProviderCredentials({
			env,
			provider: config.provider,
			connectorKey: config.connectorKey,
			clientIdKey: config.clientIdKey,
			clientSecretKey: config.clientSecretKey,
			organizationId,
		});
		if (
			hasValue(clientId ?? undefined) &&
			hasValue(clientSecret ?? undefined)
		) {
			social[config.provider] = true;
			socialMeta[config.provider] = {
				name: config.displayName,
				faviconDomain: config.faviconDomain,
			};
		}
	}

	// Magic-link requires actual email delivery. Without RESEND_API_KEY,
	// Better Auth's plugin logs the magic URL to server stdout instead of
	// emailing it — useful for debugging, useless to a real operator who's
	// staring at their inbox. Hide the "Send me a magic link" affordance
	// when delivery isn't configured. (Previously this also returned true
	// in non-production, which made local dev render a dead button that
	// appears to work then silently does nothing.)
	const magicLink = hasValue(env.RESEND_API_KEY);
	const phone =
		hasValue(env.TWILIO_SID) &&
		hasValue(env.TWILIO_TOKEN) &&
		hasValue(env.TWILIO_WHATSAPP_NUMBER);
	const hasProviderAuthEnabled = Object.values(social).some(Boolean) || phone;
	const emailPassword =
		hasValue(env.BETTER_AUTH_SECRET) ||
		(!isProduction && !hasProviderAuthEnabled);
	// Passkey plugin is always wired (auth/index.tsx) — the gateway can verify
	// WebAuthn ceremonies regardless of env config.
	const passkey = true;
	const singleUserMode = env.LOBU_SINGLE_USER === "1";
	// Filter out the synthetic install_operator row (auto-provisioned at
	// boot in ensureInstallOperator) — it doesn't count as "the install
	// has a *human*". Real users include anyone signed up via the web UI.
	// See docs/plans/install-operator-bootstrap.md.
	let hasUser = false;
	try {
		const sql = getDb();
		const rows = (await sql`
      SELECT EXISTS(
        SELECT 1 FROM "user"
         WHERE principal_kind <> 'install_operator'
      ) AS has_user
    `) as unknown as Array<{ has_user: boolean }>;
		hasUser = !!rows[0]?.has_user;
	} catch {
		// If the DB isn't reachable (very early boot / migrations still running),
		// fail closed: treat as "no user yet" so the SPA shows /sign-up. Worst
		// case is one extra page transition when the operator clicks something.
		hasUser = false;
	}

	return {
		social,
		socialMeta,
		magicLink,
		phone,
		emailPassword,
		passkey,
		singleUserMode,
		hasUser,
	};
}
