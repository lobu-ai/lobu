/**
 * PostgresAgentConfigStore round-trip tests.
 *
 * Pins the persistence of apply-fields (starters) through saveSettings() and
 * their reset on deleteSettings().
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTestDatabase,
  getTestDb,
} from '../../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from '../../../__tests__/setup/test-fixtures';
import { orgContext } from '../org-context';
import { createPostgresAgentConfigStore } from '../postgres-stores';

describe('PostgresAgentConfigStore — apply-fields round-trip', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Apply Fields Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('round-trips starters and clears them on deleteSettings', async () => {
    const store = createPostgresAgentConfigStore();
    const starters = [
      { title: 'Plan videos', message: "Plan this week's videos" },
    ];

    await orgContext.run({ organizationId: orgId }, async () => {
      await store.saveSettings(agentId, { starters, updatedAt: Date.now() });
      expect((await store.getSettings(agentId))?.starters).toEqual(starters);

      await store.deleteSettings(agentId);
      expect((await store.getSettings(agentId))?.starters).toEqual([]);
    });
  });
});
