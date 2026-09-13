/**
 * A browser tab folds its unread count into the document title, so the same
 * page arrives as "(3) WhatsApp" and later "WhatsApp". For a page_visit the
 * URL is the identity and that badge is volatile: comparing titles raw made
 * chrome.history supersede 93.6% of its own writes (#3328). The dedup path
 * compares page_visit titles badge-normalized; a genuine title change still
 * supersedes, and other semantic types compare titles exactly as before.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  addUserToOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('page_visit title badge normalization', () => {
  let orgId: string;
  let connectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Badge Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'badge-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    await createTestConnectorDefinition({
      key: 'badge-connector',
      name: 'Badge Connector',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'badge-connector',
    });
    connectionId = connection.id;
  });

  function pageVisit(originId: string, title: string) {
    return insertEvent(
      {
        entityIds: [],
        organizationId: orgId,
        originId,
        title,
        content: "page body",
        sourceUrl: 'https://web.whatsapp.com/',
        occurredAt: new Date('2026-09-10T12:00:00Z'),
        semanticType: 'page_visit',
        originType: 'page_visit',
        connectorKey: 'badge-connector',
        connectionId,
      },
      { onConflictUpdate: true }
    );
  }

  it('does not supersede when only the unread badge moves in or out of the title', async () => {
    const originId = `badge-${Date.now()}`;
    const first = await pageVisit(originId, '(3) WhatsApp');
    expect(first.change).toBe('inserted');

    const badgeOut = await pageVisit(originId, 'WhatsApp');
    expect(badgeOut.change).toBe('unchanged');
    expect(badgeOut.id).toBe(first.id);

    const badgeUp = await pageVisit(originId, '(7) WhatsApp');
    expect(badgeUp.change).toBe('unchanged');
    expect(badgeUp.id).toBe(first.id);
  });

  it('still supersedes a page_visit on a genuine title change', async () => {
    const originId = `real-${Date.now()}`;
    const first = await pageVisit(originId, '(3) WhatsApp');
    const renamed = await pageVisit(originId, 'WhatsApp Business');
    expect(renamed.change).toBe('superseded');
    expect(renamed.id).not.toBe(first.id);
  });

  it('compares titles exactly for semantic types other than page_visit', async () => {
    const originId = `other-${Date.now()}`;
    const first = await insertEvent(
      {
        entityIds: [],
        organizationId: orgId,
        originId,
        title: '(3) Standup notes',
        content: 'notes',
        occurredAt: new Date('2026-09-10T12:00:00Z'),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'badge-connector',
        connectionId,
      },
      { onConflictUpdate: true }
    );
    const second = await insertEvent(
      {
        entityIds: [],
        organizationId: orgId,
        originId,
        title: 'Standup notes',
        content: 'notes',
        occurredAt: new Date('2026-09-10T12:00:00Z'),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'badge-connector',
        connectionId,
      },
      { onConflictUpdate: true }
    );
    expect(second.change).toBe('superseded');
    expect(second.id).not.toBe(first.id);
  });
});
