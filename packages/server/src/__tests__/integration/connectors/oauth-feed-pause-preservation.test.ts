import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import type { ToolContext } from '../../../tools/registry';
import { createAuthProfile } from '../../../utils/auth-profiles';
import {
  OAUTH_SCOPE_PAUSE_LAST_ERROR,
  syncOAuthConnectionsForAuthProfile,
} from '../../../utils/oauth-connection-state';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;
const CONNECTOR_KEY = 'pause.oauth';
const CONNECTOR_SCOPE = 'connector.read';
const ALPHA_SCOPE = 'feed.alpha';
const BETA_SCOPE = 'feed.beta';

function ctxFor(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

type SeededFeed = {
  key: 'alpha' | 'beta';
  status: 'active' | 'paused';
  schedule?: string | null;
};

async function seedOAuthConnection(params: {
  grantedScopes: string[];
  feeds: SeededFeed[];
  connectionStatus?: 'active' | 'pending_auth';
}): Promise<{
  organizationId: string;
  authProfileId: number;
  accountId: string;
  connectionId: number;
  feedIds: Record<string, number>;
  ctx: ToolContext;
}> {
  const organization = await createTestOrganization({ name: 'OAuth Pause Preservation Org' });
  const user = await createTestUser({ name: 'OAuth Pause Preservation User' });
  await addUserToOrganization(user.id, organization.id, 'owner');

  await createTestConnectorDefinition({
    key: CONNECTOR_KEY,
    name: 'OAuth Pause Preservation',
    organization_id: organization.id,
    auth_schema: {
      methods: [{ type: 'oauth', provider: 'pause-provider', requiredScopes: [CONNECTOR_SCOPE] }],
    },
    feeds_schema: {
      alpha: { requiredScopes: [ALPHA_SCOPE] },
      beta: { requiredScopes: [BETA_SCOPE] },
    },
  });

  const sql = getTestDb();
  const accountId = `pause-account-${organization.id}`;
  await sql`
    INSERT INTO "account" (
      id, "accountId", "providerId", "userId", scope, "createdAt", "updatedAt"
    ) VALUES (
      ${accountId}, ${accountId}, 'pause-provider', ${user.id},
      ${params.grantedScopes.join(' ')}, NOW(), NOW()
    )
  `;

  const authProfile = await createAuthProfile({
    organizationId: organization.id,
    connectorKey: CONNECTOR_KEY,
    displayName: 'OAuth Pause Account',
    profileKind: 'oauth_account',
    provider: 'pause-provider',
    accountId,
    status: 'active',
    createdBy: user.id,
    authData: { requested_scopes: [CONNECTOR_SCOPE] },
  });

  const [connection] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status, visibility,
      account_id, auth_profile_id, created_by, created_at, updated_at
    ) VALUES (
      ${organization.id}, ${CONNECTOR_KEY}, ${`pause-${organization.id}`},
      'OAuth Pause Connection', ${params.connectionStatus ?? 'active'}, 'private', ${accountId}, ${authProfile.id},
      ${user.id}, NOW(), NOW()
    )
    RETURNING id
  `) as Array<{ id: number }>;

  const feedIds: Record<string, number> = {};
  for (const feed of params.feeds) {
    const schedule = feed.schedule === undefined ? '0 * * * *' : feed.schedule;
    const [row] = (await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, display_name, status,
        schedule, next_run_at, created_at, updated_at
      ) VALUES (
        ${organization.id}, ${connection.id}, ${feed.key}, ${`${feed.key} feed`},
        ${feed.status}, ${schedule},
        ${feed.status === 'active' && schedule ? sql`NOW() + INTERVAL '1 hour'` : sql`NULL`},
        NOW(), NOW()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    feedIds[feed.key] = row.id;
  }

  return {
    organizationId: organization.id,
    authProfileId: authProfile.id,
    accountId,
    connectionId: connection.id,
    feedIds,
    ctx: ctxFor(organization.id, user.id),
  };
}

async function readState(connectionId: number): Promise<{
  connectionStatus: string;
  feeds: Array<{ feed_key: string; status: string; next_run_at: string | null }>;
}> {
  const sql = getTestDb();
  const [connection] = (await sql`
    SELECT status FROM connections WHERE id = ${connectionId}
  `) as Array<{ status: string }>;
  const feeds = (await sql`
    SELECT feed_key, status, next_run_at
    FROM feeds
    WHERE connection_id = ${connectionId}
    ORDER BY feed_key
  `) as Array<{ feed_key: string; status: string; next_run_at: string | null }>;
  return { connectionStatus: connection.status, feeds };
}

async function waitForBlockedFeedUpdate(): Promise<void> {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await sql`
      SELECT 1
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%UPDATE feeds%'
      LIMIT 1
    `;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('OAuth reconciliation did not reach the blocked feed update');
}

async function runWithLockedFeedRow(
  feedId: number,
  operation: () => Promise<void>,
  concurrentUpdate: (tx: ReturnType<typeof getTestDb>) => Promise<void>
): Promise<void> {
  const sql = getTestDb();
  let rowHeldGate!: () => void;
  const rowHeld = new Promise<void>((resolve) => {
    rowHeldGate = resolve;
  });
  let releaseRow!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseRow = resolve;
  });
  const holder = sql.begin(async (tx: typeof sql) => {
    await tx`SELECT id FROM feeds WHERE id = ${feedId} FOR UPDATE`;
    rowHeldGate();
    await release;
    await concurrentUpdate(tx);
  });

  await rowHeld;
  const blockedOperation = operation();
  try {
    await waitForBlockedFeedUpdate();
    releaseRow();
    await Promise.all([holder, blockedOperation]);
  } catch (error) {
    releaseRow();
    await Promise.allSettled([holder, blockedOperation]);
    throw error;
  }
}

describe('OAuth feed pause preservation', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('preserves an explicit pause made through manage_feeds', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE, ALPHA_SCOPE],
      feeds: [{ key: 'alpha', status: 'active' }],
    });

    const result = await manageFeeds(
      { action: 'update_feed', feed_id: seeded.feedIds.alpha, status: 'paused' },
      TEST_ENV,
      seeded.ctx
    );
    expect('error' in result).toBe(false);

    expect(await readState(seeded.connectionId)).toEqual({
      connectionStatus: 'active',
      feeds: [{ feed_key: 'alpha', status: 'paused', next_run_at: null }],
    });
  });

  it('keeps an all-paused, scope-eligible connection active and allows explicit resume', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE, ALPHA_SCOPE, BETA_SCOPE],
      feeds: [
        { key: 'alpha', status: 'paused' },
        { key: 'beta', status: 'paused' },
      ],
    });

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    expect(await readState(seeded.connectionId)).toEqual({
      connectionStatus: 'active',
      feeds: [
        { feed_key: 'alpha', status: 'paused', next_run_at: null },
        { feed_key: 'beta', status: 'paused', next_run_at: null },
      ],
    });

    const result = await manageFeeds(
      { action: 'update_feed', feed_id: seeded.feedIds.alpha, status: 'active' },
      TEST_ENV,
      seeded.ctx
    );
    expect('error' in result).toBe(false);

    const resumed = await readState(seeded.connectionId);
    expect(resumed.connectionStatus).toBe('active');
    expect(resumed.feeds[0]).toMatchObject({ feed_key: 'alpha', status: 'active' });
    expect(resumed.feeds[0]?.next_run_at).not.toBeNull();
    expect(resumed.feeds[1]).toEqual({ feed_key: 'beta', status: 'paused', next_run_at: null });
  });

  it('pauses scope-ineligible feeds while retaining a valid account connection', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [
        { key: 'alpha', status: 'active' },
        { key: 'beta', status: 'active' },
      ],
    });

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    expect(await readState(seeded.connectionId)).toEqual({
      connectionStatus: 'active',
      feeds: [
        { feed_key: 'alpha', status: 'paused', next_run_at: null },
        { feed_key: 'beta', status: 'paused', next_run_at: null },
      ],
    });
  });

  it('keeps a mixed connection active when an operator-paused feed is scope-eligible', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE, ALPHA_SCOPE],
      feeds: [
        { key: 'alpha', status: 'paused' },
        { key: 'beta', status: 'active' },
      ],
    });

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    expect(await readState(seeded.connectionId)).toEqual({
      connectionStatus: 'active',
      feeds: [
        { feed_key: 'alpha', status: 'paused', next_run_at: null },
        { feed_key: 'beta', status: 'paused', next_run_at: null },
      ],
    });
  });

  it('resumes only the sync-paused feed after scopes widen', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [
        { key: 'alpha', status: 'active' },
        { key: 'beta', status: 'paused' },
      ],
    });

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    const sql = getTestDb();
    const pausedErrors = (await sql`
      SELECT feed_key, last_error
      FROM feeds
      WHERE connection_id = ${seeded.connectionId}
      ORDER BY feed_key
    `) as Array<{ feed_key: string; last_error: string | null }>;
    expect(pausedErrors[0]?.last_error).toBe(OAUTH_SCOPE_PAUSE_LAST_ERROR);
    expect(pausedErrors[1]?.last_error).toBeNull();

    await sql`
      UPDATE "account"
      SET scope = ${[CONNECTOR_SCOPE, ALPHA_SCOPE, BETA_SCOPE].join(' ')}, "updatedAt" = NOW()
      WHERE id = ${seeded.accountId}
    `;
    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    const resumed = await readState(seeded.connectionId);
    expect(resumed.connectionStatus).toBe('active');
    expect(resumed.feeds[0]).toMatchObject({ feed_key: 'alpha', status: 'active' });
    expect(resumed.feeds[0]?.next_run_at).not.toBeNull();
    expect(resumed.feeds[1]).toEqual({ feed_key: 'beta', status: 'paused', next_run_at: null });

    const resumedErrors = (await sql`
      SELECT feed_key, last_error
      FROM feeds
      WHERE connection_id = ${seeded.connectionId}
      ORDER BY feed_key
    `) as Array<{ feed_key: string; last_error: string | null }>;
    expect(resumedErrors[0]?.last_error).toBeNull();
    expect(resumedErrors[1]?.last_error).toBeNull();
  });

  it('resumes a feed created system-paused on a pending-auth connection', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [],
      connectionStatus: 'pending_auth',
    });

    const result = await manageFeeds(
      {
        action: 'create_feed',
        connection_id: seeded.connectionId,
        feed_key: 'alpha',
        display_name: 'Alpha Feed',
        schedule: '0 * * * *',
      },
      TEST_ENV,
      seeded.ctx
    );
    expect('error' in result).toBe(false);

    const sql = getTestDb();
    const [created] = (await sql`
      SELECT status, next_run_at, last_error
      FROM feeds
      WHERE connection_id = ${seeded.connectionId} AND feed_key = 'alpha'
    `) as Array<{
      status: string;
      next_run_at: string | null;
      last_error: string | null;
    }>;
    expect(created).toMatchObject({ status: 'paused', next_run_at: null });
    expect(created?.last_error).toBe(OAUTH_SCOPE_PAUSE_LAST_ERROR);

    await sql`
      UPDATE "account"
      SET scope = ${[CONNECTOR_SCOPE, ALPHA_SCOPE].join(' ')}, "updatedAt" = NOW()
      WHERE id = ${seeded.accountId}
    `;
    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    const [resumed] = (await sql`
      SELECT status, next_run_at, last_error
      FROM feeds
      WHERE connection_id = ${seeded.connectionId} AND feed_key = 'alpha'
    `) as Array<{
      status: string;
      next_run_at: string | null;
      last_error: string | null;
    }>;
    expect(resumed?.status).toBe('active');
    expect(resumed?.next_run_at).not.toBeNull();
    expect(resumed?.last_error).toBeNull();
  });

  it('keeps an unscheduled sync-capable feed unscheduled when scope re-grant resumes it', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [{ key: 'alpha', status: 'active', schedule: null }],
    });

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    const sql = getTestDb();
    await sql`
      UPDATE "account"
      SET scope = ${[CONNECTOR_SCOPE, ALPHA_SCOPE].join(' ')}, "updatedAt" = NOW()
      WHERE id = ${seeded.accountId}
    `;
    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    expect(await readState(seeded.connectionId)).toEqual({
      connectionStatus: 'active',
      feeds: [{ feed_key: 'alpha', status: 'active', next_run_at: null }],
    });
  });

  it('clears stale scope diagnostics after an external path activates an eligible feed', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [{ key: 'alpha', status: 'active' }],
    });
    const sql = getTestDb();

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);
    await sql`
      UPDATE "account"
      SET scope = ${[CONNECTOR_SCOPE, ALPHA_SCOPE].join(' ')}, "updatedAt" = NOW()
      WHERE id = ${seeded.accountId}
    `;
    const externallyScheduledAt = new Date('2030-01-02T03:04:05.000Z');
    await sql`
      UPDATE feeds
      SET status = 'active', next_run_at = ${externallyScheduledAt}
      WHERE id = ${seeded.feedIds.alpha}
    `;

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    const [feed] = (await sql`
      SELECT status, next_run_at, last_error
      FROM feeds
      WHERE id = ${seeded.feedIds.alpha}
    `) as Array<{ status: string; next_run_at: Date | string | null; last_error: string | null }>;
    expect(feed?.status).toBe('active');
    expect(new Date(feed?.next_run_at ?? 0).toISOString()).toBe(externallyScheduledAt.toISOString());
    expect(feed?.last_error).toBeNull();
  });

  it('clears sync pause provenance when an operator explicitly keeps the feed paused', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [{ key: 'alpha', status: 'active' }],
    });

    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    const result = await manageFeeds(
      { action: 'update_feed', feed_id: seeded.feedIds.alpha, status: 'paused' },
      TEST_ENV,
      seeded.ctx
    );
    expect('error' in result).toBe(false);

    const sql = getTestDb();
    const [operatorPaused] = (await sql`
      SELECT last_error FROM feeds WHERE id = ${seeded.feedIds.alpha}
    `) as Array<{ last_error: string | null }>;
    expect(operatorPaused?.last_error).toBeNull();

    await sql`
      UPDATE "account"
      SET scope = ${[CONNECTOR_SCOPE, ALPHA_SCOPE].join(' ')}, "updatedAt" = NOW()
      WHERE id = ${seeded.accountId}
    `;
    await syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId);

    expect(await readState(seeded.connectionId)).toEqual({
      connectionStatus: 'active',
      feeds: [{ feed_key: 'alpha', status: 'paused', next_run_at: null }],
    });

    await sql`
      UPDATE feeds SET last_error = 'connector_failure' WHERE id = ${seeded.feedIds.alpha}
    `;
    await manageFeeds(
      { action: 'update_feed', feed_id: seeded.feedIds.alpha, status: 'paused' },
      TEST_ENV,
      seeded.ctx
    );
    const [unrelatedError] = (await sql`
      SELECT last_error FROM feeds WHERE id = ${seeded.feedIds.alpha}
    `) as Array<{ last_error: string | null }>;
    expect(unrelatedError?.last_error).toBe('connector_failure');
  });

  it('does not overwrite operator state changes made after reconciliation reads the feed', async () => {
    const seeded = await seedOAuthConnection({
      grantedScopes: [CONNECTOR_SCOPE],
      feeds: [{ key: 'alpha', status: 'active' }],
    });
    const sql = getTestDb();

    await runWithLockedFeedRow(
      seeded.feedIds.alpha,
      () => syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId),
      async (tx) => {
        await tx`
          UPDATE feeds
          SET status = 'paused',
              next_run_at = NULL,
              last_error = NULL
          WHERE id = ${seeded.feedIds.alpha}
        `;
      }
    );

    const [operatorPaused] = (await sql`
      SELECT status, last_error FROM feeds WHERE id = ${seeded.feedIds.alpha}
    `) as Array<{ status: string; last_error: string | null }>;
    expect(operatorPaused?.status).toBe('paused');
    expect(operatorPaused?.last_error).toBeNull();

    await sql`
      UPDATE feeds
      SET last_error = ${OAUTH_SCOPE_PAUSE_LAST_ERROR}
      WHERE id = ${seeded.feedIds.alpha}
    `;
    await sql`
      UPDATE "account"
      SET scope = ${[CONNECTOR_SCOPE, ALPHA_SCOPE].join(' ')}, "updatedAt" = NOW()
      WHERE id = ${seeded.accountId}
    `;

    await runWithLockedFeedRow(
      seeded.feedIds.alpha,
      () => syncOAuthConnectionsForAuthProfile(seeded.organizationId, seeded.authProfileId),
      async (tx) => {
        await tx`
          UPDATE feeds
          SET last_error = NULL
          WHERE id = ${seeded.feedIds.alpha}
        `;
      }
    );

    const [operatorOverride] = (await sql`
      SELECT status, next_run_at, last_error FROM feeds WHERE id = ${seeded.feedIds.alpha}
    `) as Array<{
      status: string;
      next_run_at: string | null;
      last_error: string | null;
    }>;
    expect(operatorOverride?.status).toBe('paused');
    expect(operatorOverride?.next_run_at).toBeNull();
    expect(operatorOverride?.last_error).toBeNull();
  });
});
