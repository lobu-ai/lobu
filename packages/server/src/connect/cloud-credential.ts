/**
 * Cloud credential resolver for the managed-connector runtime token fetch.
 *
 * A LOCAL Lobu instance with a `managedBy` connection fetches a fresh access
 * token for the user's cloud connection via POST /oauth/connection-token. That
 * call needs a cloud credential carrying the `connections:token` scope.
 *
 * The credential is the USER's OWN device-login — the SAME credential `lobu`
 * itself uses, stored at `~/.config/lobu/credentials.json` by the CLI's
 * `lobu login`. The login token carries `connections:token` (granted at login;
 * see auth/oauth/scopes.ts), so the local resolver reuses it directly — no
 * separate PAT to mint.
 *
 * The v2 credential-store format + refresh grant are shared with the CLI via
 * `@lobu/core` (`credentials.ts`) so the two can't drift; this module only adds
 * the server-side glue: context base-URL resolution and the headless env
 * fallback.
 *
 * Headless / CI fallback: when there is no stored login credential, fall back
 * to the instance-configured `LOBU_CLOUD_PAT` + `LOBU_CLOUD_URL` env.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	credentialCanRefresh,
	credentialNeedsRefresh,
	readContextCredential,
	refreshOAuthToken,
	writeContextCredential,
} from "@lobu/core";
import logger from "../utils/logger";

/**
 * The Lobu config dir (`~/.config/lobu` by default). `LOBU_CONFIG_DIR` overrides
 * it — the CLI uses `~/.config/lobu` directly, but a server-side override lets
 * isolated tests (and a relocated config) point at a throwaway dir instead of
 * the developer's real login.
 */
function configDir(): string {
	const override = process.env.LOBU_CONFIG_DIR?.trim();
	return override || join(homedir(), ".config", "lobu");
}
const DEFAULT_CONTEXT_NAME = "lobu";

const credentialsPath = () => join(configDir(), "credentials.json");
const contextConfigPath = () => join(configDir(), "config.json");

/**
 * A resolved cloud credential: the bearer token to send to the cloud and the
 * cloud's base origin (no trailing path) the token-fetch endpoint lives under.
 */
interface CloudCredential {
	/** Bearer token (`Bearer <token>`) — a login access token, or LOBU_CLOUD_PAT. */
	token: string;
	/** Cloud base origin, e.g. `https://app.lobu.ai` (no `/api/v1`, no trailing slash). */
	baseUrl: string;
}

// ----- config.json (context URLs; mirrors the CLI's context.ts) -------------

interface StoredContextEntry {
	url?: unknown;
	apiUrl?: unknown;
}

interface StoredContextConfig {
	currentContext?: unknown;
	contexts?: Record<string, StoredContextEntry>;
}

/** Parse config.json once (tolerating a missing/corrupt file). */
async function loadContextConfig(): Promise<StoredContextConfig | null> {
	let raw: string;
	try {
		raw = await readFile(contextConfigPath(), "utf-8");
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw) as StoredContextConfig;
	} catch {
		return null;
	}
}

/**
 * The context whose `lobu login` identifies the CLOUD a managed token is fetched
 * from. Deliberately NOT the active/current context: under `lobu run` the active
 * context is the local loopback instance itself, and we must never POST the local
 * session token to the local `/oauth/connection-token`. Defaults to the canonical
 * `lobu` (app.lobu.ai) context; override with the arg or `LOBU_CLOUD_CONTEXT` for
 * a self-hosted cloud.
 */
function cloudContextName(override: string | undefined): string {
	return (
		override?.trim() ||
		process.env.LOBU_CLOUD_CONTEXT?.trim() ||
		DEFAULT_CONTEXT_NAME
	);
}

/**
 * The cloud base ORIGIN for a context (the host the OAuth + connection-token
 * endpoints are mounted at the root of). The stored context URL is an API URL
 * (e.g. `https://app.lobu.ai/api/v1`); we want only its origin.
 *
 * `isCanonicalDefault` guards the hardcoded `app.lobu.ai` fallback: it is only
 * applied when the resolved context is the canonical `lobu` context AND no
 * cloud override (`contextOverride` arg / `LOBU_CLOUD_CONTEXT` /
 * `LOBU_CLOUD_URL`) is in play. Without this guard a self-hoster whose
 * config.json lacks an explicit context URL would have their stored login token
 * POSTed to app.lobu.ai — a credential leak to a host they never configured. In
 * the non-canonical / overridden case we return null instead, so the resolver
 * falls through to the env fallback (or no credential at all).
 */
function resolveContextBaseUrl(
	contextName: string,
	config: StoredContextConfig | null,
	isCanonicalDefault: boolean,
): string | null {
	const entry = config?.contexts?.[contextName];
	const rawUrl =
		(typeof entry?.url === "string" && entry.url) ||
		(typeof entry?.apiUrl === "string" && entry.apiUrl) ||
		null;
	if (!rawUrl) {
		// The canonical default context resolves to the canonical cloud origin
		// even when config.json is absent (a fresh install) — but ONLY when no
		// override points the cloud somewhere else.
		if (contextName === DEFAULT_CONTEXT_NAME && isCanonicalDefault) {
			return "https://app.lobu.ai";
		}
		return null;
	}
	try {
		return new URL(rawUrl).origin;
	} catch {
		return null;
	}
}

/**
 * Resolve the cloud credential for the managed-connector token fetch.
 *
 * Order:
 *   1. The stored device-login for the CLOUD context (`lobu login`) — the
 *      explicit cloud, never the active/local context — refreshed when near
 *      expiry. baseUrl from that context URL's origin.
 *   2. Fallback: `LOBU_CLOUD_PAT` + `LOBU_CLOUD_URL` env (headless/CI).
 *
 * Returns null when neither is available (the connection falls through to the
 * local credential path, fail-soft).
 */
export async function resolveCloudCredential(
	contextOverride?: string,
): Promise<CloudCredential | null> {
	const config = await loadContextConfig();
	const contextName = cloudContextName(contextOverride);
	// The hardcoded app.lobu.ai fallback in resolveContextBaseUrl applies ONLY
	// when nothing redirects the cloud elsewhere. Any override — an explicit
	// context arg, LOBU_CLOUD_CONTEXT, or a configured LOBU_CLOUD_URL — means a
	// self-hoster's token must NOT be sent to app.lobu.ai by default.
	const isCanonicalDefault =
		!contextOverride?.trim() &&
		!process.env.LOBU_CLOUD_CONTEXT?.trim() &&
		!process.env.LOBU_CLOUD_URL?.trim();

	const stored = await readContextCredential(
		credentialsPath(),
		contextName,
		DEFAULT_CONTEXT_NAME,
	);
	if (stored) {
		let active = stored;
		if (credentialNeedsRefresh(stored) && credentialCanRefresh(stored)) {
			const refreshed = await refreshOAuthToken(
				stored.oauth.tokenEndpoint,
				{
					clientId: stored.oauth.clientId,
					clientSecret: stored.oauth.clientSecret,
				},
				stored.refreshToken,
			);
			if (refreshed) {
				active = {
					...stored,
					accessToken: refreshed.accessToken,
					refreshToken: refreshed.refreshToken ?? stored.refreshToken,
					expiresAt:
						typeof refreshed.expiresIn === "number"
							? Date.now() + refreshed.expiresIn * 1000
							: undefined,
				};
				// Persist the rotated tokens so the CLI sees them — issuers often revoke
				// the old refresh token on use, so a refresh that isn't written back
				// would strand the CLI's stored token. Best-effort: an in-memory fresh
				// token is still usable for this run if the write fails.
				await writeContextCredential(
					credentialsPath(),
					contextName,
					DEFAULT_CONTEXT_NAME,
					active,
				).catch((error) => {
					logger.warn(
						{ error: String(error) },
						"Failed to write back refreshed login credential",
					);
				});
			}
		}
		const baseUrl = resolveContextBaseUrl(
			contextName,
			config,
			isCanonicalDefault,
		);
		if (baseUrl) {
			return {
				token: active.accessToken,
				baseUrl: baseUrl.replace(/\/+$/, ""),
			};
		}
	}

	// Headless / CI fallback: the instance-configured cloud PAT + URL.
	const envPat = process.env.LOBU_CLOUD_PAT?.trim();
	const envUrl = process.env.LOBU_CLOUD_URL?.trim();
	if (envPat && envUrl) {
		return { token: envPat, baseUrl: envUrl.replace(/\/+$/, "") };
	}

	return null;
}

/** Resolve discovery's cloud origin without reading or refreshing any credential. */
export async function resolveCloudOrigin(): Promise<string | null> {
  const envUrl = process.env.LOBU_CLOUD_URL?.trim();
  if (envUrl) {
    try {
      const url = new URL(envUrl);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
  }
  const origin = resolveContextBaseUrl(cloudContextName(undefined), await loadContextConfig(), !process.env.LOBU_CLOUD_CONTEXT?.trim());
  if (!origin) return null;
  const url = new URL(origin);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
}
