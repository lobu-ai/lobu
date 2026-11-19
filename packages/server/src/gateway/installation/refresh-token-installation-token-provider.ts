/**
 * Generic gateway-side token renewal for a TENANT-scoped `oauth-code-exchange`
 * app installation: a connector whose `app_installation` method declares a
 * `tenant` (the merchant's own host) plus a `{{tenant}}` `tokenUrl`. No provider
 * literal lives here — the method (endpoints, credential env-var names, tenant
 * pattern) is read off the BUNDLED connector the gateway primed at boot, never
 * the org-editable `connector_definitions` row, so a tenant can never point the
 * server-wide client secret at a host of its choosing.
 *
 * The install's access + refresh tokens live in the auth profile linked through
 * `app_installations.auth_profile_id`. Only the short-lived access token leaves
 * this module (as a minted lease); the refresh token stays gateway-side.
 *
 * Multi-replica: the refresh token ROTATES on every refresh (the provider
 * retires the old one), so two pods refreshing at once would burn the grant.
 * The refresh therefore runs inside one transaction holding `FOR UPDATE` on the
 * auth profile row; after taking the lock the stored credentials are re-read,
 * and a token another pod already rotated is reused without a network call. The
 * rotated pair is persisted in the same transaction. The in-memory cache is a
 * per-pod optimization only.
 */

import { fetchCredentialedPublicUrl } from "@lobu/connector-worker/egress";
import type { ConnectorAuthAppInstallation } from "@lobu/connector-sdk";
import { getDb } from "../../db/client.js";
import type { AppInstallationRow } from "../../lobu/stores/app-installation-store.js";
import {
	persistAuthCredentials,
	resolveAuthCredentials,
} from "../../utils/auth-credential-secrets.js";
import {
	readConnectorOAuthResponse,
	withConnectorOAuthDeadline,
} from "../../utils/connector-oauth-http.js";
import {
	compileTenantMatcher,
	getPrimedBundledMethod,
	renderTenantUrl,
	resolveAppInstallCredentials,
} from "./app-install-credentials.js";
import {
	InMemoryInstallationTokenCache,
	InstallationTokenError,
	type InstallationTokenProvider,
	type MintedInstallationToken,
	type MintTokenOptions,
} from "./installation-token-provider.js";

/** The pinned public-DNS, no-redirect fetch used for every token call. */
export type TenantInstallTokenFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

/** Stored credential keys on the install's auth profile. */
export interface TenantInstallTokenGrant {
	access_token: string;
	refresh_token?: string;
	/** ISO-8601 access-token expiry; absent for a non-expiring token. */
	expires_at?: string;
}

/** Without a declared expiry, re-read the stored token after this long. */
const NON_EXPIRING_RECHECK_MS = 60 * 60 * 1000;
const REFRESH_SKEW_MS = 60_000;

function parseTokenGrant(text: string): TenantInstallTokenGrant | null {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof data.access_token !== "string" || !data.access_token) return null;
	const expiresIn = Number(data.expires_in);
	return {
		access_token: data.access_token,
		...(typeof data.refresh_token === "string" && data.refresh_token
			? { refresh_token: data.refresh_token }
			: {}),
		...(Number.isFinite(expiresIn) && expiresIn > 0
			? { expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() }
			: {}),
	};
}

/**
 * POST a form-encoded grant to a tenant token endpoint. A non-2xx response
 * resolves to its HTTP status (the body is discarded unread — never logged);
 * a 2xx without an access token throws.
 */
export async function requestTenantInstallToken(
	fetchImpl: TenantInstallTokenFetch,
	tokenUrl: string,
	form: Record<string, string>,
): Promise<{ grant: TenantInstallTokenGrant } | { status: number }> {
	return withConnectorOAuthDeadline(async (signal) => {
		const response = await fetchImpl(tokenUrl, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body: new URLSearchParams(form).toString(),
			redirect: "error",
			signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return { status: response.status };
		}
		const grant = parseTokenGrant(await readConnectorOAuthResponse(response));
		if (!grant) throw new Error("Token endpoint returned no access token");
		return { grant };
	});
}

function toMinted(grant: {
	access_token?: string;
	expires_at?: string;
}): MintedInstallationToken | null {
	if (!grant.access_token) return null;
	return {
		token: grant.access_token,
		expiresAt:
			grant.expires_at ??
			new Date(Date.now() + NON_EXPIRING_RECHECK_MS).toISOString(),
	};
}

type RenewalOutcome =
	| { minted: MintedInstallationToken }
	| { status: number | null };

/** The bundled (deployment-trusted) method for an install, keyed by its stamped connector. */
function defaultResolveMethod(
	install: AppInstallationRow,
): ConnectorAuthAppInstallation | null {
	const connectorKey = install.metadata?.connector_key;
	if (typeof connectorKey !== "string" || !connectorKey) return null;
	return getPrimedBundledMethod(connectorKey, install.provider) ?? null;
}

export class RefreshTokenInstallationTokenProvider
	implements InstallationTokenProvider
{
	/** Not keyed by provider: registered as the registry's declared-method fallback. */
	readonly provider = "*";
	private readonly cache = new InMemoryInstallationTokenCache({
		refreshSkewMs: REFRESH_SKEW_MS,
	});
	private readonly matchers = new Map<string, (value: string) => boolean>();
	private readonly resolveMethod: (
		install: AppInstallationRow,
	) => ConnectorAuthAppInstallation | null;
	private readonly fetchImpl: TenantInstallTokenFetch;
	private readonly env: NodeJS.ProcessEnv;

	constructor(options?: {
		resolveMethod?: (
			install: AppInstallationRow,
		) => ConnectorAuthAppInstallation | null;
		fetchImpl?: TenantInstallTokenFetch;
		env?: NodeJS.ProcessEnv;
	}) {
		this.resolveMethod = options?.resolveMethod ?? defaultResolveMethod;
		this.fetchImpl = options?.fetchImpl ?? fetchCredentialedPublicUrl;
		this.env = options?.env ?? process.env;
	}

	private tenantMatches(pattern: string, tenant: string): boolean {
		let matcher = this.matchers.get(pattern);
		if (!matcher) {
			matcher = compileTenantMatcher(pattern);
			this.matchers.set(pattern, matcher);
		}
		return matcher(tenant);
	}

	async mintToken(
		install: AppInstallationRow,
		options?: MintTokenOptions,
	): Promise<MintedInstallationToken> {
		const method = this.resolveMethod(install);
		const organizationId = install.organizationId;
		const authProfileId = install.authProfileId;
		if (
			method?.installShape !== "oauth-code-exchange" ||
			!method.tenant ||
			!method.tokenUrl ||
			authProfileId == null ||
			!organizationId
		) {
			throw new InstallationTokenError(
				"provider_unsupported",
				`App installation ${install.id} has no renewable tenant token method`,
			);
		}
		if (!this.tenantMatches(method.tenant.pattern, install.externalTenantId)) {
			throw new InstallationTokenError(
				"provider_unsupported",
				`App installation ${install.id} tenant does not match the declared pattern`,
			);
		}
		const creds = resolveAppInstallCredentials(method, this.env);
		const clientId = creds.clientId;
		const clientSecret = creds.clientSecret;
		if (!clientId || !clientSecret) {
			throw new InstallationTokenError(
				"missing_app_config",
				`App credentials for '${install.provider}' are not configured`,
			);
		}

		const cacheKey = `${install.id}:${authProfileId}`;
		const cached = this.cache.get(cacheKey, options?.minTtlMs);
		if (cached) return cached;

		const runwayMs = Math.max(REFRESH_SKEW_MS, options?.minTtlMs ?? 0);
		const tokenUrl = renderTenantUrl(method.tokenUrl, install.externalTenantId);
		const outcome: RenewalOutcome = await getDb().begin(async (tx): Promise<RenewalOutcome> => {
			const locked = (await tx`
				SELECT auth_data FROM auth_profiles
				WHERE id = ${authProfileId}
					AND organization_id = ${organizationId}
				FOR UPDATE
			`) as unknown as Array<{ auth_data: Record<string, unknown> | null }>;
			if (locked.length === 0) {
				throw new InstallationTokenError(
					"install_inactive",
					`App installation ${install.id} has no credential profile`,
				);
			}
			// Re-read AFTER taking the lock: another pod may have rotated already.
			const stored = await resolveAuthCredentials({
				organizationId,
				authProfileId,
				authData: locked[0].auth_data,
				appInstallationRenewal: true,
			});
			const current = toMinted(stored);
			if (
				current &&
				(!stored.refresh_token ||
					Date.parse(current.expiresAt) - runwayMs > Date.now())
			) {
				return { minted: current };
			}
			if (!stored.refresh_token) {
				return { status: null };
			}
			const result = await requestTenantInstallToken(this.fetchImpl, tokenUrl, {
				grant_type: "refresh_token",
				refresh_token: stored.refresh_token,
				client_id: clientId,
				client_secret: clientSecret,
			});
			if ("status" in result) return { status: result.status };
			// Persist the rotated pair every time: the old refresh token is retired.
			const next: TenantInstallTokenGrant = {
				access_token: result.grant.access_token,
				refresh_token: result.grant.refresh_token ?? stored.refresh_token,
				...(result.grant.expires_at
					? { expires_at: result.grant.expires_at }
					: {}),
			};
			await persistAuthCredentials({
				organizationId,
				authProfileId,
				credentials: { ...next },
				db: tx,
			});
			return { minted: toMinted(next) as MintedInstallationToken };
		});

		if ("minted" in outcome) {
			this.cache.set(cacheKey, outcome.minted);
			return outcome.minted;
		}
		if (outcome.status === 401) {
			// The grant itself was refused: the install needs a fresh consent.
			await getDb()`
				UPDATE app_installations
				SET status = 'error', updated_at = now()
				WHERE id = ${install.id} AND status = 'active'
			`;
		}
		throw new InstallationTokenError(
			"exchange_failed",
			outcome.status === null
				? `App installation ${install.id} has no stored token`
				: `Token renewal for app installation ${install.id} failed (HTTP ${outcome.status})`,
			outcome.status === null ? undefined : { status: outcome.status },
		);
	}
}
