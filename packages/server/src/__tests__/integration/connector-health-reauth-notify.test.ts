/**
 * connector-health → browser-auth-expired user notification (integration).
 *
 * When a connection goes unhealthy because its SITE SESSION expired (e.g. an
 * extension-scrape connector like Revolut whose Revolut login lapsed), the
 * health scan must notify the org's admins to re-login — on top of the operator
 * log alert. A connection that's unhealthy for a NON-auth reason (offline
 * device / transport) must NOT produce a sign-in notification. And the notice
 * fires once per unhealthy episode (deduped by the unhealthy_alerted_at claim).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConnectorHealthCheck } from '../../connectors/connector-health';
import { BROWSER_SESSION_EXPIRED_KIND } from '../../utils/platform-notification-kinds';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

// Comfortably outside the 24h min-age grace window so age never masks a flag.
const OLD = new Date(Date.now() - 48 * 60 * 60 * 1000);

async function seedConn(
  orgId: string,
  userId: string,
  connectorKey: string,
  slug: string,
): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, created_at, updated_at
    ) VALUES (
      ${orgId}, ${connectorKey}, ${slug}, ${`Conn ${slug}`}, 'active',
      ${userId}, 'org', ${OLD}, ${OLD}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function seedFailingFeed(
  orgId: string,
  connectionId: number,
  feedKey: string,
  lastError: string,
): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status,
      last_sync_status, last_sync_at, consecutive_failures, last_error,
      created_at, updated_at
    ) VALUES (
      ${orgId}, ${connectionId}, ${feedKey}, 'active',
      'failed', ${new Date()}, 5, ${lastError}, NOW(), NOW()
    )
  `;
}

/**
 * Notification identity is row presence in `notification_targets`, never
 * `semantic_type` — a kind-backed notification stores its event kind there
 * instead (see `utils/content-search/params.ts`). This one carries
 * `browser_session_expired` so the same kind drives the Memory-view render and
 * the chat card.
 */
async function authNotifsFor(
  orgId: string,
  connectionId: number,
): Promise<Array<{ id: number; title: string; semantic_type: string }>> {
  const sql = getTestDb();
  return (await sql`
    SELECT e.id, e.title, e.semantic_type
    FROM events e
    WHERE e.organization_id = ${orgId}
      AND EXISTS (SELECT 1 FROM notification_targets nt WHERE nt.event_id = e.id)
      AND e.metadata->>'notification_type' = 'browser_auth_expired'
      AND e.metadata->>'resource_id' = ${String(connectionId)}
  `) as unknown as Array<{ id: number; title: string; semantic_type: string }>;
}

async function stoppedNotifsFor(
  orgId: string,
  connectionId: number,
): Promise<Array<{ id: number; title: string; payload_text: string | null }>> {
  const sql = getTestDb();
  return (await sql`
    SELECT e.id, e.title, e.payload_text
    FROM events e
    WHERE e.organization_id = ${orgId}
      AND EXISTS (SELECT 1 FROM notification_targets nt WHERE nt.event_id = e.id)
      AND e.metadata->>'notification_type' = 'generic'
      AND e.metadata->>'resource_type' = 'connection'
      AND e.metadata->>'resource_id' = ${String(connectionId)}
  `) as unknown as Array<{ id: number; title: string; payload_text: string | null }>;
}

describe('connector-health → browser-auth-expired notification', () => {
  let orgId: string;
  let ownerId: string;
  let authConnId: number;
  let offlineConnId: number;
  let neverStartedConnId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Reauth Notify Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'reauth-owner@test.com' });
    ownerId = user.id;
    await addUserToOrganization(ownerId, orgId, 'owner');
    await createTestConnectorDefinition({
      key: 'revolut',
      name: 'Revolut',
      organization_id: orgId,
      feeds_schema: { transactions: {} },
    });

    // (A) Expired site session — should notify.
    authConnId = await seedConn(orgId, ownerId, 'revolut', 'revolut-auth');
    await seedFailingFeed(
      orgId,
      authConnId,
      'transactions',
      'Revolut session needs sign-in (redirected to https://sso.revolut.com/signin)',
    );

    // (B) Offline device / transport — unhealthy, but NOT an auth failure.
    offlineConnId = await seedConn(
      orgId,
      ownerId,
      'revolut',
      'revolut-offline',
    );
    await seedFailingFeed(
      orgId,
      offlineConnId,
      'transactions',
      'No online paired Owletto Chrome extension in this organization. Pair a Chrome extension first (and make sure it is running).',
    );
  });

  beforeAll(async () => {
    // (C) Set up but never collected — unhealthy, yet not an outage to report.
    neverStartedConnId = await seedConn(orgId, ownerId, 'revolut', 'revolut-never');
    const sql = getTestDb();
    await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, created_at, updated_at
      ) VALUES (${orgId}, ${neverStartedConnId}, 'transactions', 'active', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('notifies the owner on an expired session, but not on an offline device', async () => {
    const res = await runConnectorHealthCheck();

    // Both connections are flagged unhealthy (every feed failing)...
    const flagged = new Set(res.details.map((d) => d.connectionId));
    expect(flagged.has(authConnId)).toBe(true);
    expect(flagged.has(offlineConnId)).toBe(true);

    // ...but only the expired-session one produced a sign-in notification.
    expect(res.authNotified).toBe(1);

    const authNotifs = await authNotifsFor(orgId, authConnId);
    expect(authNotifs).toHaveLength(1);
    expect(authNotifs[0].title.toLowerCase()).toContain('needs sign-in');
    // Kind-backed: the event carries its content kind, and the chat card is
    // built from that kind's template rather than a hand-rolled body.
    expect(authNotifs[0].semantic_type).toBe(BROWSER_SESSION_EXPIRED_KIND);

    // The owner is a target of that notification.
    const sql = getTestDb();
    const targets = (await sql`
      SELECT user_id FROM notification_targets WHERE event_id = ${Number(authNotifs[0].id)}
    `) as unknown as Array<{ user_id: string }>;
    expect(targets.map((t) => t.user_id)).toContain(ownerId);

    // The offline-device connection produced NO browser-auth-expired notification.
    expect(await authNotifsFor(orgId, offlineConnId)).toHaveLength(0);
  });

  it('tells the admins a collecting connection stopped, with its last error', async () => {
    // The scan above already claimed this episode; the notice it sent is here.
    const stopped = await stoppedNotifsFor(orgId, offlineConnId);
    expect(stopped).toHaveLength(1);
    expect(stopped[0].title).toBe('Conn revolut-offline needs attention');
    expect(stopped[0].payload_text).toContain('Every feed on this connection is failing');
    expect(stopped[0].payload_text).toContain('No online paired Owletto Chrome extension');

    const sql = getTestDb();
    const targets = (await sql`
      SELECT user_id FROM notification_targets WHERE event_id = ${Number(stopped[0].id)}
    `) as unknown as Array<{ user_id: string }>;
    expect(targets.map((t) => t.user_id)).toContain(ownerId);

    // The expired session got its specific notice, not this one as well.
    expect(await stoppedNotifsFor(orgId, authConnId)).toHaveLength(0);
  });

  it('does not report a connection that never collected as stopped', async () => {
    const sql = getTestDb();
    const [row] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${neverStartedConnId}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    // Flagged for operators...
    expect(row.unhealthy_alerted_at).not.toBeNull();
    // ...but no admin was told an abandoned setup is an outage.
    expect(await stoppedNotifsFor(orgId, neverStartedConnId)).toHaveLength(0);
  });

  it('does not re-notify while still unhealthy (deduped by the unhealthy claim)', async () => {
    const res = await runConnectorHealthCheck();
    expect(res.newlyAlerted).toBe(0);
    expect(res.authNotified).toBe(0);
    expect(res.stoppedNotified).toBe(0);
    // Still exactly one notification each — no duplicate on the second scan.
    expect(await authNotifsFor(orgId, authConnId)).toHaveLength(1);
    expect(await stoppedNotifsFor(orgId, offlineConnId)).toHaveLength(1);
  });

  // The marker is the once-per-episode claim. If it commits while the notice
  // fails to persist, every later scan sees the episode as already announced
  // and the admins are never told. Both must land together or not at all.
  it('retries a notification that failed to persist on the next scan', async () => {
    const sql = getTestDb();
    const connId = await seedConn(orgId, ownerId, 'revolut', 'revolut-retry');
    await seedFailingFeed(orgId, connId, 'transactions', 'Upstream returned HTTP 502');

    const failed = await runConnectorHealthCheck({
      notifyStopped: async () => {
        throw new Error('notification insert failed');
      },
    });
    expect(failed.details.some((d) => d.connectionId === connId)).toBe(true);
    expect(failed.stoppedNotified).toBe(0);
    const [afterFailure] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${connId}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    expect(afterFailure.unhealthy_alerted_at).toBeNull();
    expect(await stoppedNotifsFor(orgId, connId)).toHaveLength(0);

    const retried = await runConnectorHealthCheck();
    expect(retried.stoppedNotified).toBe(1);
    expect(await stoppedNotifsFor(orgId, connId)).toHaveLength(1);
    const [afterRetry] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${connId}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    expect(afterRetry.unhealthy_alerted_at).not.toBeNull();
  });
});
