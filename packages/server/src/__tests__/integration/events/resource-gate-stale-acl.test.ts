/**
 * Resource visibility gate — STALE-ACL fail-closed (the events counterpart to
 * slack-channel-visibility.test.ts's "fails closed when the graph ages past the
 * freshness window").
 *
 * The generic resource gate (`authz/resource-visibility`) gates connector-sourced
 * `events` (GitHub repos, …) by resource membership, but ONLY when the connection
 * is currently ACL-enforced (full+fresh+in-window). The latent bug this test pins:
 * a connection whose `authz_source_acl_state` row EXISTS but is no longer enforcing
 * (aged past the freshness window / marked failed / partial) must FAIL CLOSED —
 * its resource-linked events must NOT reach a non-member. Before the fix the gate
 * used a bare `NOT IN (enforced)` passthrough, so a stale connection's events
 * leaked to non-members; this reproduces that (goes red without the fix) and the
 * three-state split makes it green.
 *
 * Uses explicit embeddings + query_embedding so the recall candidate path is
 * deterministic without a live embedding service (mirrors github-repo-visibility).
 */

import {
  type GithubRepoInput,
  githubAclSource,
  githubReposToResources,
  normalizeGithubRepoFullName,
} from '@lobu/connectors/github-identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
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

describe('resource visibility gate — stale ACL fails closed (e2e via search_memory)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    clearEntityLinkRulesCache();
  });

  /**
   * Set up an org with a GitHub connection whose ACL graph is materialized:
   * Alice (collaborator 101) is a member of repo-a only; Bob (102) of repo-b.
   * One org-visible event per repo. Returns the ids so tests can assert recall.
   */
  async function setupEnforcedWorkspace() {
    const org = await createTestOrganization({ name: 'Acme Stale' });
    const alice = await createTestUser({ name: 'Alice', email: 'alice-stale@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');

    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
      createDefaultFeed: false,
    });

    await seedSignedInMember({ orgId: org.id, userId: alice.id, name: 'Alice', githubUserId: '101' });

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

    return { org, alice, conn, eventAId: eventA.id, eventBId: eventB.id };
  }

  it('fails closed when the graph ages past the freshness window (a non-member sees NONE, not both)', async () => {
    const { org, conn, eventAId, eventBId } = await setupEnforcedWorkspace();

    // Sanity: while FRESH, a non-member (no $member) sees nothing of the enforced
    // connection — the enforced membership branch requires a resolved member.
    const freshIntruder = await recallContentIds(ctxFor(org.id, 'intruder-user-id'));
    expect(freshIntruder.has(eventAId)).toBe(false);
    expect(freshIntruder.has(eventBId)).toBe(false);

    // The sync stops: age this connection's ACL row past the 60-min window. The
    // row STILL EXISTS — so the connection must NOT fall back to the legacy fence
    // (which would re-expose both org-visible events); it must FAIL CLOSED.
    // Pre-fix, the bare `NOT IN (enforced)` passthrough made both events visible
    // to the non-member here → this assertion went red (leak).
    const sql = getTestDb();
    await sql`
      UPDATE authz_source_acl_state
      SET last_synced_at = current_timestamp - interval '90 minutes'
      WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
    `;

    const staleIntruder = await recallContentIds(ctxFor(org.id, 'intruder-user-id'));
    expect(staleIntruder.has(eventAId)).toBe(false);
    expect(staleIntruder.has(eventBId)).toBe(false);
  });

  it('fails closed even for a genuine member once the graph is stale (no stale-membership re-exposure)', async () => {
    const { org, alice, conn, eventAId, eventBId } = await setupEnforcedWorkspace();

    // FRESH: Alice (member of repo-a) recalls repo-a only.
    const fresh = await recallContentIds(ctxFor(org.id, alice.id));
    expect(fresh.has(eventAId)).toBe(true);
    expect(fresh.has(eventBId)).toBe(false);

    // Mark the connection's ACL row failed (stale, not aged) — same fail-closed
    // requirement: an onboarded connection that is not currently enforcing serves
    // NOTHING rather than falling back to the legacy fence and re-exposing repo-b.
    const sql = getTestDb();
    await sql`
      UPDATE authz_source_acl_state
      SET freshness_state = 'failed', updated_at = current_timestamp
      WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
    `;

    const stale = await recallContentIds(ctxFor(org.id, alice.id));
    expect(stale.has(eventAId)).toBe(false);
    expect(stale.has(eventBId)).toBe(false);
  });

  it('fails closed when the graph was never built: stamped events are gated by their stamps, not the legacy fence', async () => {
    const { org, alice, eventAId, eventBId } = await setupEnforcedWorkspace();

    // Drop the ACL state entirely → no currently-enforced authority owns the
    // membership edges, so NEITHER stamped event recalls — not even repo-a for
    // its own collaborator. A resource stamp is a requirement, not a hint: with
    // no fresh authority to satisfy it, the gate fails closed rather than
    // falling back to the legacy fence. (Before the envelope, both rows were
    // served here; that passthrough is exactly the derived-knowledge leak this gate closes.)
    const sql = getTestDb();
    await sql`DELETE FROM authz_source_acl_state WHERE organization_id = ${org.id}`;

    const ids = await recallContentIds(ctxFor(org.id, alice.id));
    expect(ids.has(eventAId)).toBe(false);
    expect(ids.has(eventBId)).toBe(false);
  });
});
