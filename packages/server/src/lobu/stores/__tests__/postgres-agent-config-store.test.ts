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
import { persistDefaultModel } from '../../model-config';
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

  it('preserves an unrelated edit committed while a settings patch waits for the row lock', async () => {
    const store = createPostgresAgentConfigStore();
    const sql = getTestDb();
    await orgContext.run({ organizationId: orgId }, () => store.saveSettings(agentId, {
      models: ['openai/old-model'], identityMd: 'original identity', updatedAt: Date.now(),
    }));
    let release!: () => void;
    let ready!: () => void;
    const unlocked = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    let holderPid = 0;
    const holder = sql.begin(async (tx) => {
      holderPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`UPDATE agents SET identity_md = 'new identity' WHERE organization_id = ${orgId} AND id = ${agentId}`;
      ready();
      await unlocked;
    });
    await locked;
    const patch = orgContext.run({ organizationId: orgId }, () => store.updateSettings(agentId, {
      models: ['openai/new-model'],
    }));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await sql`SELECT 1 FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`;
        if (rows.length) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await Promise.all([holder, patch]);
    }
    const saved = await orgContext.run({ organizationId: orgId }, () => store.getSettings(agentId));
    expect(saved?.models).toEqual(['openai/new-model']);
    expect(saved?.identityMd).toBe('new identity');
  });

  it('compares a model approval pre-image atomically with the model write', async () => {
    const store = createPostgresAgentConfigStore();
    await orgContext.run({ organizationId: orgId }, () => store.saveSettings(agentId, {
      models: ['openai/newer-model'], identityMd: 'preserve identity', updatedAt: Date.now(),
    }));
    const applied = await persistDefaultModel(agentId, orgId, 'openai/proposed-model', {
      expectedCurrent: 'openai/older-model',
    });
    const saved = await orgContext.run({ organizationId: orgId }, () => store.getSettings(agentId));
    expect(saved?.models).toEqual(['openai/newer-model']);
    expect(saved?.identityMd).toBe('preserve identity');
    expect(applied).toBe(false);
  });

});
