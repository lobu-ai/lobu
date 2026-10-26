/**
 * PostgresSecretStore — WritableSecretStore backed by the `agent_secrets`
 * table. Stores AES-256-GCM ciphertext produced by @lobu/core's encrypt(),
 * keyed by `(organization_id, logical name)`, and returns
 * `secret://<encoded-name>` refs.
 *
 * The org_id is threaded via AsyncLocalStorage (`tryGetOrgId()`) — the
 * `secret://` URI scheme stays unchanged so callers don't have to embed
 * org context in stored refs. Per-org rows take precedence over the
 * empty-string "global" bucket used by deployment-wide system secrets
 * and pre-org-scoping rows.
 *
 * Paired with SecretStoreRegistry and passed as the `secretStore` option to
 * Gateway from `src/lobu/gateway.ts` so lobu's ChatInstanceManager can
 * persist connection secrets durably.
 */

import {
  createBuiltinSecretRef,
  decrypt,
  encrypt,
  parseSecretRef,
  type SecretRef,
} from '@lobu/core';
import { type DbClient, getDb, tsTime } from '../../db/client';
import type { WritableSecretStore } from '../../gateway/secrets/index';
import logger from '../../utils/logger';
import { tryGetOrgId } from './org-context';
import { getErrorMessage } from "@lobu/core";

const GLOBAL_ORG_ID = '';

// SecretListEntry and SecretPutOptions are defined inside the gateway's
// secrets module but not re-exported from its public barrel. Derive them
// from WritableSecretStore's method signatures so we stay aligned with
// upstream without reaching into internal paths.
type SecretPutOptions = NonNullable<Parameters<WritableSecretStore['put']>[2]>;
type SecretListEntry = Awaited<ReturnType<WritableSecretStore['list']>>[number];

const BACKEND_NAME = 'postgres';
const DEFAULT_SCHEME = 'secret';

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Escape LIKE special chars so a caller-supplied prefix can't smuggle
 * wildcards into our prefix scan. Paired with `ESCAPE '\'` in the query.
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Resolve a name-or-ref input to a plain logical name. Throws on refs that
 * target a non-default scheme.
 */
function resolveName(nameOrRef: string): string {
  const parsed = parseSecretRef(nameOrRef);
  if (!parsed) return nameOrRef;
  if (parsed.scheme !== DEFAULT_SCHEME) {
    throw new Error(`Unsupported writable secret backend: ${parsed.scheme}`);
  }
  const decoded = safeDecodeURIComponent(parsed.path);
  if (decoded === null) {
    throw new Error(`Invalid secret ref path encoding: ${parsed.path}`);
  }
  return decoded;
}

export class PostgresSecretStore implements WritableSecretStore {
  constructor(private readonly transaction?: DbClient) {}
  async get(ref: SecretRef): Promise<string | null> {
    const parsed = parseSecretRef(ref);
    if (!parsed || parsed.scheme !== DEFAULT_SCHEME) return null;

    const name = safeDecodeURIComponent(parsed.path);
    if (name === null) {
      logger.warn({ ref }, '[secret-store] Invalid secret ref path encoding');
      return null;
    }

    const orgId = tryGetOrgId();
    const sql = this.transaction ?? getDb();

    // Per-org row wins; fall through to the empty-string "global" bucket
    // (system env secrets and pre-org-scoping rows). ORDER BY puts the
    // per-org row first when both exist.
    const rows = orgId
      ? await sql<{ ciphertext: string }>`
          SELECT ciphertext
          FROM agent_secrets
          WHERE name = ${name}
            AND organization_id IN (${orgId}, ${GLOBAL_ORG_ID})
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY organization_id DESC
          LIMIT 1
        `
      : await sql<{ ciphertext: string }>`
          SELECT ciphertext
          FROM agent_secrets
          WHERE name = ${name}
            AND organization_id = ${GLOBAL_ORG_ID}
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1
        `;

    const ciphertext = rows[0]?.ciphertext;
    if (!ciphertext) return null;

    try {
      return decrypt(ciphertext);
    } catch (error) {
      logger.warn(
        { ref, error: getErrorMessage(error) },
        '[secret-store] Failed to decrypt stored secret'
      );
      return null;
    }
  }

  async put(name: string, value: string, options?: SecretPutOptions): Promise<SecretRef> {
    const ciphertext = encrypt(value);
    const expiresAt = options?.ttlSeconds ? new Date(Date.now() + options.ttlSeconds * 1000) : null;
    const ctxOrgId = tryGetOrgId();
    const orgId = ctxOrgId ?? GLOBAL_ORG_ID;
    if (ctxOrgId === null) {
      // System env-store and other deployment-wide writers reach here
      // intentionally; tenant code paths reaching here is a bug —
      // the rotated secret would land in the cross-tenant bucket and
      // shadow every org's read of the same name. Logged loudly so
      // the regression shows up in observability.
      logger.warn(
        { name },
        '[secret-store] put() without org context — writing to GLOBAL bucket'
      );
    }

    const sql = this.transaction ?? getDb();
    await sql`
      INSERT INTO agent_secrets (organization_id, name, ciphertext, expires_at, created_at, updated_at)
      VALUES (${orgId}, ${name}, ${ciphertext}, ${expiresAt}, now(), now())
      ON CONFLICT (organization_id, name) DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `;

    return createBuiltinSecretRef(encodeURIComponent(name));
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = resolveName(nameOrRef);
    const ctxOrgId = tryGetOrgId();
    const orgId = ctxOrgId ?? GLOBAL_ORG_ID;
    if (ctxOrgId === null) {
      logger.warn(
        { name },
        '[secret-store] delete() without org context — targeting GLOBAL bucket'
      );
    }
    const sql = this.transaction ?? getDb();
    await sql`
      DELETE FROM agent_secrets
      WHERE name = ${name} AND organization_id = ${orgId}
    `;
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const orgId = tryGetOrgId();
    const sql = this.transaction ?? getDb();

    // Without org context, list only the global bucket. With org context,
    // list per-org rows; global rows are deployment-level and not
    // surfaced to org-scoped callers to keep tenancy boundaries clean.
    const targetOrgId = orgId ?? GLOBAL_ORG_ID;

    const rows = prefix
      ? await sql<{ name: string; updated_at: Date }>`
          SELECT name, updated_at
          FROM agent_secrets
          WHERE organization_id = ${targetOrgId}
            AND name LIKE ${escapeLikePrefix(prefix) + '%'} ESCAPE '\\'
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY name ASC
        `
      : await sql<{ name: string; updated_at: Date }>`
          SELECT name, updated_at
          FROM agent_secrets
          WHERE organization_id = ${targetOrgId}
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY name ASC
        `;

    return rows.map((row) => ({
      ref: createBuiltinSecretRef(encodeURIComponent(row.name)),
      backend: BACKEND_NAME,
      name: row.name,
      updatedAt: tsTime(row.updated_at),
    }));
  }
}
