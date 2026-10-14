import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const name = '20261014120000_clear_team_device_auto_pause.sql';
const root = new URL('../../../../../../db/migrations/', import.meta.url);
const migration = readFileSync(new URL(name, root), 'utf8').split('-- migrate:down')[0]!;

describe('clear team device auto-pause', () => {
  beforeEach(cleanupTestDatabase);

  it('resumes only pinned connections carrying a device auto-pause stamp', async () => {
    const sql = getDb();
    const org = await createTestOrganization({ name: 'Team' });
    const user = await createTestUser({ name: 'Device Owner' });
    const [device] = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at)
      VALUES (${user.id}, 'stamp-box', 'headless', ${sql.json([])}, ${org.id}, NOW())
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    let keys = 0;
    // One connector per row: a device holds one live connection per connector.
    const connection = async (errorMessage: string | null, pinned = true) => {
      const key = `test.device-${++keys}`;
      await createTestConnectorDefinition({ key, name: 'Device', organization_id: org.id });
      const row = await createTestConnection({
        organization_id: org.id,
        connector_key: key,
        created_by: user.id,
        createDefaultFeed: false,
      });
      await sql`
        UPDATE connections
        SET status = 'paused', error_message = ${errorMessage},
            device_worker_id = ${pinned ? device!.id : null}::uuid
        WHERE id = ${row.id}
      `;
      return row.id as number;
    };
    const upgrade = await connection(
      'Update Lobu on this device to use Device in Team: this workspace runs version 2.0.0, your device has 1.0.0.'
    );
    const notOffered = await connection('Device is no longer offered by this device.');
    const userPaused = await connection(null);
    const otherError = await connection('Device was removed');
    const unpinned = await connection('Device is no longer offered by this device.', false);

    await sql.unsafe(migration);
    await sql.unsafe(migration);

    const rows = (await sql`
      SELECT id, status, error_message FROM connections
      WHERE id IN ${sql([upgrade, notOffered, userPaused, otherError, unpinned])}
    `) as unknown as Array<{ id: number; status: string; error_message: string | null }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(upgrade)).toMatchObject({ status: 'active', error_message: null });
    expect(byId.get(notOffered)).toMatchObject({ status: 'active', error_message: null });
    expect(byId.get(userPaused)).toMatchObject({ status: 'paused', error_message: null });
    expect(byId.get(otherError)).toMatchObject({ status: 'paused', error_message: 'Device was removed' });
    expect(byId.get(unpinned)).toMatchObject({ status: 'paused' });
  });
});
