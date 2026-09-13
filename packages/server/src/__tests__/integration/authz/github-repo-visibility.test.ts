/**
 * GitHub repo visibility gate — END TO END through `search_memory` content recall.
 *
 * Proves the GENERIC resource gate (`authz/resource-visibility`) enforces GitHub
 * repo membership over `events` the same way the Slack gate enforces channels
 * over chat: an org member who is a collaborator on repo A (but not repo B)
 * recalls only repo A's events. This is the second source riding the same engine
 * + the same registry-driven gate — the proof that Linear/Jira slot in with just
 * a `sources.ts` entry + a connector that stamps the resource identity on its
 * events (here simulated by linking the repo entity into `events.entity_ids`).
 *
 * Uses explicit embeddings + query_embedding so the recall candidate path is
 * deterministic without a live embedding service (mirrors
 * events/search-content-visibility.test.ts).
 */

import {
  type GithubRepoInput,
  githubAclSource,
  githubReposToResources,
  normalizeGithubRepoFullName,
} from '@lobu/connectors/github-identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncGithubConnectionAcl } from '../../../authz/github-acl-sync';
import { buildAccessGraph } from '../../../authz/access-graph';

/** Test helper mirroring the GitHub ACL sync's normalize + generic-engine call. */
function buildGithubRepoGraph(params: {
  organizationId: string;
  connectionId: string;
  repos: GithubRepoInput[];
}) {
  return buildAccessGraph({
    organizationId: params.organizationId,
    connectionId: params.connectionId,
    connectorKey: githubAclSource.key,
    resourceNamespace: githubAclSource.resourceNamespace,
    memberIdentities: githubAclSource.memberIdentities,
    resources: githubReposToResources(params.repos),
  });
}
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import {
  clearEntityLinkRulesCache,
  resolveEventAttributionsForItems,
} from '../../../utils/entity-link-upsert';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
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
    scopes: userId ? ['mcp:read'] : undefined,
  } as ToolContext;
}

/** A signed-in member who has also linked GitHub (auth_user_id + github_user_id). */
async function seedSignedInMember(opts: {
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
      query: 'github-recall-probe',
      query_embedding: axisVec(0),
      include_content: true,
      content_limit: 50,
    } as never,
    {} as never,
    ctx,
  );
  return new Set((result.content ?? []).map((c) => c.id));
}

describe('github repo visibility gate (e2e via search_memory content)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    clearEntityLinkRulesCache();
  });

  async function setupWorkspace() {
    const org = await createTestOrganization({ name: 'Acme' });
    const alice = await createTestUser({ name: 'Alice', email: 'alice-gh@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');

    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
      createDefaultFeed: false,
    });

    // Alice signed in + linked GitHub as collaborator id 101.
    await seedSignedInMember({ orgId: org.id, userId: alice.id, name: 'Alice', githubUserId: '101' });

    // Alice (101) collaborates on repo-a only; Bob (102) on repo-b.
    const graph = await buildGithubRepoGraph({
      organizationId: org.id,
      connectionId: String(conn.id),
      repos: [
        { fullName: 'acme/repo-a', collaborators: [{ login: 'alice', id: 101 }] },
        { fullName: 'acme/repo-b', collaborators: [{ login: 'bob', id: 102 }] },
      ],
    });
    const repoAId = graph.resourceEntityIds[normalizeGithubRepoFullName('acme/repo-a') as string];
    const repoBId = graph.resourceEntityIds[normalizeGithubRepoFullName('acme/repo-b') as string];

    // One event per repo, attributed by entity link (as the connector would stamp).
    const eventA = await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      connector_key: 'github',
      content: 'repo A issue: quarterly metrics dashboard',
      entity_ids: [repoAId],
      embedding: axisVec(0),
    });
    const eventB = await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      connector_key: 'github',
      content: 'repo B issue: confidential quarterly metrics',
      entity_ids: [repoBId],
      embedding: axisVec(0),
    });

    return { org, alice, eventAId: eventA.id, eventBId: eventB.id };
  }

  it('surfaces only the repo the requester collaborates on once the graph is enforced', async () => {
    const { org, alice, eventAId, eventBId } = await setupWorkspace();

    const ids = await recallContentIds(ctxFor(org.id, alice.id));
    expect(ids.has(eventAId)).toBe(true);
    expect(ids.has(eventBId)).toBe(false);
  });

  it('fails closed: a requester with no $member sees NONE of an enforced connection', async () => {
    const { org, eventAId, eventBId } = await setupWorkspace();
    const ids = await recallContentIds(ctxFor(org.id, 'intruder-user-id'));
    expect(ids.has(eventAId)).toBe(false);
    expect(ids.has(eventBId)).toBe(false);
  });

  it('enforces through the PRODUCTION sync path (syncGithubConnectionAcl), not just the test builder', async () => {
    const org = await createTestOrganization({ name: 'Acme Sync' });
    const alice = await createTestUser({ name: 'Alice', email: 'alice-sync@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
      createDefaultFeed: false,
    });
    await seedSignedInMember({ orgId: org.id, userId: alice.id, name: 'Alice', githubUserId: '101' });

    // Drive the REAL sync with a stubbed GitHub API + repo list — exactly as
    // runGithubAclSyncTick wires it in prod. THIS materializes the graph.
    const collaborators: Record<string, { login: string; id: number }[]> = {
      'acme/repo-a': [{ login: 'alice', id: 101 }],
      'acme/repo-b': [{ login: 'bob', id: 102 }],
    };
    const result = await syncGithubConnectionAcl(
      {
        listRepos: async () => [
          { owner: 'acme', repo: 'repo-a' },
          { owner: 'acme', repo: 'repo-b' },
        ],
        fetchCollaborators: async ({ repo }) => collaborators[`${repo.owner}/${repo.repo}`] ?? [],
      },
      { connectionId: String(conn.id), organizationId: org.id },
    );
    expect(result.ok).toBe(true);
    expect(result.reposSynced).toBe(2);

    // Resolve the repo entities the sync materialized, attribute an event to each.
    const sql = getTestDb();
    const repoId = async (fullName: string): Promise<number> => {
      const rows = await sql<{ entity_id: number }>`
        SELECT entity_id FROM entity_identities
        WHERE organization_id = ${org.id} AND namespace = 'github_repo_full_name'
          AND identifier = ${fullName} AND deleted_at IS NULL LIMIT 1`;
      return Number(rows[0].entity_id);
    };
    const eventA = await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      connector_key: 'github',
      content: 'repo A issue: quarterly metrics',
      entity_ids: [await repoId('acme/repo-a')],
      embedding: axisVec(0),
    });
    const eventB = await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      connector_key: 'github',
      content: 'repo B issue: confidential quarterly metrics',
      entity_ids: [await repoId('acme/repo-b')],
      embedding: axisVec(0),
    });

    const ids = await recallContentIds(ctxFor(org.id, alice.id));
    expect(ids.has(eventA.id)).toBe(true);
    expect(ids.has(eventB.id)).toBe(false);
  });

  it('ingestion path: a stamped github event resolves to the SAME repo entity the graph gates on', async () => {
    const org = await createTestOrganization({ name: 'Acme Ingest' });
    const alice = await createTestUser({ name: 'Alice', email: 'alice-ingest@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
      createDefaultFeed: false,
    });
    await seedSignedInMember({ orgId: org.id, userId: alice.id, name: 'Alice', githubUserId: '101' });

    // Graph: alice collaborates on repo-a only.
    const graph = await buildGithubRepoGraph({
      organizationId: org.id,
      connectionId: String(conn.id),
      repos: [
        { fullName: 'acme/repo-a', collaborators: [{ login: 'alice', id: 101 }] },
        { fullName: 'acme/repo-b', collaborators: [{ login: 'bob', id: 102 }] },
      ],
    });
    const repoAId = graph.resourceEntityIds[normalizeGithubRepoFullName('acme/repo-a') as string];

    // Drive the REAL ingestion entity-link resolver with the connector's repo
    // link rule shape (mirrors GITHUB_REPO_ENTITY_LINK in connectors/src/github.ts)
    // on an event stamped with github_repo_full_name. This proves the chain the
    // connector emits → server resolves: metadata.github_repo_full_name resolves
    // to the SAME repo entity the graph built (one entity, no forked duplicate).
    const githubRepoLinkRule = {
      entityType: '$resource',
      autoCreate: true,
      titlePath: 'metadata.github_repo_full_name',
      identities: [
        { namespace: 'github_repo_full_name', eventPath: 'metadata.github_repo_full_name', primary: true },
      ],
    };
    const resolved = await resolveEventAttributionsForItems({
      connectorKey: 'github',
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { github_repo_full_name: 'acme/repo-a' } }],
      rules: { issue: [githubRepoLinkRule] },
    });
    const ingestedRepoIds = resolved.get(0) ?? [];
    // The repo entity ingestion links to IS the one the graph gates on.
    expect(ingestedRepoIds).toContain(repoAId);

    // And an event linked via that ingestion-resolved entity is gated for alice.
    const event = await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      connector_key: 'github',
      content: 'repo A issue: quarterly metrics',
      entity_ids: ingestedRepoIds,
      embedding: axisVec(0),
    });
    const ids = await recallContentIds(ctxFor(org.id, alice.id));
    expect(ids.has(event.id)).toBe(true);
  });

  it('fails closed WITHOUT a graph: stamped events need a fresh authority, not the legacy fence', async () => {
    const { org, alice, eventAId, eventBId } = await setupWorkspace();
    // Drop the ACL state → no enforced authority owns the membership edges, so
    // the stamped events recall for NOBODY — the stamp is a requirement that no
    // fresh graph satisfies. Unstamped org-visible content on the same
    // never-graphed connection keeps the legacy fence (see the approval
    // permalink suite); stamped content never falls back to it.
    const sql = getTestDb();
    await sql`DELETE FROM authz_source_acl_state WHERE organization_id = ${org.id}`;
    const ids = await recallContentIds(ctxFor(org.id, alice.id));
    expect(ids.has(eventAId)).toBe(false);
    expect(ids.has(eventBId)).toBe(false);
  });
});
