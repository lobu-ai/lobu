/**
 * Entity CRUD via the post-#348 SDK surface.
 *
 * Replaces deleted manage_entity tests. Covers create/read/update/delete,
 * member-role enforcement, and tree-deletion guards. Cross-org isolation
 * is asserted in cross-org-isolation.test.ts.
 */

import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, type Env } from '../../../index';
import { runScript } from '../../../sandbox/run-script';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';
import { mcpRequest } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('entity CRUD', () => {
  let owner: TestApiClient;
  let member: TestApiClient;
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ownerUser: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Entity Test Org' });
    ownerUser = await createTestUser({ email: 'entity-owner@test.com' });
    const memberUser = await createTestUser({ email: 'entity-member@test.com' });
    await addUserToOrganization(ownerUser.id, org.id, 'owner');
    await addUserToOrganization(memberUser.id, org.id, 'member');

    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: ownerUser.id,
      memberRole: 'owner',
    });
    member = await TestApiClient.for({
      organizationId: org.id,
      userId: memberUser.id,
      memberRole: 'member',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
  });

  it('creates an entity, reads it back, and lists it', async () => {
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'Acme Corp',
    })) as { entity?: { id: number; name: string } };
    expect(created.entity?.id).toBeGreaterThan(0);
    expect(created.entity?.name).toBe('Acme Corp');

    const got = (await owner.entities.get({ entity_id: created.entity!.id })) as {
      entity?: { name: string };
    };
    expect(got.entity?.name).toBe('Acme Corp');

    const list = (await owner.entities.list({ entity_type: 'company' })) as {
      entities?: Array<{ id: number }>;
    };
    expect(list.entities?.some((e) => e.id === created.entity!.id)).toBe(true);
  });

  it('updates an entity', async () => {
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'Old Name',
    })) as { entity: { id: number } };
    await owner.entities.update({ entity_id: created.entity.id, name: 'New Name' });
    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity: { name: string };
    };
    expect(got.entity.name).toBe('New Name');
  });

  it('hard-deletes a fresh entity with no event history', async () => {
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'To Delete',
    })) as { entity: { id: number } };
    await owner.entities.delete({ entity_id: created.entity.id });
    // Hard-deleted: get() throws not-found rather than returning a tombstone.
    await expect(owner.entities.get({ entity_id: created.entity.id })).rejects.toThrow(/not found/i);
  });

  it('get honors include_deleted: soft-deleted entity is hidden by default, returned with the flag', async () => {
    const sql = getTestDb();
    const created = (await owner.entities.create({
      entity_type: 'company',
      name: 'Soft Deleted Co',
    })) as { entity: { id: number } };
    const id = created.entity.id;

    // Soft-delete directly (stamp deleted_at) so getEntity's default
    // `AND e.deleted_at IS NULL` filters it out.
    await sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${id}`;

    // Default read: the soft-deleted row is invisible → not-found.
    await expect(owner.entities.get({ entity_id: id })).rejects.toThrow(/not found/i);

    // With include_deleted: the row comes back.
    const got = (await owner.entities.get({
      entity_id: id,
      include_deleted: true,
    })) as { entity?: { id: number; name: string } };
    expect(got.entity?.id).toBe(id);
    expect(got.entity?.name).toBe('Soft Deleted Co');
  });

  describe('update with an expected precondition', () => {
    const env = {
      ENVIRONMENT: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
      RATE_LIMIT_ENABLED: 'false',
    } as Env;

    let deals = 0;
    async function createDeal(metadata: Record<string, unknown>): Promise<number> {
      deals += 1;
      const created = (await owner.entities.create({
        entity_type: 'company',
        name: `Precondition Target ${deals}`,
        metadata,
      })) as { entity: { id: number } };
      return created.entity.id;
    }

    async function row(id: number) {
      const [found] = await getTestDb()`
        SELECT name, metadata, field_controls, updated_at FROM entities WHERE id = ${id}
      `;
      return found as {
        name: string;
        metadata: Record<string, unknown>;
        field_controls: Record<string, unknown>;
        updated_at: Date;
      };
    }

    // Events about the entity itself. A token's call is still audited as a
    // failed tool invocation; that ledger records the attempt, not a change.
    async function entityEventCount(id: number): Promise<number> {
      const [counted] = await getTestDb()`
        SELECT count(*)::int AS c FROM events
        WHERE organization_id = ${org.id} AND ${id}::bigint = ANY(entity_ids)
      `;
      return counted.c as number;
    }

    async function pendingApprovalCount(): Promise<number> {
      const [counted] = await getTestDb()`
        SELECT count(*)::int AS c FROM runs
        WHERE organization_id = ${org.id}
          AND action_key = 'entity_field_change'
          AND approval_status = 'pending'
      `;
      return counted.c as number;
    }

    async function rejection(promise: Promise<unknown>) {
      try {
        await promise;
      } catch (error) {
        return error as { httpStatus?: number; code?: string; details?: Record<string, unknown>; message: string };
      }
      throw new Error('expected the update to be refused');
    }

    it('applies the update when every expected value matches the live row', async () => {
      const id = await createDeal({ stage: 'open', amount: 100, tags: { region: 'emea', tier: 1 } });
      const result = (await owner.entities.update({
        entity_id: id,
        // Object key order differs from the stored value; the compare is structural.
        expected: { stage: 'open', amount: 100, tags: { tier: 1, region: 'emea' } },
        metadata: { stage: 'won' },
      })) as { applied_fields?: string[] };
      expect(result.applied_fields).toEqual(['stage']);
      expect((await row(id)).metadata.stage).toBe('won');
    });

    it('treats null as matching a field that was never set', async () => {
      const id = await createDeal({ stage: 'open' });
      await owner.entities.update({ entity_id: id, expected: { closed_reason: null }, metadata: { closed_reason: 'budget' } });
      expect((await row(id)).metadata.closed_reason).toBe('budget');

      // ...and null does not match a field that holds a value.
      const failure = await rejection(
        owner.entities.update({ entity_id: id, expected: { closed_reason: null }, metadata: { closed_reason: 'timing' } }),
      );
      expect(failure.httpStatus).toBe(409);
      expect(failure.details).toEqual({ mismatched_fields: ['closed_reason'] });
      expect((await row(id)).metadata.closed_reason).toBe('budget');
    });

    it('refuses a stale write over REST with 409 PRECONDITION_FAILED and changes nothing', async () => {
      const id = await createDeal({ stage: 'open', amount: 100 });
      await owner.entities.update({ entity_id: id, metadata: { stage: 'negotiating' } });
      const before = await row(id);
      const events = await entityEventCount(id);
      const pat = await createTestPAT(ownerUser.id, org.id, { scope: 'mcp:read mcp:write' });

      const response = await app.fetch(
        new Request(`http://gateway.test/api/${org.slug}/manage_entity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pat.token}` },
          body: JSON.stringify({
            action: 'update',
            entity_id: id,
            name: 'Renamed',
            expected: { stage: 'open', amount: 100 },
            metadata: { stage: 'won', amount: 250 },
          }),
        }),
        env,
      );
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({
        code: 'PRECONDITION_FAILED',
        retryable: false,
        // Names only: the live value the caller did not read never leaks.
        mismatched_fields: ['stage'],
      });
      expect(JSON.stringify(body)).not.toContain('negotiating');

      // MCP `tools/call` reports the same structured refusal.
      const mcp = await mcpRequest('tools/call', {
        name: 'manage_entity',
        arguments: { action: 'update', entity_id: id, expected: { stage: 'open' }, metadata: { stage: 'won' } },
      }, { token: pat.token, orgSlug: org.slug });
      expect(mcp.result.isError).toBe(true);
      expect(mcp.result.structuredContent.error).toMatchObject({
        code: 'PRECONDITION_FAILED',
        retryable: false,
        mismatched_fields: ['stage'],
      });

      // One stale field refuses the whole call: the matching `amount` and the
      // name were not written either.
      expect(await row(id)).toEqual(before);
      expect(await entityEventCount(id)).toBe(events);
    });

    it('queues no approval when a write that would need one is stale', async () => {
      const id = await createDeal({ stage: 'open' });
      // A human edit claims `stage`, so an agent's change to it becomes an approval.
      await owner.entities.update({ entity_id: id, metadata: { stage: 'qualified' } });
      const agent = await createTestAgent({ organizationId: org.id, ownerUserId: ownerUser.id });
      const agentClient = owner.withAuth({ agentId: agent.agentId });
      const before = await row(id);
      const events = await entityEventCount(id);
      const approvals = await pendingApprovalCount();

      const failure = await rejection(
        agentClient.entities.update({ entity_id: id, expected: { stage: 'open' }, metadata: { stage: 'won' } }),
      );
      expect(failure.httpStatus).toBe(409);
      expect(failure.code).toBe('PRECONDITION_FAILED');
      expect(failure.details).toEqual({ mismatched_fields: ['stage'] });
      expect(await row(id)).toEqual(before);
      expect(await entityEventCount(id)).toBe(events);
      expect(await pendingApprovalCount()).toBe(approvals);

      // The same write with a current expected value does queue the approval.
      const queued = (await agentClient.entities.update({
        entity_id: id,
        expected: { stage: 'qualified' },
        metadata: { stage: 'won' },
      })) as { approval_queued?: boolean };
      expect(queued.approval_queued).toBe(true);
      expect(await pendingApprovalCount()).toBe(approvals + 1);
    });

    it('hands a run_sdk script that catches the refusal the mismatched field names', async () => {
      const id = await createDeal({ stage: 'open', amount: 100 });
      await owner.entities.update({ entity_id: id, metadata: { amount: 120 } });
      const result = await runScript({
        source: `export default async (_ctx, client) => {
          try {
            await client.entities.update({ entity_id: ${id}, expected: { stage: 'open', amount: 100 }, metadata: { stage: 'won' } });
            return 'written';
          } catch (error) {
            return { name: error.name, details: error.details };
          }
        }`,
        sdk: owner,
        sdkMode: 'full',
        maxAccessLevel: 'write',
      });
      expect(result.success).toBe(true);
      expect(result.returnValue).toEqual({ name: 'ToolUserError', details: { mismatched_fields: ['amount'] } });
      expect((await row(id)).metadata.stage).toBe('open');
    });

    it('rejects more than 50 expected keys and non-metadata keys with a 400', async () => {
      const id = await createDeal({ stage: 'open' });
      const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`field_${i}`, null]));
      const oversized = await rejection(owner.entities.update({ entity_id: id, expected: tooMany, metadata: { stage: 'won' } }));
      expect(oversized.httpStatus).toBe(400);

      for (const key of ['name', 'content', 'slug', 'parent_id']) {
        const failure = await rejection(
          owner.entities.update({ entity_id: id, expected: { [key]: null }, metadata: { stage: 'won' } }),
        );
        expect(failure.httpStatus).toBe(400);
        expect(failure.code).toBe('VALIDATION');
        expect(failure.message).toContain(key);
      }
      expect((await row(id)).metadata.stage).toBe('open');
    });

    it('checks the value a concurrent writer committed while this update waited on the row lock', async () => {
      const id = await createDeal({ stage: 'open' });
      const concurrent = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        const { pending } = await concurrent.begin(async (tx) => {
          await tx`SELECT id FROM entities WHERE id = ${id} FOR UPDATE`;
          // Started after the competing writer holds the row: its pre-lock read
          // still sees `open`, so only a check under the lock can catch this.
          const pending = owner.entities
            .update({ entity_id: id, expected: { stage: 'open' }, metadata: { stage: 'won' } })
            .then(() => null, (error: unknown) => error as { httpStatus?: number; details?: unknown });
          const deadline = Date.now() + 10_000;
          for (;;) {
            const [blocked] = await tx`
              SELECT count(*)::int AS c FROM pg_stat_activity
              WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
            `;
            if (blocked.c > 0) break;
            if (Date.now() > deadline) throw new Error('the update never waited on the held row lock');
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await tx`
            UPDATE entities SET metadata = metadata || '{"stage":"lost"}'::jsonb WHERE id = ${id}
          `;
          return { pending };
        });
        const failure = await pending;
        expect(failure?.httpStatus).toBe(409);
        expect(failure?.details).toEqual({ mismatched_fields: ['stage'] });
        expect((await row(id)).metadata.stage).toBe('lost');
      } finally {
        await concurrent.end({ timeout: 5 });
      }
    }, 30_000);
  });

  describe('access control', () => {
    it('lets a member create + list (write scope is enough)', async () => {
      const created = (await member.entities.create({
        entity_type: 'company',
        name: 'Member-Created',
      })) as { entity?: { id: number } };
      expect(created.entity?.id).toBeGreaterThan(0);

      const list = (await member.entities.list({ entity_type: 'company' })) as {
        entities?: unknown[];
      };
      expect(Array.isArray(list.entities)).toBe(true);
    });

    it('blocks a member from deleting entities (delete requires owner/admin)', async () => {
      const created = (await owner.entities.create({
        entity_type: 'company',
        name: 'Owner-Only-Delete',
      })) as { entity: { id: number } };
      await expect(member.entities.delete({ entity_id: created.entity.id })).rejects.toThrow(
        /admin|owner|access/i
      );
    });

    it('blocks a read-only-scoped member from creating', async () => {
      const reader = member.withAuth({ scopes: ['mcp:read'] });
      await expect(
        reader.entities.create({ entity_type: 'company', name: 'Read-Only' })
      ).rejects.toThrow(/scope|access/i);
    });
  });
});
