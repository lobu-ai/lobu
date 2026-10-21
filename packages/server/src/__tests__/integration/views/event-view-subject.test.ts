import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import type { EventViewSubject } from '../../../views/event-subject';
import type { StoredView } from '../../../views/views';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  MAX_CONSECUTIVE_FAILURES: '3',
  RATE_LIMIT_ENABLED: 'false',
};

const VIEW_DEF = {
  name: 'Probe view',
  description: 'synthetic view for the event-subject probe',
  source_code: 'export default function V() { return null; }',
  compiled_code: 'export default function V() { return null; }',
  content_hash: 'synthetic-probe-hash',
  params: {},
  actions: {},
  last_writer: 'synthetic-probe',
};

describe('resolveEventViewSubject fast mismatch probe', () => {
  let getContentCalls = 0;
  let fixtures: typeof import('../../setup/test-fixtures');
  let subjectOf: (
    view: StoredView,
    eventId: number,
    ctx: ToolContext
  ) => Promise<EventViewSubject>;
  let setupKind: (kind: 'mismatch' | 'match') => Promise<{
    event: { id: number };
    view: StoredView;
    ctx: ToolContext;
  }>;

  beforeEach(async () => {
    getContentCalls = 0;
    vi.resetModules();
    const { cleanupTestDatabase } = await import('../../setup/test-db');
    await cleanupTestDatabase();
    vi.doMock('../../../tools/get_content/handler', async () => {
      const actual = await vi.importActual<
        typeof import('../../../tools/get_content/handler')
      >('../../../tools/get_content/handler');
      return {
        ...actual,
        getContent: (...args: Parameters<typeof actual.getContent>) => {
          getContentCalls += 1;
          return actual.getContent(...args);
        },
      };
    });

    const { initWorkspaceProvider } = await import('../../../workspace');
    await initWorkspaceProvider();
    fixtures = await import('../../setup/test-fixtures');
    const { setView, getView } = await import('../../../views/views');
    const { resolveEventViewSubject } = await import(
      '../../../views/event-subject'
    );

    subjectOf = (view, eventId, ctx) =>
      resolveEventViewSubject(view, eventId, TEST_ENV, ctx);

    setupKind = async (kind: 'mismatch' | 'match') => {
      const org = await fixtures.createTestOrganization({ name: 'probe org' });
      const owner = await fixtures.createTestUser({
        email: `probe-owner-${kind}@test.com`,
      });
      await fixtures.addUserToOrganization(owner.id, org.id, 'owner');
      const event = await fixtures.createTestEvent({
        organization_id: org.id,
        semantic_type: 'note',
        content: 'synthetic probe event',
      });
      await setView(org.id, {
        ...VIEW_DEF,
        key: 'probe-view',
        attach: [{ event: kind === 'match' ? 'note' : 'memo' }],
      });
      const view = await getView(org.id, 'probe-view');
      if (!view) throw new Error('probe view was not stored');
      const ctx: ToolContext = {
        organizationId: org.id,
        userId: owner.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'oauth',
        scopes: ['mcp:read'],
        sourceContext: null,
        scopedToOrg: true,
        allowCrossOrg: false,
        grantedOrganizationIds: [org.id],
        directSearchFederation: false,
      };
      return { event, view, ctx };
    };
  });

  afterEach(async () => {
    // Close this registry's pools before resetting it for the next test file.
    const { closeDbSingleton } = await import('../../../db/client');
    const { closeTestDb } = await import('../../setup/test-db');
    await closeDbSingleton();
    await closeTestDb();
    vi.doUnmock('../../../tools/get_content/handler');
    vi.resetModules();
  });

  it('throws the same 400 for a kind mismatch without the full read', async () => {
    const { event, view, ctx } = await setupKind('mismatch');

    const error = await subjectOf(view, event.id, ctx).catch(
      (e: unknown) => e
    );

    // Structural assertion: the module registry is reset for the mock, so a
    // cross-registry instanceof is unreliable here.
    expect((error as { httpStatus?: number })?.httpStatus).toBe(400);
    expect((error as Error).message).toContain(
      `View 'probe-view' is not attached to 'note' events`
    );
    expect(getContentCalls).toBe(0);
  });

  it('falls through to the full read when the kind matches', async () => {
    const { event, view, ctx } = await setupKind('match');

    const subject = await subjectOf(view, event.id, ctx);

    expect(subject.id).toBe(event.id);
    expect(getContentCalls).toBeGreaterThan(0);
  });

  it('falls through for a superseded row, preserving the 404', async () => {
    const { event, view, ctx } = await setupKind('mismatch');
    const { getTestDb } = await import('../../setup/test-db');
    const sql = getTestDb();
    // Point the row at a nonexistent successor: the full path's chain walk
    // finds no head and reports 404, and the probe must not answer instead.
    await sql`UPDATE events SET superseded_by = 999999998 WHERE id = ${event.id}`;

    const error = await subjectOf(view, event.id, ctx).catch(
      (e: unknown) => e
    );

    expect((error as { httpStatus?: number })?.httpStatus).toBe(404);
    expect(getContentCalls).toBeGreaterThan(0);
  });

  it.each(['oauth', 'pat'] as const)('preserves the %s MCP read-scope denial', async tokenType => {
    const { event, view, ctx } = await setupKind('mismatch');

    await expect(subjectOf(view, event.id, { ...ctx, tokenType, scopes: [] }))
      .rejects.toMatchObject({ httpStatus: 403 });
    expect(getContentCalls).toBe(1);
  });

  it('checks agent entity read policy before disclosing a mismatch', async () => {
    const { event, view, ctx } = await setupKind('mismatch');
    const agent = await fixtures.createTestAgent({
      organizationId: ctx.organizationId,
      ownerUserId: ctx.userId!,
    });
    const { upsertEntityApprovalPolicy } = await import('../../../authz/entity-policy');
    await upsertEntityApprovalPolicy(ctx.organizationId, {
      principalKind: 'agent',
      principalId: agent.agentId,
      entityTypeSlug: '$member',
      effects: { read: 'deny' },
    });

    await expect(subjectOf(view, event.id, { ...ctx, agentId: agent.agentId }))
      .rejects.toMatchObject({ httpStatus: 403 });
    expect(getContentCalls).toBe(1);
  });

  it('preserves the fail-closed policy for an unresolved Automation', async () => {
    const { event, view, ctx } = await setupKind('mismatch');

    await expect(subjectOf(view, event.id, { ...ctx, actingAutomationId: 999999998 }))
      .rejects.toMatchObject({ httpStatus: 403 });
    expect(getContentCalls).toBe(1);
  });

  it('returns 404 for an event outside the workspace', async () => {
    const { view, ctx } = await setupKind('mismatch');
    const otherOrg = await fixtures.createTestOrganization({ name: 'Other probe org' });
    const hidden = await fixtures.createTestEvent({
      organization_id: otherOrg.id,
      semantic_type: 'note',
      content: 'Other workspace event',
    });

    await expect(subjectOf(view, hidden.id, ctx)).rejects.toMatchObject({ httpStatus: 404 });
    expect(getContentCalls).toBeGreaterThan(0);
  });

  it.each([
    { memberRole: 'member' as const, metadata: { _lobu_workspace_audit: true } },
    { memberRole: null, metadata: { notification_type: 'test-notification' } },
  ])('withholds excluded metadata $metadata from role $memberRole', async ({ memberRole, metadata }) => {
    const { view, ctx } = await setupKind('mismatch');
    const hidden = await fixtures.createTestEvent({
      organization_id: ctx.organizationId,
      semantic_type: 'note',
      content: 'Excluded event',
      metadata,
    });

    await expect(subjectOf(view, hidden.id, { ...ctx, memberRole }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(getContentCalls).toBeGreaterThan(0);
  });

  it('returns 404 for another member\'s private connection event', async () => {
    const { view, ctx } = await setupKind('mismatch');
    const otherUser = await fixtures.createTestUser({ email: 'private-probe@test.example.com' });
    await fixtures.addUserToOrganization(otherUser.id, ctx.organizationId, 'member');
    const connection = await fixtures.createTestConnection({
      organization_id: ctx.organizationId,
      connector_key: 'test',
      created_by: otherUser.id,
      visibility: 'private',
      createDefaultFeed: false,
    });
    const hidden = await fixtures.createTestEvent({
      organization_id: ctx.organizationId,
      connection_id: connection.id,
      semantic_type: 'note',
      content: 'Private connection event',
    });

    await expect(subjectOf(view, hidden.id, ctx)).rejects.toMatchObject({ httpStatus: 404 });
    expect(getContentCalls).toBeGreaterThan(0);
  });

  it.each([false, true])('checks linked types with matching link = %s', async matching => {
    const { view, ctx } = await setupKind('match');
    const entity = await fixtures.createTestEntity({
      organization_id: ctx.organizationId,
      name: 'Probe asset',
      entity_type: 'asset',
    });
    const event = await fixtures.createTestEvent({
      organization_id: ctx.organizationId,
      semantic_type: 'note',
      entity_id: entity.id,
      content: 'Linked asset event',
    });
    view.attach = [{ event: 'note', type: matching ? 'asset' : 'memo' }];

    if (matching) {
      await expect(subjectOf(view, event.id, ctx)).resolves.toMatchObject({ id: event.id });
      expect(getContentCalls).toBeGreaterThan(0);
    } else {
      await expect(subjectOf(view, event.id, ctx)).rejects.toMatchObject({ httpStatus: 400 });
      expect(getContentCalls).toBe(0);
    }
  });
});
