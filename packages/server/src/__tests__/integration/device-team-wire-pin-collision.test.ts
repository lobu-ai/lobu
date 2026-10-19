/**
 * A team device whose pin is already held by a live connection that the wire's
 * identity check does not recognise must not log a wire failure on every poll.
 *
 * Team wiring only reuses a connection when `device_worker_id = <device>` AND
 * `created_by = <polling user>`. The unique index
 * `idx_connections_org_connector_device_live` is on (org, connector, device)
 * alone, so a live row pinned to the same device by someone else (or with no
 * owner) is invisible to the lookup, the INSERT collides on the index, and the
 * wire logs `Failed to wire device connector` on every reconcile.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import logger from '../../utils/logger';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();
const CONNECTOR = 'test.team_pin_collision';
const CAPABILITY = 'test_team_pin_collision';
const MANIFEST = {
  key: CONNECTOR,
  version: '1.0.0',
  name: 'Team Pin Collision',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seed(otherOwner: 'other-user' | 'null') {
  const owner = await createTestUser();
  const other = await createTestUser();
  const org = await createTestOrganization();
  const orgId = org.id;
  for (const [u, role] of [[owner.id, 'member'], [other.id, 'admin']] as const) {
    await sql`
      INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
      VALUES (${`mem_${u}`}, ${orgId}, ${u}, ${role}, NOW())
    `;
  }
  const manifests = {
    [CONNECTOR]: {
      manifest: MANIFEST,
      manifest_hash: deviceManifestHash(MANIFEST as DeviceConnectorManifest),
      received_at: new Date().toISOString(),
    },
  };
  const [dev] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id,
      last_seen_at, connector_manifests
    ) VALUES (
      ${owner.id}, ${`mac-${Math.random().toString(36).slice(2, 10)}`}, 'macos',
      ${sql.json([CAPABILITY])}, 'Mac mini', ${orgId}, NOW(), ${sql.json(manifests)}
    ) RETURNING id
  `) as unknown as Array<{ id: string }>;
  await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      auth_profile_id, created_by, visibility, device_worker_id
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'preexisting-pin', 'Team Pin Collision', 'active',
      NULL, ${otherOwner === 'null' ? null : other.id}, 'private', ${dev.id}::uuid
    )
  `;
  return { userId: owner.id, orgId };
}

describe('team device wire vs. an existing pin', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

  for (const kind of ['other-user', 'null'] as const) {
    it(`does not log a wire failure when the pinned row has created_by=${kind}`, async () => {
      const { userId, orgId } = await seed(kind);
      const errors = vi.spyOn(logger, 'error');
      try {
        await reconcileDeviceCapabilities(userId);
        const failures = errors.mock.calls.filter((c) =>
          String(c[1] ?? '').includes('Failed to wire device connector')
        );
        expect(failures.map((c) => JSON.stringify(c[0]))).toEqual([]);
      } finally {
        errors.mockRestore();
      }
      const live = (await sql`
        SELECT count(*)::int AS n FROM connections
        WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
      `) as unknown as Array<{ n: number }>;
      expect(live[0].n).toBe(1);
    }, 60_000);
  }
});
