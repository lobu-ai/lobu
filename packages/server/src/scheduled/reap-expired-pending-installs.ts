/**
 * Expired unclaimed-install reaper (Slack installs + tenant data installs).
 *
 * A Slack-initiated install (marketplace / raw "Add to Slack") lands at the
 * OAuth callback with a bot token but no Lobu org, so it's parked as an org-less
 * `pending` `app_installations` row and the installer is DMed a single-use claim
 * link (Phases 1-3 on this branch). If nobody ever claims it, that row keeps a
 * live bot token encrypted in its metadata forever. This reaper reaps pending
 * rows older than a TTL (default 7 days): best-effort `auth.revoke` of the bot
 * token so an abandoned workspace's credential is invalidated, then delete the
 * row.
 *
 * Scope is deliberately tight — provider='slack', provider_app_id='cloud',
 * status='pending' — so an active install (or any other provider's row) is NEVER
 * touched. The DELETE re-asserts every one of those predicates so a row claimed
 * (status flipped to 'active' + org bound) between scan and delete is left alone.
 *
 * Single-claimant per tick via the runs-queue (like the other scheduled jobs);
 * pure Postgres, so it's correct under N>1 app replicas. The DELETE is the
 * authoritative claim: revocation runs only over the rows THIS caller actually
 * removed (RETURNING), so two overlapping runners never both revoke the same
 * token, and the token never outlives its row.
 *
 * Tenant data installs (an `oauth-code-exchange` method with a declared
 * `tenant`, e.g. a merchant store) park their grant the same way: an org-less
 * `pending` row whose metadata carries the encrypted grant as `tokens_enc`
 * until the installer picks an org. An abandoned one is deleted after the same
 * TTL, keyed on that structure rather than a provider name, with no remote
 * revoke (a grant nobody claimed was never handed to a worker). A claimed setup
 * row has `tokens_enc` dropped, so it never matches.
 */

import { decrypt } from '@lobu/core';
import {
  createSlackWebApi,
  type SlackWebApi,
} from '../gateway/connections/slack-web';
import { getDb } from '../db/client';
import logger from '../utils/logger';

const SLACK_PROVIDER = 'slack';
const SLACK_PROVIDER_APP_ID = 'cloud';

export async function reapExpiredPendingSlackInstalls(
  ttlDays = 7,
  slackApi: SlackWebApi = createSlackWebApi(),
): Promise<{ expired: number }> {
  const sql = getDb();

  // Authoritative claim + reap in one statement: delete every pending Slack row
  // past the TTL and return its encrypted token so we can revoke only the rows
  // we actually removed. The inner SELECT bounds the batch (pending installs are
  // rare, but keep it finite) and orders oldest-first; the DELETE re-asserts the
  // full pending/slack/cloud predicate so a just-claimed row (now active + org
  // bound) is excluded.
  const deleted = (await sql`
    DELETE FROM app_installations
    WHERE id IN (
      SELECT id FROM app_installations
      WHERE provider = ${SLACK_PROVIDER}
        AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
        AND status = 'pending'
        AND created_at < now() - (${ttlDays}::int * interval '1 day')
      ORDER BY created_at ASC
      LIMIT 500
    )
      AND provider = ${SLACK_PROVIDER}
      AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND status = 'pending'
    RETURNING external_tenant_id, metadata
  `) as unknown as Array<{
    external_tenant_id: string;
    metadata: Record<string, unknown>;
  }>;

  // Best-effort token revocation — the row is already gone, so a revoke failure
  // (already-invalid token, Slack outage, missing/undecryptable ciphertext) is
  // logged and swallowed. Never log the token itself.
  for (const row of deleted) {
    const enc = row.metadata.bot_token_enc;
    if (typeof enc !== 'string' || !enc) continue;
    try {
      const botToken = decrypt(enc);
      await slackApi.revokeToken(botToken);
    } catch (error) {
      logger.warn(
        { teamId: row.external_tenant_id, error: String(error) },
        '[task] reap-expired-pending-installs: bot-token revoke failed (best-effort)',
      );
    }
  }

  return { expired: deleted.length };
}

/**
 * Delete org-less `pending` tenant data installs past the TTL that still park
 * an unclaimed grant (`metadata.tokens_enc`). One bounded statement; the outer
 * DELETE re-asserts every predicate so a row claimed between the scan and the
 * delete (org bound, or `tokens_enc` dropped) is left alone.
 */
export async function reapExpiredPendingTenantInstalls(
  ttlDays = 7,
): Promise<{ expired: number }> {
  const sql = getDb();
  const deleted = (await sql`
    DELETE FROM app_installations
    WHERE id IN (
      SELECT id FROM app_installations
      WHERE organization_id IS NULL
        AND status = 'pending'
        AND jsonb_typeof(metadata->'tokens_enc') = 'string'
        AND created_at < now() - (${ttlDays}::int * interval '1 day')
      ORDER BY created_at ASC
      LIMIT 500
    )
      AND organization_id IS NULL
      AND status = 'pending'
      AND jsonb_typeof(metadata->'tokens_enc') = 'string'
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { expired: deleted.length };
}

/** Scheduled-task wrapper: run both reapers and log a summary. */
export async function runReapExpiredPendingInstalls(): Promise<void> {
  const slack = await reapExpiredPendingSlackInstalls();
  const tenant = await reapExpiredPendingTenantInstalls();
  if (slack.expired > 0 || tenant.expired > 0) {
    logger.info(
      { slackExpired: slack.expired, tenantExpired: tenant.expired },
      '[task] reap-expired-pending-installs completed',
    );
  }
}
