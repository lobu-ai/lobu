/**
 * Timezone-aware schedule evaluation for automations and feeds.
 *
 * Same semantics as scheduled_jobs.timezone (#1866): the cron's wall-clock
 * fields are evaluated in the stored IANA zone, DST included; NULL keeps the
 * pre-existing server-time scheduling semantics. Asia/Taipei (UTC+8, no DST) makes the
 * expected UTC instants deterministic: 9am Taipei is always 01:00Z.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { advanceAutomationSchedule } from '../../automations/schedule-cursor';
import type { DbClient } from '../../db/client';
import { ClientSdkActionError } from '../../sandbox/namespaces/action-call';
import { nextRunAt } from '../../utils/cron';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestUser,
} from '../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../setup/test-mcp-client';

function utcHour(ts: unknown): number {
  return new Date(ts as string).getUTCHours();
}

// "No timezone" means the process's local zone (UTC in prod/CI, whatever the
// dev machine runs locally) — compare against nextRunAt itself, not a fixed
// hour, so the assertion holds in any environment.
function serverTimeNineAmUtcHour(): number {
  return utcHour(nextRunAt('0 9 * * *', new Date()));
}

describe('automations/feeds timezone-aware schedules', () => {
  let workspace: TestWorkspace;
  let api: TestApiClient;
  let entityId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'TZ Schedules Org' });
    const entity = await createTestEntity({
      name: 'TZ Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    entityId = entity.id;
    await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.owner.id,
      agentId: 'tz-automation-agent',
      name: 'TZ Automation Agent',
    });
    api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: workspace.users.owner.id,
      memberRole: 'owner',
    });
    await createTestConnectorDefinition({
      key: 'github',
      name: 'GitHub',
      organization_id: workspace.org.id,
      feeds_schema: { default: {} },
    });
  }, 60_000);

  it('Automation create stores trigger timezone and anchors next_run_at to the zone wall-clock', async () => {
    const created = (await workspace.owner.automations.create({
      entity_id: entityId,
      slug: 'tz-automation',
      name: 'TZ Automation',
      prompt: 'Summarize {{entities}}.',
      triggers: [
        { kind: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Taipei' },
      ],
      managed_agent_id: 'tz-automation-agent',
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    const sql = getTestDb();
    const [row] = await sql`
      SELECT timezone, next_run_at FROM automations WHERE id = ${automationId}
    `;
    expect(row.timezone).toBe('Asia/Taipei');
    expect(utcHour(row.next_run_at)).toBe(1);

    // Fire-time advance uses the stored zone, not server time.
    await sql`
      UPDATE automations SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = ${automationId}
    `;
    await advanceAutomationSchedule(sql as unknown as DbClient, automationId);
    const [advanced] = await sql`
      SELECT next_run_at FROM automations WHERE id = ${automationId}
    `;
    expect(utcHour(advanced.next_run_at)).toBe(1);
    expect(new Date(advanced.next_run_at as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('Automation update re-anchors the pending firing when trigger timezone changes', async () => {
    const created = (await workspace.owner.automations.create({
      entity_id: entityId,
      slug: 'tz-automation-update',
      name: 'TZ Automation Update',
      prompt: 'Summarize {{entities}}.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: 'tz-automation-agent',
    })) as { automation_id: string; revision: string };
    const automationId = Number(created.automation_id);

    const sql = getTestDb();
    const [before] =
      await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
    expect(utcHour(before.next_run_at)).toBe(serverTimeNineAmUtcHour());

    await workspace.owner.automations.update({
      automation_id: String(automationId),
      expected_revision: created.revision,
      triggers: [
        { kind: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Taipei' },
      ],
    });
    const [after] = await sql`
      SELECT timezone, next_run_at FROM automations WHERE id = ${automationId}
    `;
    expect(after.timezone).toBe('Asia/Taipei');
    expect(utcHour(after.next_run_at)).toBe(1);
  });

  it('Automation create rejects an unknown trigger timezone', async () => {
    await expect(
      workspace.owner.automations.create({
        entity_id: entityId,
        slug: 'tz-automation-bad',
        name: 'Bad TZ',
        prompt: 'Summarize {{entities}}.',
        triggers: [
          {
            kind: 'schedule',
            cron: '0 9 * * *',
            timezone: 'Mars/Olympus_Mons',
          },
        ],
        managed_agent_id: 'tz-automation-agent',
      }),
    ).rejects.toThrow(/Unknown IANA timezone/);
  });

  it('feed update stores timezone and re-anchors next_run_at; null clears back to server time', async () => {
    const user = await createTestUser({ email: 'tz-feeds@test.com' });
    const conn = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'github',
      created_by: user.id,
    });
    const sql = getTestDb();
    const [feed] = await sql<{ id: number }[]>`
      SELECT id FROM feeds WHERE connection_id = ${conn.id} LIMIT 1
    `;
    const feedId = Number(feed?.id);
    expect(feedId).toBeGreaterThan(0);

    await api.feeds.update({
      feed_id: feedId,
      schedule: '0 9 * * *',
      timezone: 'Asia/Taipei',
    });
    const [tzRow] = await sql`
      SELECT timezone, next_run_at FROM feeds WHERE id = ${feedId}
    `;
    expect(tzRow.timezone).toBe('Asia/Taipei');
    expect(utcHour(tzRow.next_run_at)).toBe(1);

    await api.feeds.update({ feed_id: feedId, timezone: null });
    const [cleared] = await sql`
      SELECT timezone, next_run_at FROM feeds WHERE id = ${feedId}
    `;
    expect(cleared.timezone).toBeNull();
    expect(utcHour(cleared.next_run_at)).toBe(serverTimeNineAmUtcHour());
  });

  it('feed update rejects an unknown timezone', async () => {
    const user = await createTestUser({ email: 'tz-feeds-bad@test.com' });
    const conn = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'github',
      created_by: user.id,
    });
    const sql = getTestDb();
    const [feed] = await sql<{ id: number }[]>`
      SELECT id FROM feeds WHERE connection_id = ${conn.id} LIMIT 1
    `;
    const error = await api.feeds
      .update({
        feed_id: Number(feed?.id),
        timezone: 'Not/A_Zone',
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClientSdkActionError);
    expect((error as ClientSdkActionError).message).toContain(
      'Unknown IANA timezone',
    );
  });
});
