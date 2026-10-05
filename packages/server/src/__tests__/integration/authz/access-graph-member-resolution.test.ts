/**
 * `resolveMembers` resolution safety — the ACL engine's member-side matcher.
 *
 * `member_of` edges are a READ ACL, so who a member resolves to decides who can
 * recall a channel's messages. Two resolution hazards are covered here:
 *
 *   1. A soft-DELETED entity still owns its identity rows (an ordinary delete
 *      does not tombstone them the way a merge repoints them). Resolving onto it
 *      writes edges to a dead entity. A replacement holding only a secondary
 *      would split the account, so an occupied primary must fail closed.
 *   2. A member whose identities match DIFFERENT entities is ambiguous. Picking
 *      by identity-array order is undefined semantics on an access-control path:
 *      a stale or shared secondary claim (an old email, a recycled login) would
 *      hand one person another person's channel access. The source's `primary`
 *      namespace is its own stable per-account key, so it governs alone — it
 *      wins a cross-tier conflict, and when PRESENT it never falls through to
 *      a secondary match (a fresh primary means a distinct account, even while
 *      a recycled secondary still points at the old person). Only a member with
 *      no primary claim at all matches secondaries equal-weight. These are the
 *      tier semantics the entity-link create path already documents (`primary`
 *      in connector-types.ts); resolution must agree with creation.
 *
 * Uses the GitHub source because it already declares two member identities
 * (`github_user_id` primary + `github_login` — and a collaborator may carry
 * only the login), so every tier is a shipped shape.
 */

import {
  type GithubRepoInput,
  githubAclSource,
  githubReposToResources,
} from '@lobu/connectors/github-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAccessGraph } from '../../../authz/access-graph';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const CONN = 'conn-gh-resolution';

async function ensureType(orgId: string, slug: string, name: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, ${slug}, ${name}, current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
}

async function seedOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureType(org.id, 'person', 'Person');
  return { org, user };
}

async function addIdentity(
  orgId: string,
  entityId: number,
  namespace: string,
  identifier: string,
  scopeKey: string | null = null
): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    )
    VALUES (
      ${orgId}, ${entityId}, ${namespace}, ${identifier}, 'connector:github', ${scopeKey}
    )
  `;
}

async function livePersons(orgId: string) {
  const sql = getTestDb();
  return sql<{ id: number; name: string }[]>`
    SELECT e.id, e.name
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${orgId} AND et.slug = 'person' AND e.deleted_at IS NULL
    ORDER BY e.id
  `;
}

async function memberOfFromIds(orgId: string): Promise<number[]> {
  const sql = getTestDb();
  const rows = await sql<{ from_entity_id: number }[]>`
    SELECT r.from_entity_id
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.organization_id = ${orgId}
      AND rt.slug = 'member_of'
      AND r.deleted_at IS NULL
    ORDER BY r.from_entity_id
  `;
  return rows.map((r) => Number(r.from_entity_id));
}

function buildGraph(params: {
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

describe('access graph member resolution', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('does not resolve a member onto a SOFT-DELETED entity', async () => {
    const { org, user } = await seedOrg('Deleted Owner Org');
    const gh = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      slug: CONN,
      created_by: user.id,
    });

    // An entity that owns the member's identity, then gets ordinarily deleted.
    // An ordinary delete does NOT move or tombstone its identity rows.
    const dead = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Deleted Person',
      created_by: user.id,
    });
    await addIdentity(org.id, dead.id, 'github_user_id', '501');
    const sql = getTestDb();
    await sql`
      UPDATE entities SET deleted_at = current_timestamp
      WHERE id = ${dead.id} AND organization_id = ${org.id}
    `;

    await buildGraph({
      organizationId: org.id,
      connectionId: String(gh.id),
      repos: [
        {
          fullName: 'acme/widgets',
          collaborators: [{ id: 501, login: 'ghost' }],
        },
      ],
    });

    const edgeFroms = await memberOfFromIds(org.id);
    // The dead entity must never gain an edge — it cannot read anything, so an
    // edge to it silently removes the member from the audience.
    expect(edgeFroms).not.toContain(dead.id);

    // The deleted owner still holds the primary claim. A fresh secondary
    // cannot justify a replacement person or an ACL edge without that primary.
    expect(await livePersons(org.id)).toHaveLength(0);
    expect(edgeFroms).toEqual([]);
  });

  it('does not construct ACL edges from a tenant-scoped lookalike claim', async () => {
    const { org, user } = await seedOrg('Tenant lookalike ACL org');
    const gh = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      slug: CONN,
      created_by: user.id,
    });
    const tenantOwner = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Other tenant owner',
      created_by: user.id,
    });
    await addIdentity(org.id, tenantOwner.id, 'github_user_id', '501', 'tenant-other');

    await buildGraph({
      organizationId: org.id,
      connectionId: String(gh.id),
      repos: [
        {
          fullName: 'acme/widgets',
          collaborators: [{ id: 501, login: 'new-org-claim' }],
        },
      ],
    });

    const edgeFroms = await memberOfFromIds(org.id);
    expect(edgeFroms).toHaveLength(1);
    expect(edgeFroms).not.toContain(tenantOwner.id);
    const identities = await getTestDb()<
      { entity_id: number | string; scope_key: string | null }[]
    >`
      SELECT entity_id, scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'github_user_id'
        AND identifier = '501'
        AND deleted_at IS NULL
      ORDER BY scope_key NULLS FIRST
    `;
    expect(identities).toHaveLength(2);
    expect(identities.some((identity) => identity.scope_key === null)).toBe(true);
  });

  it('resolves an ambiguous member deterministically via the PRIMARY identity', async () => {
    const { org, user } = await seedOrg('Ambiguous Org');
    const gh = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      slug: CONN,
      created_by: user.id,
    });

    // Two DIFFERENT live entities, each owning one of the member's claims.
    // `github_user_id` is the source's primary (stable, per-account) key;
    // `github_login` is secondary and can be recycled to another account.
    const byPrimary = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Real Account',
      created_by: user.id,
    });
    await addIdentity(org.id, byPrimary.id, 'github_user_id', '777');

    const bySecondary = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Recycled Login Holder',
      created_by: user.id,
    });
    await addIdentity(org.id, bySecondary.id, 'github_login', 'octocat');

    await buildGraph({
      organizationId: org.id,
      connectionId: String(gh.id),
      repos: [
        {
          fullName: 'acme/widgets',
          collaborators: [{ id: 777, login: 'octocat' }],
        },
      ],
    });

    const edgeFroms = await memberOfFromIds(org.id);
    // The primary claim wins; the recycled-login holder must NOT inherit access.
    expect(edgeFroms).toEqual([byPrimary.id]);
    expect(edgeFroms).not.toContain(bySecondary.id);
  });

  it('does NOT fall through to a secondary match when the primary is present but unmatched', async () => {
    const { org, user } = await seedOrg('Recycled Login Org');
    const gh = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      slug: CONN,
      created_by: user.id,
    });

    // Only the SECONDARY claim matches: 'octocat' was recycled to a brand-new
    // account (fresh github_user_id that matches nothing). Collapsing onto the
    // old login holder would hand them the new account's repo access.
    const oldHolder = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Old Login Holder',
      created_by: user.id,
    });
    await addIdentity(org.id, oldHolder.id, 'github_login', 'octocat');

    await buildGraph({
      organizationId: org.id,
      connectionId: String(gh.id),
      repos: [
        {
          fullName: 'acme/widgets',
          collaborators: [{ id: 999, login: 'octocat' }],
        },
      ],
    });

    const edgeFroms = await memberOfFromIds(org.id);
    expect(edgeFroms).not.toContain(oldHolder.id);

    // A distinct person was minted for the new account and owns the edge.
    const persons = await livePersons(org.id);
    expect(persons).toHaveLength(2);
    const minted = persons.find((p) => p.id !== oldHolder.id);
    expect(minted).toBeDefined();
    expect(edgeFroms).toEqual([minted?.id]);
  });

  it('still collapses equal-weight on a secondary when the member carries NO primary claim', async () => {
    const { org, user } = await seedOrg('Login Only Org');
    const gh = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      slug: CONN,
      created_by: user.id,
    });

    // The GitHub collaborators shape may omit the numeric id; the login is then
    // the member's only claim and must keep matching (no duplicate person).
    const holder = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Login Holder',
      created_by: user.id,
    });
    await addIdentity(org.id, holder.id, 'github_login', 'hubot');

    await buildGraph({
      organizationId: org.id,
      connectionId: String(gh.id),
      repos: [
        {
          fullName: 'acme/widgets',
          collaborators: [{ login: 'hubot' }],
        },
      ],
    });

    const edgeFroms = await memberOfFromIds(org.id);
    expect(edgeFroms).toEqual([holder.id]);
    expect(await livePersons(org.id)).toHaveLength(1);
  });

  it('does not grant a recycled SECONDARY holder the edge when the PRIMARY owner is soft-deleted', async () => {
    const { org, user } = await seedOrg('Dead Primary Live Secondary Org');
    const gh = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      slug: CONN,
      created_by: user.id,
    });

    // The member's PRIMARY claim is owned by an entity that was ordinarily
    // deleted — the entity is soft-deleted but its identity row stays live and
    // still points at it, so the identifier is taken but resolves to nothing.
    const dead = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Deleted Real Account',
      created_by: user.id,
    });
    await addIdentity(org.id, dead.id, 'github_user_id', '501');
    const sql = getTestDb();
    await sql`
      UPDATE entities SET deleted_at = current_timestamp
      WHERE id = ${dead.id} AND organization_id = ${org.id}
    `;

    // A DIFFERENT, live person holds the recycled SECONDARY claim.
    const recycled = await createTestEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Recycled Login Holder',
      created_by: user.id,
    });
    await addIdentity(org.id, recycled.id, 'github_login', 'octocat');

    await buildGraph({
      organizationId: org.id,
      connectionId: String(gh.id),
      repos: [
        {
          fullName: 'acme/widgets',
          collaborators: [{ id: 501, login: 'octocat' }],
        },
      ],
    });

    // Both resolution sites must honour the tier rule. The fast path defers to
    // the create engine (primary present but unmatched), and the create engine's
    // orphan-recovery re-resolution must NOT union the secondary hit — a
    // tier-blind union sees exactly one live hit and adopts the recycled-login
    // holder, handing them the dead account's channel access.
    const edgeFroms = await memberOfFromIds(org.id);
    expect(edgeFroms).not.toContain(recycled.id);
    expect(edgeFroms).not.toContain(dead.id);
  });
});
