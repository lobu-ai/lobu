/**
 * Shared primitives for the `~/.config/lobu/credentials.json` store — the
 * v2, context-keyed credential file written by `lobu login`.
 *
 * Two consumers read/refresh/write this store: the CLI
 * (`packages/cli/src/internal/credentials.ts`) and the embedded server's
 * managed-connector resolver (`packages/server/src/connect/cloud-credential.ts`).
 * This module is the single implementation of the file format + refresh grant so
 * the two can't drift. It is pure file I/O + a plain refresh_token POST — the
 * CLI layers its own concerns (per-process caching, in-flight refresh dedup,
 * local-init, context resolution) on top.
 */

import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  /** Cached so refresh/logout don't have to re-discover. */
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  /**
   * RFC 8707 resource indicator this grant was minted for (e.g.
   * `https://app.lobu.ai/mcp/<workspace>`). Recorded at login so every later
   * refresh can replay it — the issuer rejects a resource-scoped refresh that
   * omits or changes the indicator.
   */
  resource?: string;
}

/**
 * The auth-relevant fields every stored credential carries. Consumers may store
 * extra fields alongside these (e.g. the CLI's `email` / `userId` /
 * `localWorkerToken`); the `C` type parameter preserves them through read/write.
 */
export interface BaseCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  /** Registered OAuth client + endpoints used to mint/refresh these tokens. */
  oauth?: OAuthClientInfo;
}

export interface CredentialStore<C extends BaseCredential = BaseCredential> {
  version: 2;
  contexts: Record<string, C>;
}

/** Refresh the access token when it expires within this window. */
export const CREDENTIAL_REFRESH_BUFFER_MS = 60_000;

export function normalizeCredential<C extends BaseCredential = BaseCredential>(
  value: Partial<C> | null | undefined
): C | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.accessToken !== "string" ||
    value.accessToken === ""
  ) {
    return null;
  }
  return { ...(value as C), accessToken: value.accessToken };
}

function isCredentialStore(value: unknown): value is CredentialStore {
  return (
    !!value &&
    typeof value === "object" &&
    "contexts" in value &&
    !!(value as { contexts?: unknown }).contexts &&
    typeof (value as { contexts?: unknown }).contexts === "object"
  );
}

/**
 * Read + normalize the whole store. A legacy single-context file (pre-v2: the
 * bare credential object at the top level) is migrated under `defaultContextName`.
 * Missing or corrupt files yield an empty store rather than throwing.
 */
export async function readCredentialStore<
  C extends BaseCredential = BaseCredential,
>(file: string, defaultContextName: string): Promise<CredentialStore<C>> {
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isCredentialStore(parsed)) {
      const contexts: Record<string, C> = {};
      for (const [name, value] of Object.entries(parsed.contexts)) {
        const norm = normalizeCredential<C>(value as Partial<C>);
        if (norm) contexts[name] = norm;
      }
      return { version: 2, contexts };
    }
    const legacy = normalizeCredential<C>(parsed as Partial<C>);
    return {
      version: 2,
      contexts: legacy ? { [defaultContextName]: legacy } : {},
    };
  } catch {
    return { version: 2, contexts: {} };
  }
}

/** Read one context's credential (null when absent/corrupt). */
export async function readContextCredential<
  C extends BaseCredential = BaseCredential,
>(
  file: string,
  contextName: string,
  defaultContextName: string
): Promise<C | null> {
  const store = await readCredentialStore<C>(file, defaultContextName);
  return store.contexts[contextName] ?? null;
}

/**
 * Atomically write `data` to `file` with 0600 perms. Writes to a sibling temp
 * file (same dir, so `rename` is on the same filesystem and therefore atomic on
 * POSIX), chmods the temp BEFORE the rename so the published file never has a
 * window of looser perms, then renames over the target. This makes concurrent
 * writers (CLI `lobu login` + the server's token-refresh write-back) safe: each
 * writer commits its whole-file image in a single atomic `rename`, so a reader
 * always sees one writer's complete file — never a half-written / interleaved
 * one. (Last-writer-wins on the rename; we don't merge, but neither writer can
 * corrupt the store.)
 */
async function atomicWriteFile(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(
    dirname(file),
    `${".tmp-"}${process.pid}.${randomBytes(6).toString("hex")}`
  );
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Write one context's credential into the store, preserving other contexts.
 * The write is atomic (temp-file + `rename`) so a concurrent writer (e.g. the
 * server's refresh write-back) can never observe a half-written store. 0600
 * perms are set on the temp file before the rename, so the published file is
 * never world-readable even momentarily.
 */
export async function writeContextCredential<
  C extends BaseCredential = BaseCredential,
>(
  file: string,
  contextName: string,
  defaultContextName: string,
  credential: C
): Promise<void> {
  const store = await readCredentialStore<C>(file, defaultContextName);
  store.contexts[contextName] = credential;
  await atomicWriteFile(file, JSON.stringify(store, null, 2));
}

/** Remove one context. Deletes the file entirely when no contexts remain. */
export async function deleteContextCredential<
  C extends BaseCredential = BaseCredential,
>(
  file: string,
  contextName: string,
  defaultContextName: string
): Promise<void> {
  const store = await readCredentialStore<C>(file, defaultContextName);
  delete store.contexts[contextName];
  if (Object.keys(store.contexts).length === 0) {
    await rm(file).catch(() => undefined);
    return;
  }
  await atomicWriteFile(file, JSON.stringify(store, null, 2));
}

export function credentialNeedsRefresh(
  cred: BaseCredential,
  bufferMs = CREDENTIAL_REFRESH_BUFFER_MS
): boolean {
  return (
    typeof cred.expiresAt === "number" &&
    cred.expiresAt - bufferMs <= Date.now()
  );
}

export function credentialCanRefresh<C extends BaseCredential = BaseCredential>(
  cred: C
): cred is C & {
  refreshToken: string;
  oauth: OAuthClientInfo & { tokenEndpoint: string };
} {
  return Boolean(
    cred.refreshToken && cred.oauth?.tokenEndpoint && cred.oauth.clientId
  );
}

export interface RefreshedToken {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until expiry, when the issuer returns `expires_in`. */
  expiresIn?: number;
}

/**
 * Plain RFC 6749 refresh_token grant against the issuer token endpoint (JSON
 * body). Returns null on any network / non-2xx / parse failure. The issuer may
 * rotate the refresh token, so callers MUST persist the returned `refreshToken`
 * when present.
 *
 * When the grant was minted for a specific protected resource, `options.resource`
 * MUST be the one recorded at authorization time. The Lobu issuer compares the
 * refresh request's indicator against the stored one and answers `invalid_grant`
 * on any mismatch — including an omitted indicator — so a resource-scoped
 * credential that refreshes without it can never be renewed.
 */
export async function refreshOAuthToken(
  tokenEndpoint: string,
  client: { clientId: string; clientSecret?: string },
  refreshToken: string,
  options: { resource?: string } = {}
): Promise<RefreshedToken | null> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;
  // RFC 8707: echo the authorized resource so the issuer's audience check passes.
  if (options.resource) body.resource = options.resource;

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!data || typeof data.access_token !== "string") return null;
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn:
      typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}
