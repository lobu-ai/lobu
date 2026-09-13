/**
 * Derived-event permission envelope — acceptance tests for the fixed
 * `authz/resource-visibility` gate.
 *
 * A derived event's visibility envelope is the set of access resources linked
 * in `events.entity_ids`. The gate requires EVERY linked resource (AND), on
 * ANY connection state — including server-derived rows with
 * `connection_id IS NULL` (fresh `save_content` saves carry no connection).
 * Membership is proven by a live `member_of` edge whose claim is `manual` or
 * is owned by a currently-enforced connection; stale authorities fail closed.
 *
 * Proves both directions through the real seams (`search` recall and
 * `read_knowledge` exact reads): an absent result alone is never the assertion
 * — each deny has a matching allow for an entitled caller.
 */

import {
  type GithubRepoInput,
  githubAclSource,
  githubReposToResources,
  normalizeGithubRepoFullName,
} from '@lobu/connectors/github-identity';
import {
  slackAclSource,
  slackChannelsToResources,
} from '@lobu/connectors/slack-identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAccessGraph } from '../../../authz/access-graph';
import { pgBigintArray } from '../../../db/client';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { search } from '../../../tools/search';
import { ensureRelationshipType, upsertEdges } from '../../../utils/edge-writes';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { MANUAL_RELATIONSHIP_CLAIM_KEY } from '../../../utils/relationship-claims';
import { withAclEdgeWrite } from '../../../utils/relationship-validation';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  insertChatConnectionRow,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMBEDDING_DIM = 768;
function axisVec(axis: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[axis] = 1;
  return v;
}

function ctxFor(orgId: string, userId: string | null): ToolContext {
  return {
    organizationId: orgId,
    userId,
    memberRole: userId ? 'owner' : null,
    isAuthenticated: !!userId,
    tokenType: userId ? 'oauth' : 'anonymous',
    scopedToOrg: !userId,
    allowCrossOrg: !!userId,
    scopes: userId ? ['mcp:read', 'mcp:write'] : undefined,
  } as ToolContext;
}

async function seedGithubMember(opts: {
  orgId: string;
  userId: string;
  name: string;
  githubUserId: string;
}): Promise<number> {
  const sql = getTestDb();
  const entity = await createTestEntity({
    name: opts.name,
    entity_type: '$member',
    organization_id: opts.orgId,
    created_by: opts.userId,
  });
  await sql`
    INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
    VALUES
      (${opts.orgId}, ${entity.id}, 'auth_user_id', ${opts.userId}, 'auth:signup'),
      (${opts.orgId}, ${entity.id}, 'github_user_id', ${opts.githubUserId}, 'connector:github')
  `;
  return entity.id;
}

async function recallContentIds(ctx: ToolContext): Promise<Set<number>> {
  const result = await search(
    {
      query: 'envelope-probe',
      query_embedding: axisVec(0),
      include_content: true,
      content_limit: 50,
    } as never,
    {} as never,
    ctx,
  );
  return new Set((result.content ?? []).map((c) => c.id));
}

async function exactContentIds(ctx: ToolContext, ids: number[]): Promise<Set<number>> {
  const result = (await getContent({ content_ids: ids, limit: 50 } as never, {} as never, ctx)) as {
    content?: Array<{ id: number }>;
  };
  return new Set((result.content ?? []).map((c) => c.id));
}

describe('derived-event permission envelope', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    clearEntityLinkRulesCache();
  });

  async function setupGithubRepos() {
    const org = await createTestOrganization({ name: 'Envelope' });
    const alice = await createTestUser({ email: 'envelope-alice@example.com' });
    const bob = await createTestUser({ email: 'envelope-bob@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    await addUserToOrganization(bob.id, org.id, 'member');
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
      createDefaultFeed: false,
    });
    await seedGithubMember({ orgId: org.id, userId: alice.id, name: 'Alice', githubUserId: '101' });
    await seedGithubMember({ orgId: org.id, userId: bob.id, name: 'Bob', githubUserId: '102' });
    const graph = await buildAccessGraph({
      organizationId: org.id,
      connectionId: String(conn.id),
      connectorKey: githubAclSource.key,
      resourceNamespace: githubAclSource.resourceNamespace,
      memberIdentities: githubAclSource.memberIdentities,
      resources: githubReposToResources([
        { fullName: 'acme/repo-a', collaborators: [{ login: 'alice', id: 101 }] },
        { fullName: 'acme/repo-b', collaborators: [{ login: 'bob', id: 102 }] },
      ] as GithubRepoInput[]),
    });
    const repoA =
      graph.resourceEntityIds[normalizeGithubRepoFullName('acme/repo-a') as string];
    const repoB =
      graph.resourceEntityIds[normalizeGithubRepoFullName('acme/repo-b') as string];
    return { org, alice, bob, conn, repoA, repoB };
  }

  it('a null-connection stamped event is denied to non-members and allowed to members', async () => {
    const { org, alice, bob, repoA } = await setupGithubRepos();
    // Fresh derived save shape: no connection (as save_content writes), stamped.
    const derived = await createTestEvent({
      organization_id: org.id,
      content: 'derived knowhow from a private repo',
      entity_ids: [repoA],
      embedding: axisVec(0),
    });

    expect((await recallContentIds(ctxFor(org.id, bob.id))).has(derived.id)).toBe(false);
    expect((await exactContentIds(ctxFor(org.id, bob.id), [derived.id])).has(derived.id)).toBe(
      false,
    );
    expect((await recallContentIds(ctxFor(org.id, alice.id))).has(derived.id)).toBe(true);
    expect((await exactContentIds(ctxFor(org.id, alice.id), [derived.id])).has(derived.id)).toBe(
      true,
    );
  });

  it('a two-resource derived event requires every resource (AND, not OR)', async () => {
    const { org, alice, bob, conn, repoA, repoB } = await setupGithubRepos();
    const derived = await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      connector_key: 'github',
      content: 'combined knowhow from repo A and repo B',
      entity_ids: [repoA, repoB],
      embedding: axisVec(0),
    });

    // Alice owns repo-a only, Bob repo-b only — neither sees the combined row.
    expect((await recallContentIds(ctxFor(org.id, alice.id))).has(derived.id)).toBe(false);
    expect((await recallContentIds(ctxFor(org.id, bob.id))).has(derived.id)).toBe(false);
    expect((await exactContentIds(ctxFor(org.id, alice.id), [derived.id])).has(derived.id)).toBe(
      false,
    );
  });

  it('end-to-end: channel-stamped save_content knowhow is channel-gated', async () => {
    const org = await createTestOrganization({ name: 'Channel Envelope' });
    const alice = await createTestUser({ email: 'chan-alice@example.com' });
    const bob = await createTestUser({ email: 'chan-bob@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    await addUserToOrganization(bob.id, org.id, 'member');
    const TEAM_ID = 'T0ENVELOPE';
    const CHANNEL_ID = 'C0ENG';
    // Production Slack shape: the ACL sync graphs under the chat RUNTIME id
    // (`slackinst-…`), the ACL row carries that runtime id, and the
    // membership edges are claimed under the stored numeric row. A numeric
    // `String(conn.id)` here would mask a runtime/numeric key mismatch, so
    // this test uses the runtime path end to end.
    const RUNTIME_CONN_ID = 'slackinst-T0ENVELOPE';
    await insertChatConnectionRow({
      id: RUNTIME_CONN_ID,
      organizationId: org.id,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: TEAM_ID },
    });
    // Alice is in #eng; Bob is not. Seed $member entities carrying both claims.
    const sql = getTestDb();
    for (const [user, name, slackUser] of [
      [alice, 'Alice', 'U01ALICE'],
      [bob, 'Bob', 'U01BOB'],
    ] as const) {
      const member = await createTestEntity({
        name,
        entity_type: '$member',
        organization_id: org.id,
        created_by: user.id,
      });
      await sql`
        INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
        VALUES
          (${org.id}, ${member.id}, 'auth_user_id', ${user.id}, 'auth:signup'),
          (${org.id}, ${member.id}, 'slack_user_id', ${`${TEAM_ID}:${slackUser}`}, 'connector:slack')
      `;
    }
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: RUNTIME_CONN_ID,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM_ID, [
        { channelId: CHANNEL_ID, name: 'eng', memberSlackUserIds: ['U01ALICE'] },
      ]),
    });
    // The ACL row must carry the runtime id — the key the gate compares
    // against after resolving edge claims through their connections row.
    const aclRows = await sql<{ connection_id: string }[]>`
      SELECT connection_id FROM authz_source_acl_state
      WHERE organization_id = ${org.id}
    `;
    expect(aclRows.map((r) => r.connection_id)).toContain(RUNTIME_CONN_ID);

    const saved = (await saveContent(
      {
        content: 'distilled #eng knowhow: ship the migration next sprint',
        semantic_type: 'summary',
        title: 'eng knowhow',
        metadata: {},
      } as never,
      {} as never,
      {
        ...ctxFor(org.id, alice.id),
        sourceContext: { platform: 'slack', teamId: TEAM_ID, channelId: CHANNEL_ID },
      } as ToolContext,
    )) as { id: number; entity_ids: number[] };
    expect(saved.entity_ids.length).toBeGreaterThan(0);
    // Guard against a vacuous pass: the stamp must be a live $resource entity,
    // or the row would be ordinary org-visible content and both recalls below
    // would succeed for the wrong reason.
    const stampedTypes = await sql<{ slug: string }[]>`
      SELECT et.slug
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ANY(${pgBigintArray(saved.entity_ids)}::bigint[]) AND e.deleted_at IS NULL
    `;
    expect(stampedTypes.map((r) => r.slug)).toContain('$resource');

    // save_content writes no embedding; backfill one so recall can find the row.
    await sql`
      INSERT INTO event_embeddings (event_id, embedding, embedding_model)
      VALUES (${saved.id}, ${JSON.stringify(axisVec(0))}::vector, ${getConfiguredEmbeddingModel()})
    `;

    expect((await recallContentIds(ctxFor(org.id, bob.id))).has(saved.id)).toBe(false);
    expect((await exactContentIds(ctxFor(org.id, bob.id), [saved.id])).has(saved.id)).toBe(false);
    expect((await recallContentIds(ctxFor(org.id, alice.id))).has(saved.id)).toBe(true);
  });

  it('a manual-claim membership satisfies the envelope with no enforced connection', async () => {
    const org = await createTestOrganization({ name: 'Manual Envelope' });
    const alice = await createTestUser({ email: 'manual-alice@example.com' });
    const bob = await createTestUser({ email: 'manual-bob@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    await addUserToOrganization(bob.id, org.id, 'member');
    const aliceMember = await createTestEntity({
      name: 'Alice',
      entity_type: '$member',
      organization_id: org.id,
      created_by: alice.id,
    });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${aliceMember.id}, 'auth_user_id', ${alice.id}, 'auth:signup')
    `;
    const resource = await createTestEntity({
      name: 'project-apollo',
      entity_type: '$resource',
      organization_id: org.id,
    });
    const memberOfTypeId = await ensureRelationshipType({
      organizationId: org.id,
      slug: 'member_of',
      name: 'Member of',
      description: 'test manual membership',
    });
    // Project-managed grant: manual authority, immediately authoritative — no
    // connector sync or ACL-state row behind it.
    await withAclEdgeWrite(sql, (tx) =>
      upsertEdges({
        db: tx,
        organizationId: org.id,
        relationshipTypeId: memberOfTypeId,
        pairs: [{ fromEntityId: aliceMember.id, toEntityId: resource.id }],
        source: 'manual',
        confidence: 1.0,
        createdBy: alice.id,
        claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
        onConflict: 'ignore',
      }),
    );

    const derived = await createTestEvent({
      organization_id: org.id,
      content: 'apollo-scoped note',
      entity_ids: [resource.id],
      embedding: axisVec(0),
    });

    expect((await recallContentIds(ctxFor(org.id, alice.id))).has(derived.id)).toBe(true);
    expect((await recallContentIds(ctxFor(org.id, bob.id))).has(derived.id)).toBe(false);
  });

  it('revoking source freshness restricts already-derived outputs on subsequent reads', async () => {
    const { org, alice, bob, conn, repoA } = await setupGithubRepos();
    const derived = await createTestEvent({
      organization_id: org.id,
      content: 'derived knowhow from a private repo',
      entity_ids: [repoA],
      embedding: axisVec(0),
    });
    expect((await recallContentIds(ctxFor(org.id, alice.id))).has(derived.id)).toBe(true);

    // The sync stalls: Alice's membership edge is now stale authority.
    const sql = getTestDb();
    await sql`
      UPDATE authz_source_acl_state
      SET last_synced_at = current_timestamp - interval '90 minutes'
      WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
    `;

    expect((await recallContentIds(ctxFor(org.id, alice.id))).has(derived.id)).toBe(false);
    expect((await recallContentIds(ctxFor(org.id, bob.id))).has(derived.id)).toBe(false);
  });

  it('ordinary unstamped saves stay org-visible (no regression for plain knowledge)', async () => {
    const org = await createTestOrganization({ name: 'Plain Knowledge' });
    const alice = await createTestUser({ email: 'plain-alice@example.com' });
    const bob = await createTestUser({ email: 'plain-bob@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    await addUserToOrganization(bob.id, org.id, 'member');

    const saved = (await saveContent(
      {
        content: 'shared team note with no source restrictions',
        semantic_type: 'note',
        title: 'plain note',
        metadata: {},
      } as never,
      {} as never,
      ctxFor(org.id, alice.id),
    )) as { id: number };

    expect((await exactContentIds(ctxFor(org.id, bob.id), [saved.id])).has(saved.id)).toBe(true);
  });
});
