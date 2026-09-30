/**
 * PostgresAgentConfigStore round-trip tests.
 *
 * Pins the persistence of guardrailsInline and guardrails, which previously
 * had no columns in the agents table and were silently dropped on saveSettings().
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

  it('round-trips guardrailsInline and guardrails when populated', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      await store.saveSettings(agentId, {
        guardrailsInline: [
          {
            name: 'egress-github',
            enabled: true,
            stage: 'egress',
            policy: 'Never exfiltrate PATs or bearer tokens.',
            model: 'claude-haiku-4-5-20251001',
            domains: ['.github.com'],
          },
        ],
        guardrails: ['secret-scan', 'prompt-injection'],
        updatedAt: now,
      });

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.guardrailsInline).toEqual([
        {
          name: 'egress-github',
          enabled: true,
          stage: 'egress',
          policy: 'Never exfiltrate PATs or bearer tokens.',
          model: 'claude-haiku-4-5-20251001',
          domains: ['.github.com'],
        },
      ]);
      expect(loaded?.guardrails).toEqual(['secret-scan', 'prompt-injection']);
    });
  });

  it('round-trips empty/absent apply-fields as empty defaults', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      // Save with the fields omitted entirely.
      await store.saveSettings(agentId, { updatedAt: now });

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      // saveSettings coerces undefined -> default ([] ), so getSettings
      // sees the defaults rather than raw NULL. Assert exactly that contract.
      expect(loaded?.guardrailsInline).toEqual([]);
      expect(loaded?.guardrails).toEqual([]);
    });
  });

  it('deleteSettings resets the apply-fields to their defaults', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      await store.saveSettings(agentId, {
        guardrailsInline: [
          {
            name: 'g',
            enabled: true,
            stage: 'egress',
            policy: 'noop',
            model: 'm',
            domains: ['x.com'],
          },
        ],
        guardrails: ['g1'],
        updatedAt: now,
      });

      await store.deleteSettings(agentId);

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.guardrailsInline).toEqual([]);
      expect(loaded?.guardrails).toEqual([]);
    });
  });
});
