/**
 * UI-facing auth run endpoints.
 *
 * These are session-authenticated (not worker-token auth) endpoints that
 * the browser UI uses to initiate and monitor auth/pairing flows:
 *
 *   GET  /api/auth-runs/active?connection_id=X
 *   GET  /api/auth-runs/:id
 *   POST /api/auth-runs/:id/signal
 */

import type { Context } from 'hono';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import { resolveSession } from '../auth/resolve-session';
import { routeFailure } from '../diagnostics';

/**
 * GET /api/auth-runs/active?connection_id=X
 *
 * Returns the most recent non-terminal auth run the caller started for a
 * connection. Used by the UI to rehydrate a pairing flow after a reload so
 * the QR/artifact keeps rendering instead of the sheet falling back to a
 * fresh "Pair device" button.
 */
export async function getActiveAuthRun(c: Context<{ Bindings: Env }>) {
  try {
    const connectionIdStr = c.req.query('connection_id');
    const connectionId = Number(connectionIdStr);
    if (!Number.isFinite(connectionId)) {
      return c.json({ error: 'Invalid connection_id' }, 400);
    }

    const auth = await createAuth(c.env, c.req.raw);
    const session = await resolveSession(auth, c.req.raw.headers);
    const userId = session?.user?.id;
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sql = getDb();
    const rows = (await sql`
      SELECT r.id
      FROM runs r
      JOIN connections c ON c.auth_profile_id = r.auth_profile_id
      WHERE c.id = ${connectionId}
        AND r.run_type = 'auth'
        AND r.status IN ('pending', 'claimed', 'running')
        AND r.created_by_user_id = ${userId}
      ORDER BY r.created_at DESC
      LIMIT 1
    `) as Array<{ id: number }>;

    return c.json({ run_id: rows[0]?.id ?? null });
  } catch (err: unknown) {
    throw routeFailure(c.json({ error: errorMessage(err) }, 500), err);
  }
}

/**
 * GET /api/auth-runs/:id
 *
 * Session-authenticated endpoint for the UI to poll an auth run's status and
 * latest artifact (checkpoint.artifact). Returns enough shape for a pairing
 * dialog to render qr/code/redirect/prompt/status updates.
 */
export async function getAuthRun(c: Context<{ Bindings: Env }>) {
  try {
    const runIdStr = c.req.param('id');
    const runId = Number(runIdStr);
    if (!Number.isFinite(runId)) {
      return c.json({ error: 'Invalid run id' }, 400);
    }

    const auth = await createAuth(c.env, c.req.raw);
    const session = await resolveSession(auth, c.req.raw.headers);
    const userId = session?.user?.id;
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sql = getDb();

    const rows = (await sql`
      SELECT r.id,
             r.organization_id,
             r.status,
             r.connector_key,
             r.checkpoint,
             r.error_message,
             r.created_at,
             r.completed_at,
             r.created_by_user_id,
             ap.id AS auth_profile_id,
             ap.slug AS auth_profile_slug,
             ap.status AS auth_profile_status
      FROM runs r
      LEFT JOIN auth_profiles ap ON ap.id = r.auth_profile_id
      WHERE r.id = ${runId}
        AND r.run_type = 'auth'
      LIMIT 1
    `) as Array<{
      id: number;
      organization_id: string;
      status: string;
      connector_key: string | null;
      checkpoint: Record<string, unknown> | null;
      error_message: string | null;
      created_at: string;
      completed_at: string | null;
      created_by_user_id: string | null;
      auth_profile_id: number | null;
      auth_profile_slug: string | null;
      auth_profile_status: string | null;
    }>;

    if (rows.length === 0) {
      return c.json({ error: 'Auth run not found' }, 404);
    }

    const run = rows[0];
    // Auth run artifacts may contain sensitive credentials (QR pairing codes,
    // OTPs, OAuth callback URLs). Restrict visibility to the initiator only —
    // other org members must not see them.
    if (run.created_by_user_id !== userId) {
      return c.json({ error: 'Auth run not found' }, 404);
    }

    return c.json({
      id: run.id,
      status: run.status,
      connector_key: run.connector_key,
      artifact: run.checkpoint?.artifact ?? null,
      error_message: run.error_message,
      created_at: run.created_at,
      completed_at: run.completed_at,
      auth_profile: run.auth_profile_id
        ? {
            id: run.auth_profile_id,
            slug: run.auth_profile_slug,
            status: run.auth_profile_status,
          }
        : null,
    });
  } catch (err: unknown) {
    throw routeFailure(c.json({ error: errorMessage(err) }, 500), err);
  }
}

/**
 * POST /api/auth-runs/:id/signal
 *
 * UI → connector reverse channel. Stores a signal on the run row that the
 * worker's awaitSignal() poll consumes.
 */
export async function postAuthSignal(c: Context<{ Bindings: Env }>) {
  try {
    const runIdStr = c.req.param('id');
    const runId = Number(runIdStr);
    if (!Number.isFinite(runId)) {
      return c.json({ error: 'Invalid run id' }, 400);
    }

    const body = await c.req.json<{
      name: string;
      payload?: Record<string, unknown>;
    }>();

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'Missing signal name' }, 400);
    }

    const auth = await createAuth(c.env, c.req.raw);
    const session = await resolveSession(auth, c.req.raw.headers);
    const userId = session?.user?.id;
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sql = getDb();

    // Only the user who initiated the auth run can send signals to it —
    // signals carry sensitive payloads (OAuth callback tokens, form values).
    const ownerRows = (await sql`
      SELECT organization_id, created_by_user_id
      FROM runs
      WHERE id = ${runId}
        AND run_type = 'auth'
        AND status IN ('pending', 'claimed', 'running')
      LIMIT 1
    `) as Array<{ organization_id: string; created_by_user_id: string | null }>;

    if (ownerRows.length === 0) {
      return c.json({ error: 'Auth run not found or not active' }, 404);
    }

    if (ownerRows[0].created_by_user_id !== userId) {
      return c.json({ error: 'Auth run not found or not active' }, 404);
    }

    const rows = (await sql`
      UPDATE runs
      SET auth_signal = ${sql.json({ name: body.name, payload: body.payload ?? {} })}
      WHERE id = ${runId}
        AND run_type = 'auth'
        AND status IN ('pending', 'claimed', 'running')
      RETURNING id
    `) as Array<{ id: number }>;

    if (rows.length === 0) {
      return c.json({ error: 'Auth run not found or not active' }, 404);
    }

    return c.json({ success: true });
  } catch (err: unknown) {
    throw routeFailure(c.json({ error: errorMessage(err) }, 500), err);
  }
}
