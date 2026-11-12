import { beforeAll, describe, expect, it } from 'vitest';
import { parsePgNumberArray } from '../../../db/client';
import { SaveContentResultSchema, saveContent } from '../../../tools/save_content';
import { validateToolResult } from '../../../tools/validate-args';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

function contextFor(organizationId: string, userId: string, memberRole: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole,
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: true,
    scopes: ['mcp:write'],
    headlessResult: true,
  } as ToolContext;
}

async function storedEntityIds(eventId: number): Promise<number[]> {
  const [row] = await getTestDb()`SELECT entity_ids FROM events WHERE id = ${eventId}`;
  return parsePgNumberArray(row?.entity_ids);
}

describe('save_memory entity name references', () => {
  let orgId: string;
  let owner: ToolContext;
  let member: ToolContext;
  let person: number;
  let repo: number;
  let systemRecord: number;
  let foreignRecord: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Synthetic name refs' });
    orgId = org.id;
    const ownerUser = await createTestUser({ email: 'name-refs-owner@example.com' });
    const memberUser = await createTestUser({ email: 'name-refs-member@example.com' });
    await addUserToOrganization(ownerUser.id, orgId, 'owner');
    await addUserToOrganization(memberUser.id, orgId, 'member');
    owner = contextFor(orgId, ownerUser.id, 'owner');
    member = contextFor(orgId, memberUser.id, 'member');

    person = (await createTestEntity({ name: 'Jane Doe Synthetic', entity_type: 'person', organization_id: orgId })).id;
    repo = (await createTestEntity({ name: 'acme/widgets', entity_type: 'product', organization_id: orgId })).id;
    // A system record sharing the person's name must not make it ambiguous.
    // (A parent keeps its slug distinct from the person's.)
    systemRecord = (await createTestEntity({ name: 'Jane Doe Synthetic', entity_type: '$member', organization_id: orgId, parent_id: repo })).id;
    // Two same-type records with one name are ambiguous.
    const first = await createTestEntity({ name: 'Sam Twin Synthetic', entity_type: 'person', organization_id: orgId });
    await createTestEntity({ name: 'Sam Twin Synthetic', entity_type: 'person', organization_id: orgId, parent_id: first.id });
    // A record in another workspace never resolves here.
    const other = await createTestOrganization({ name: 'Synthetic other workspace' });
    foreignRecord = (await createTestEntity({ name: 'Elsewhere Synthetic', entity_type: 'person', organization_id: other.id })).id;
  });

  it('links exact names, reports the rest, and still saves', async () => {
    const result = await saveContent({
      semantic_type: 'content',
      content: 'Jane Doe ships acme/widgets.',
      entity_ids: [
        { name: 'jane doe synthetic' },
        { name: 'ACME/WIDGETS' },
        repo,
        { name: 'Jane' },
        { name: 'Sam Twin Synthetic' },
        { name: 'Elsewhere Synthetic' },
      ],
    }, {} as never, owner);

    const stored = await storedEntityIds(result.id);
    expect(stored).toEqual(expect.arrayContaining([person, repo]));
    expect(stored.filter((id) => id === repo)).toHaveLength(1);
    expect(result.unlinked).toEqual([
      { name: 'Jane', reason: 'not_found' },
      { name: 'Sam Twin Synthetic', reason: 'ambiguous' },
      { name: 'Elsewhere Synthetic', reason: 'not_found' },
    ]);
  });

  it('replays the stored outcome instead of resolving again', async () => {
    const args = {
      semantic_type: 'content',
      content: 'A later record must not change a replay.',
      idempotency_key: 'synthetic-name-refs-replay',
      entity_ids: [{ name: 'Late Record Synthetic' }],
    };
    const first = await saveContent(args, {} as never, owner);
    expect(first.unlinked).toEqual([{ name: 'Late Record Synthetic', reason: 'not_found' }]);

    await createTestEntity({ name: 'Late Record Synthetic', entity_type: 'person', organization_id: orgId });
    const replay = await saveContent(args, {} as never, owner);
    expect(replay.created).toBe(false);
    expect(replay.id).toBe(first.id);
    expect(replay.unlinked).toEqual(first.unlinked);
  });

  it('replays a not_writable receipt stored before members could link', async () => {
    const idempotencyKey = 'synthetic-name-refs-stored-not-writable';
    const unlinked = [{ name: 'Jane Doe Synthetic', reason: 'not_writable' }];
    const original = await createTestEvent({
      organization_id: orgId,
      content: 'A member saved this before readable records could be linked.',
      metadata: { _lobu_idempotency_key: idempotencyKey, _lobu_unlinked_entity_names: unlinked },
    });
    const replay = await saveContent({
      semantic_type: 'content',
      content: 'A member saved this before readable records could be linked.',
      idempotency_key: idempotencyKey,
      entity_ids: [{ name: 'Jane Doe Synthetic' }],
    }, {} as never, member);
    expect(validateToolResult(SaveContentResultSchema, replay)).toMatchObject({ id: original.id, created: false, unlinked });
  });

  it('keeps a retry on its stored links after a namesake appears', async () => {
    // A kind only this record's type declares: validation needs the name to link.
    // ($member declares its own kinds, as in production, so others are rejected.)
    await getTestDb()`
      UPDATE entity_types SET event_kinds = ${getTestDb().json({ content: { description: 'Content' } })}
      WHERE organization_id = ${orgId} AND slug = '$member'
    `;
    await getTestDb()`
      INSERT INTO entity_types (organization_id, slug, name, event_kinds, created_at, updated_at)
      VALUES (${orgId}, 'review-target', 'Review target',
        ${getTestDb().json({ review_metric: { description: 'A review metric' } })}, NOW(), NOW())
    `;
    const target = await createTestEntity({ name: 'Review Target Synthetic', entity_type: 'review-target', organization_id: orgId });
    const args = {
      semantic_type: 'review_metric',
      content: 'A metric for the review target.',
      idempotency_key: 'synthetic-name-refs-kind-replay',
      entity_ids: [{ name: 'Review Target Synthetic' }],
    };
    const first = await saveContent(args, {} as never, owner);
    expect(await storedEntityIds(first.id)).toContain(target.id);

    await createTestEntity({ name: 'Review Target Synthetic', entity_type: 'review-target', organization_id: orgId, parent_id: target.id });
    const replay = await saveContent(args, {} as never, owner);
    expect(replay).toMatchObject({ id: first.id, created: false, unlinked: [] });
  });

  it('lets a member link records they can read, but not system or foreign records', async () => {
    const result = await saveContent({
      semantic_type: 'content',
      content: 'A member notes Jane and acme/widgets.',
      entity_ids: [{ name: 'Jane Doe Synthetic' }, repo],
    }, {} as never, member);
    expect(result.unlinked).toEqual([]);
    expect(await storedEntityIds(result.id)).toEqual(expect.arrayContaining([person, repo]));

    await expect(saveContent({
      semantic_type: 'content', content: 'x', entity_ids: [systemRecord],
    }, {} as never, member)).rejects.toThrow(/system record/);
    await expect(saveContent({
      semantic_type: 'content', content: 'x', entity_ids: [foreignRecord],
    }, {} as never, member)).rejects.toThrow(/not found in this workspace/);
  });

  it('rejects blank names and more than the name limit', async () => {
    await expect(saveContent({
      semantic_type: 'content', content: 'x', entity_ids: [{ name: '   ' }],
    }, {} as never, owner)).rejects.toThrow(/blank/);
    await expect(saveContent({
      semantic_type: 'content', content: 'x',
      entity_ids: Array.from({ length: 21 }, (_, i) => ({ name: `Name ${i}` })),
    }, {} as never, owner)).rejects.toThrow(/at most 20 names/);
  });
});
