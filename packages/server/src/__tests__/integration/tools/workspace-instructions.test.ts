/**
 * Integration tests: buildWorkspaceInstructions render fidelity + org-wide
 * `guidance` context injection.
 *
 * Render fixes pinned here (all data was already STORED, but dropped at
 * render time):
 *   1. entity_types.description
 *   2. per-field metadata_schema.properties[field].description (and the
 *      top-level-keys bug: a real JSON Schema used to render "type, properties")
 *   3. entity_relationship_types.description
 *   4. connector_definitions.description
 *   5. ACL-managed relationship types render a `read-only: access control` hint,
 *      on the same purpose-OR-slug test that link/unlink already 403 on
 *   6. an inverse pair only collapses to one line when both halves share that
 *      hint, so the ACL-managed half is never dropped by the name ordering
 *
 * Org guidance pinned here:
 *   - admin-authored `guidance` events render under "### Organization Context"
 *   - superseded guidance disappears (only the current event renders)
 *   - hard char cap with deterministic truncation
 *   - connector-sourced (connection_id IS NOT NULL) guidance is NOT injected
 *   - authorship gate: non-admin members and system contexts are rejected at
 *     save time; owners/admins are accepted
 */

import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROD_PG_VALUE_OPTIONS } from '../../../db/client';
import { deleteContent } from '../../../tools/delete_content';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import {
  GUIDANCE_SEMANTIC_TYPE,
  loadOrgGuidanceBlock,
  ORG_GUIDANCE_CHAR_BUDGET,
  ORG_GUIDANCE_TRUNCATION_MARKER,
} from '../../../utils/org-guidance';
import { primeMemberEventKinds } from '../../../utils/event-kind-validation';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { buildWorkspaceInstructions } from '../../../utils/workspace-instructions';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const env = {} as never;

describe('buildWorkspaceInstructions render fixes', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Render Org' });
    const sql = getTestDb();

    // Entity type with a description and a REAL JSON-Schema metadata_schema
    // (type/properties/required at the top level) with per-field descriptions.
    await sql`
      INSERT INTO entity_types (slug, name, description, metadata_schema, organization_id)
      VALUES (
        'product',
        'Product',
        'Products we track for resale',
        ${sql.json({
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Canonical product URL' },
            status: { type: 'string' },
          },
          required: ['url'],
        })},
        ${org.id}
      )
    `;

    // Legacy bare field-map schema (no top-level `type`/`properties`).
    await sql`
      INSERT INTO entity_types (slug, name, metadata_schema, organization_id)
      VALUES (
        'legacy',
        'Legacy',
        ${sql.json({ price: { type: 'number', description: 'Unit price in EUR' }, sku: {} })},
        ${org.id}
      )
    `;

    // Tenant-authored descriptions and similarly named fields are user data, while
    // exact reserved engine fields are internal implementation details.
    await sql`
      INSERT INTO entity_types (slug, name, description, metadata_schema, organization_id)
      VALUES (
        'legacy-automation',
        'Legacy Automation',
        'A club for bird observers',
        ${sql.json({
          type: 'object',
          properties: {
            birding_window_id: { type: 'number', description: 'Birding window that produced it' },
            automation_id: { type: 'number', description: 'Automation that wrote it' },
            observer_count: { type: 'number', description: 'Number of bird observers' },
          },
        })},
        ${org.id}
      )
    `;

    // Relationship type with a description.
    await sql`
      INSERT INTO entity_relationship_types (slug, name, description, organization_id)
      VALUES ('supplies', 'Supplies', 'Which company supplies which product', ${org.id})
    `;

    // Two ACL-managed types, one per branch of the guard's purpose-OR-slug
    // test, so a regression that narrows the predicate to either half alone
    // still fails here. `grants_role` is classified but NOT the ACL slug;
    // `member_of` is the ACL slug but NOT yet classified — the real window
    // between a config declaring it and the first ACL sync running.
    await sql`
      INSERT INTO entity_relationship_types (slug, name, description, organization_id)
      VALUES
        ('grants_role', 'Grants role', 'Role grant synced from the IdP', ${org.id}),
        ('member_of', 'Member of', 'Access-control membership', ${org.id})
    `;
    // Classify directly: `lobu_guard_authorization_edges` fires on
    // entity_relationships, not on the type table, so setting `purpose` needs no
    // `lobu.acl_write` privilege.
    await sql`
      UPDATE entity_relationship_types
      SET purpose = 'authorization'
      WHERE organization_id = ${org.id} AND slug = 'grants_role'
    `;

    // Two inverse pairs. The listing collapses a pair to one line, but the
    // write rule is decided per type, so a pair whose halves disagree cannot be
    // collapsed without losing one half's rule. `reports_to`/`has_report`
    // disagree; `ships_to`/`shipped_from` agree and must still collapse.
    //
    // Written in this order deliberately: assertNotAuthorizationType refuses to
    // pair a type that is ALREADY classified, so a straddling pair is reached
    // by pairing while both halves are ordinary and letting the ACL sync
    // classify one half afterwards — which is exactly what happens below.
    await sql`
      INSERT INTO entity_relationship_types (slug, name, description, organization_id)
      VALUES
        ('has_report', 'Has report', 'Reporting line, ordinary vocabulary', ${org.id}),
        ('reports_to', 'Reports to', 'Reporting line synced from the IdP', ${org.id}),
        ('shipped_from', 'Shipped from', 'Ordinary pair, both halves writable', ${org.id}),
        ('ships_to', 'Ships to', 'Ordinary pair, both halves writable', ${org.id})
    `;
    await sql`
      UPDATE entity_relationship_types a
      SET inverse_type_id = b.id
      FROM entity_relationship_types b
      WHERE a.organization_id = ${org.id}
        AND b.organization_id = ${org.id}
        AND (a.slug, b.slug) IN (
          ('has_report', 'reports_to'),
          ('reports_to', 'has_report'),
          ('shipped_from', 'ships_to'),
          ('ships_to', 'shipped_from')
        )
    `;
    await sql`
      UPDATE entity_relationship_types
      SET purpose = 'authorization'
      WHERE organization_id = ${org.id} AND slug = 'reports_to'
    `;

    // Org-scoped connector definition with a description + an active connection.
    await sql`
      INSERT INTO connector_definitions (key, name, description, actions_schema, organization_id, status)
      VALUES (
        'shop.sync',
        'Shop Sync',
        'Order + inventory sync for the shop',
        ${sql.json({ list_orders: {}, refund_order: {} })},
        ${org.id},
        'active'
      )
    `;
    await createTestConnection({
      organization_id: org.id,
      connector_key: 'shop.sync',
      createDefaultFeed: false,
    });

    // Capability discovery must not depend on a pre-existing connection.
    await sql`
      INSERT INTO connector_definitions (key, name, description, actions_schema, organization_id, status)
      VALUES (
        'shop.disconnected',
        'Disconnected Shop',
        'Available before setup',
        ${sql.json({ create_order: {} })},
        ${org.id},
        'active'
      )
    `;
  });

  it('renders entity type descriptions and per-field descriptions from metadata_schema.properties', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).not.toBeNull();
    expect(out).toContain(
      '- product ("Product") — Products we track for resale — fields: url (Canonical product URL), status'
    );
    // The old doubly-lossy render printed the JSON-Schema envelope keys.
    expect(out).not.toContain('fields: type, properties');
  });

  it('still renders legacy bare field-map schemas as field names (with descriptions)', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    // jsonb canonicalizes key order (shorter keys first): sku before price.
    expect(out).toContain('- legacy ("Legacy") — fields: sku, price (Unit price in EUR)');
  });

  it('preserves tenant-authored language while hiding exact internal fields', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('A club for bird observers');
    expect(out).toContain('observer_count (Number of bird observers)');
    expect(out).not.toContain('automation_id');
    expect(out).toContain('birding_window_id (Birding window that produced it)');
  });

  it('renders relationship type descriptions', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('- supplies — Which company supplies which product');
  });

  it('marks a CLASSIFIED relationship type read-only so agents stop attempting 403 writes', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('- grants_role (read-only: access control) — Role grant synced from the IdP');
  });

  it('marks the ACL slug read-only even before classification has run', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    // purpose IS NULL here, so a purpose-only predicate would render this as
    // freely writable — the exact case assertNotAclManagedEdge still 403s.
    expect(out).toContain('- member_of (read-only: access control) — Access-control membership');
  });

  it('does not mark ordinary relationship types read-only', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    // Guards the other direction: ACL_MANAGED_TYPE_SQL uses IS NOT DISTINCT
    // FROM precisely so a NULL purpose does not sweep every type in.
    expect(out).not.toContain('- supplies (read-only: access control)');
  });

  it('keeps both halves of an inverse pair when only one is access-controlled', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    // A blanket collapse keeps whichever half `ORDER BY name ASC` reaches
    // first, so `reports_to` — the half that 403s — can vanish from the
    // vocabulary entirely, leaving the agent unaware the slug exists at all,
    // let alone that it is read-only. Both halves are asserted, so this holds
    // whichever way the ordering falls.
    expect(out).toContain(
      '- reports_to (inverse: has_report, read-only: access control) — Reporting line synced from the IdP'
    );
    expect(out).toContain('- has_report (inverse: reports_to) — Reporting line, ordinary vocabulary');
  });

  it('still collapses an inverse pair whose halves share the same write rule', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    // The other direction: keeping both halves unconditionally would double
    // every ordinary pair in the listing for no gain.
    // Asserted as "exactly one of the pair" rather than naming the winner:
    // which half survives is decided by `ORDER BY name ASC` under whatever
    // collation the database runs, and that is not the property under test.
    const emitted = out!
      .split('\n')
      .filter((l) => l.startsWith('- ships_to') || l.startsWith('- shipped_from'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatch(
      /^- (ships_to \(inverse: shipped_from\)|shipped_from \(inverse: ships_to\)) — Ordinary pair, both halves writable$/
    );
  });

  it('renders connector definition descriptions', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain(
      '- shop.sync (Order + inventory sync for the shop): list_orders, refund_order'
    );
  });

  it('requires exact manifest operation keys instead of deriving them from display names', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain(
      'Treat `operation_key` as an opaque manifest identifier: copy it exactly from `operations.listAvailable`'
    );
    expect(out).toContain('Never derive it from an operation display name');
  });

  it('renders disconnected connector capabilities so agents can discover setup', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain(
      '- shop.disconnected (Available before setup): create_order'
    );
  });

  it('renders workspace-data query guidance without org-specific setup', async () => {
    const emptyOrg = await createTestOrganization({ name: 'Empty Render Org' });
    const out = await buildWorkspaceInstructions(emptyOrg.id);
    expect(out).toContain(
      'When asked about workspace data — including people, leads, companies, connections, feeds, runs, or counts — query it before answering'
    );
    expect(out).toContain(
      'On a direct bare OAuth connection, `search_memory` searches every currently accessible workspace the user granted'
    );
    expect(out).toContain('can be narrowed with its singular `workspace` argument');
    expect(out).toContain('pinned connections and all other tools stay in the current workspace');
    expect(out).toContain(
      'Do not claim you can see only chat/Slack messages or channel members without querying workspace data first'
    );
    const directiveIdx =
      out?.indexOf('When asked about workspace data') ?? -1;
    const toolSurfaceIdx = out?.indexOf('### Tool surface') ?? -1;
    expect(directiveIdx).toBeGreaterThan(-1);
    expect(directiveIdx).toBeLessThan(toolSurfaceIdx);
  });

  it('keeps direct MCP instructions user-directed and free of automatic personal-data capture', async () => {
    const directOrg = await createTestOrganization({ name: 'Direct MCP Instructions Org' });
    const out = await buildWorkspaceInstructions(directOrg.id, { audience: 'direct-mcp' });

    expect(out).toContain(
      "Use Lobu's tools only when they are relevant to the user's request"
    );
    expect(out).toContain('### Writes and approvals');
    expect(out).toContain('Use it only when the user asks');
    expect(out).not.toContain("Use it proactively — don't wait to be asked");
    expect(out).not.toContain('### Saving (do this automatically)');
    expect(out).not.toContain('Preferences, opinions, or personal details');
    expect(out).not.toContain('### Schema: Entity Types');
    expect(out).not.toContain('Direct MCP Instructions Org');
  });

  it('requires direct MCP clients to copy exact manifest operation keys', async () => {
    const directOrg = await createTestOrganization({ name: 'Direct Operation Key Org' });
    const out = await buildWorkspaceInstructions(directOrg.id, { audience: 'direct-mcp' });

    expect(out).toContain('copy it exactly from `operations.listAvailable`');
    expect(out).toContain('never derive it from the display name');
    expect(out).toContain('refresh discovery instead of inventing a key');
  });

  it('documents the search_memory workspace narrowing argument to the direct MCP audience', async () => {
    // The managed-agent text explains the singular `workspace` argument in a
    // sentence addressed to "a direct bare OAuth connection" — precisely the
    // audience that now receives DIRECT_MCP_INSTRUCTIONS instead. The static
    // text is the only capability documentation that audience ever gets, so
    // the narrowing knob has to be named here or it is discoverable nowhere.
    const directOrg = await createTestOrganization({ name: 'Narrowing Arg Org' });
    const out = await buildWorkspaceInstructions(directOrg.id, { audience: 'direct-mcp' });

    expect(out).toContain('`workspace` argument');
    expect(out).toContain('multi-workspace grant');
  });
});

describe('org-wide guidance context', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ownerCtx: ToolContext;
  let memberCtx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    org = await createTestOrganization({ name: 'Guidance Org' });
    const owner = await createTestUser({ name: 'Owner' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    ownerCtx = ownerToolContext(org.id, owner.id);

    const member = await createTestUser({ name: 'Member' });
    await addUserToOrganization(member.id, org.id, 'member');
    memberCtx = { ...ownerToolContext(org.id, member.id), memberRole: 'member' };
  });

  it('rejects a non-admin member saving guidance (fail closed)', async () => {
    await expect(
      saveContent(
        { content: 'evil injected context', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        memberCtx
      )
    ).rejects.toThrow(/owners\/admins/i);

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).not.toContain('evil injected context');
  });

  it('rejects a system context (no member role) saving guidance', async () => {
    const systemCtx: ToolContext = { ...ownerCtx, userId: null, memberRole: null };
    await expect(
      saveContent(
        { content: 'system injected context', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        systemCtx
      )
    ).rejects.toThrow(/owners\/admins/i);
  });

  it('injects admin-authored guidance into workspace instructions, near the top', async () => {
    const saved = (await saveContent(
      {
        title: 'Fiscal year',
        content: 'Our fiscal year starts in February.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      ownerCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('### Organization Context');
    expect(out).toContain('Our fiscal year starts in February.');
    // Near the top: before the schema section.
    const ctxIdx = out!.indexOf('### Organization Context');
    const schemaIdx = out!.indexOf('### Tool surface');
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeLessThan(schemaIdx);
  });

  it('does not expose admin-authored agent guidance to a direct MCP client', async () => {
    const out = await buildWorkspaceInstructions(org.id, { audience: 'direct-mcp' });

    expect(out).not.toContain('### Organization Context');
    expect(out).not.toContain('Our fiscal year starts in February.');
    expect(out).not.toContain('### Schema: Entity Types');
  });

  it('backfills `guidance` into a pre-guidance $member registry so authorship still validates (#1913)', async () => {
    // Org provisioned before `guidance` was a built-in: a populated registry
    // that omits it. Now validated through the registry, the write is rejected
    // unless ensureMemberEntityType additively backfills it on the next save.
    const sql = getTestDb();
    const preOrg = await createTestOrganization({ name: 'Pre-guidance Org' });
    const admin = await createTestUser({ name: 'Admin' });
    await addUserToOrganization(admin.id, preOrg.id, 'admin');
    const adminCtx = { ...ownerToolContext(preOrg.id, admin.id), memberRole: 'admin' };

    // Force the $member type to exist with a registry that omits `guidance`.
    await saveContent(
      { content: 'seed note', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    await sql`
      UPDATE entity_types
      SET event_kinds = event_kinds - 'guidance'
      WHERE slug = '$member' AND organization_id = ${preOrg.id} AND deleted_at IS NULL
    `;
    const stripped = await sql<{ event_kinds: Record<string, unknown> }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${preOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(stripped[0].event_kinds).not.toHaveProperty('guidance');

    // The next guidance write must succeed: backfill + cache re-prime in one call.
    const saved = (await saveContent(
      {
        content: 'Backfilled guidance renders.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const backfilled = await sql<{ event_kinds: Record<string, unknown> }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${preOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(backfilled[0].event_kinds).toHaveProperty('guidance');

    const out = await buildWorkspaceInstructions(preOrg.id);
    expect(out).toContain('Backfilled guidance renders.');
  });

  it('re-primes a stale cache when another replica already backfilled guidance (#1913 cross-replica)', async () => {
    // Two-replica repro: pod A cached a pre-guidance $member registry; pod B
    // (or a migration) then added `guidance` to the DB row. On pod A the next
    // ensureMemberEntityType reads the fresh DB row, finds nothing to write, and
    // takes the no-op path — but it MUST still refresh its own stale cache, or
    // guidance saves on pod A are rejected until the 60s TTL expires.
    const sql = getTestDb();
    const raceOrg = await createTestOrganization({ name: 'Cross-replica Org' });
    const admin = await createTestUser({ name: 'Race Admin' });
    await addUserToOrganization(admin.id, raceOrg.id, 'admin');
    const adminCtx = { ...ownerToolContext(raceOrg.id, admin.id), memberRole: 'admin' };

    // Materialize a $member row that ALREADY contains guidance (as if pod B just
    // backfilled it), so ensureMemberEntityType has nothing to write and takes
    // the guarded no-op path — the exact path that must still prime from DB truth.
    await saveContent(
      { content: 'seed', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    const before = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM entity_types
      WHERE slug = '$member' AND organization_id = ${raceOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;

    // Simulate pod A's stale per-pod cache: prime it with a registry missing
    // guidance. Without the fix, this stale value survives the no-op path.
    primeMemberEventKinds(raceOrg.id, { note: { description: 'General notes' } });

    // Pod A's ensureMemberEntityType runs (as it does at the top of every save):
    // it reads the DB (guidance present), writes nothing, and must re-prime from
    // the live row — not the snapshot it read before a hypothetical concurrent
    // backfill — via the atomic UPDATE ... UNION ALL read.
    await ensureMemberEntityType(raceOrg.id);

    // Prove the no-op path was taken: the guarded UPDATE did not fire, so the row
    // was NOT rewritten. (If it had, this would be the backfill path, not the
    // stale-cache-only path we mean to exercise.)
    const after = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM entity_types
      WHERE slug = '$member' AND organization_id = ${raceOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(after[0].updated_at.getTime()).toBe(before[0].updated_at.getTime());

    // The guidance save must now validate against the refreshed cache.
    const saved = (await saveContent(
      {
        content: 'Cross-replica guidance renders.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const out = await buildWorkspaceInstructions(raceOrg.id);
    expect(out).toContain('Cross-replica guidance renders.');
  });

  it('concurrent cross-replica backfill: the losing UPDATE still primes committed guidance (#1913)', async () => {
    // Two replicas run the guarded backfill on the same pre-guidance row at once.
    // Under READ COMMITTED the second UPDATE blocks on the first's row lock, then
    // re-checks its WHERE against the winner's committed row (guidance now present)
    // and matches ZERO rows. The loser must STILL prime a guidance-bearing
    // registry — its post-UPDATE read has to observe the winner's committed
    // guidance, or it would reject guidance saves until the 60s TTL. This pins
    // that invariant for the two-statement (UPDATE, then fresh-snapshot SELECT)
    // shape the code uses.
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Concurrent-backfill Org' });
    const admin = await createTestUser({ name: 'Backfill Admin' });
    await addUserToOrganization(admin.id, org.id, 'admin');
    const adminCtx = { ...ownerToolContext(org.id, admin.id), memberRole: 'admin' };

    // Materialize $member, strip guidance → an explicit pre-guidance registry.
    await saveContent(
      { content: 'seed', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    await sql`
      UPDATE entity_types SET event_kinds = event_kinds - 'guidance'
      WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
    `;
    const row = await sql<{ id: number }>`
      SELECT id FROM entity_types
      WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    const typeId = row[0].id;
    const patch = { guidance: { description: 'Organization-wide context injected into every agent prompt' } };

    // A second, independent connection = the winning replica. Hold its guarded
    // UPDATE open in a transaction so the loser (main pool) blocks on the lock.
    const url = process.env.DATABASE_URL as string;
    const winner = postgres(url, { max: 1, onnotice: () => {}, ...PROD_PG_VALUE_OPTIONS });
    try {
      // Loser's guarded UPDATE + separate post-UPDATE read (the fix's exact
      // shape). Started while the winner's tx is open so it BLOCKS on the row
      // lock; awaited only after the winner commits.
      let loserUpdate: Promise<Array<{ event_kinds: Record<string, { description?: string }> | null }>>;
      await winner.begin(async (w) => {
        // Winner backfills guidance but does NOT commit yet (tx still open).
        await w`
          UPDATE entity_types
          SET event_kinds = ${w.json(patch)} || event_kinds, updated_at = current_timestamp
          WHERE id = ${typeId} AND event_kinds IS NOT NULL AND NOT (event_kinds ? 'guidance')
        `;

        loserUpdate = sql`
          UPDATE entity_types
          SET event_kinds = ${sql.json(patch)} || event_kinds, updated_at = current_timestamp
          WHERE id = ${typeId} AND event_kinds IS NOT NULL AND NOT (event_kinds ? 'guidance')
        `.then(() =>
          sql<{ event_kinds: Record<string, { description?: string }> | null }>`
            SELECT event_kinds FROM entity_types WHERE id = ${typeId}
          `
        );
        // Give the loser a beat to actually reach the lock wait before we commit.
        await new Promise((r) => setTimeout(r, 200));
        // Winner commits on return from this callback, unblocking the loser.
      });

      // Now the winner has committed; the loser's UPDATE re-checks (0 rows) and
      // its fresh SELECT observes the winner's committed guidance.
      const loserResolved = await loserUpdate!;
      expect(loserResolved[0].event_kinds).toHaveProperty('guidance');
    } finally {
      await winner.end();
    }

    // End state carries guidance; a guidance save validates and renders.
    const saved = (await saveContent(
      { content: 'Concurrent-backfill guidance renders.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('Concurrent-backfill guidance renders.');
  });

  it('backfills only guidance: preserves a concurrent add AND an intentional omission (#1913)', async () => {
    // The backfill adds ONLY the newly-required `guidance` kind, atomically
    // (`{guidance} || event_kinds`, live DB wins per key). It must therefore:
    //  - add `guidance` when missing;
    //  - preserve a kind a concurrent $member schema edit added (no clobber);
    //  - NOT resurrect a default kind the org intentionally REMOVED via
    //    manage_entity_schema (e.g. `todo`) — silently re-enabling it would
    //    override the org's choice.
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Concurrent-edit Org' });
    const admin = await createTestUser({ name: 'Concurrent Admin' });
    await addUserToOrganization(admin.id, org.id, 'admin');
    const adminCtx = { ...ownerToolContext(org.id, admin.id), memberRole: 'admin' };

    // Materialize $member, then: strip `guidance` (pre-guidance org), strip a
    // default the org chose to remove (`todo`), and add an org-authored kind.
    await saveContent(
      { content: 'seed', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    await sql`
      UPDATE entity_types
      SET event_kinds = (event_kinds - 'guidance' - 'todo')
        || '{"org_special": {"description": "authored by the org"}}'::jsonb
      WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
    `;

    // Backfill runs (as at the top of every save).
    await ensureMemberEntityType(org.id);

    const after = await sql<{ event_kinds: Record<string, { description?: string }> }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    const kinds = after[0].event_kinds;
    // guidance backfilled…
    expect(kinds).toHaveProperty('guidance');
    // …the concurrently-authored kind is preserved (not clobbered)…
    expect(kinds.org_special?.description).toBe('authored by the org');
    // …and the intentionally-omitted default stays omitted (not resurrected).
    expect(kinds).not.toHaveProperty('todo');
  });

  it('leaves a NULL $member registry NULL (permissive): ordinary saves still validate (#1913)', async () => {
    // A NULL event_kinds registry means "no allowlist, accept any kind". The
    // guidance backfill must NOT materialize `{guidance}` onto it — that would
    // flip the org from accept-any to accept-ONLY-guidance and reject the next
    // ordinary note/fact save. NULL stays NULL; guidance already validates under
    // permissive mode.
    const sql = getTestDb();
    const nullOrg = await createTestOrganization({ name: 'Null-registry Org' });
    const admin = await createTestUser({ name: 'Null Admin' });
    await addUserToOrganization(admin.id, nullOrg.id, 'admin');
    const adminCtx = { ...ownerToolContext(nullOrg.id, admin.id), memberRole: 'admin' };

    // Materialize $member, then force its registry to NULL (permissive org).
    await saveContent(
      { content: 'seed', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    await sql`
      UPDATE entity_types
      SET event_kinds = NULL
      WHERE slug = '$member' AND organization_id = ${nullOrg.id} AND deleted_at IS NULL
    `;

    // Backfill runs (as at the top of every save) — must be a no-op on NULL.
    await ensureMemberEntityType(nullOrg.id);

    const after = await sql<{ event_kinds: Record<string, unknown> | null }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${nullOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(after[0].event_kinds).toBeNull();

    // An ordinary (non-guidance) save must still validate under permissive mode.
    const note = (await saveContent(
      { content: 'ordinary note still saves', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(note.id).toBeGreaterThan(0);

    // Guidance also validates (permissive accepts any kind) and renders.
    const guided = (await saveContent(
      {
        content: 'Null-registry guidance renders.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(guided.id).toBeGreaterThan(0);
    const out = await buildWorkspaceInstructions(nullOrg.id);
    expect(out).toContain('Null-registry guidance renders.');
  });

  it('supersede replaces guidance: only the current event renders', async () => {
    const v1 = (await saveContent(
      { content: 'All amounts are reported in USD.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      ownerCtx
    )) as { id: number };

    const v2 = (await saveContent(
      {
        content: 'All amounts are reported in EUR.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
        supersedes_event_id: v1.id,
      } as never,
      env,
      ownerCtx
    )) as { id: number };
    expect(v2.id).toBeGreaterThan(v1.id);

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('All amounts are reported in EUR.');
    expect(out).not.toContain('All amounts are reported in USD.');
  });

  it('a deleted (tombstoned) guidance event does NOT render as a blank block', async () => {
    // Deletion here = supersede with an empty tombstone row (events is
    // append-only). The tombstone stamps superseded_by on the target, so the
    // canonical view (current_event_records) masks it. Regression guard: a
    // deleted guidance must not leave a titled-but-empty block behind.
    const tombOrg = await createTestOrganization({ name: 'Tombstone Org' });
    const owner = await createTestUser({ name: 'Tomb Owner' });
    await addUserToOrganization(owner.id, tombOrg.id, 'owner');
    const ctx = ownerToolContext(tombOrg.id, owner.id);

    const saved = (await saveContent(
      {
        title: 'Soon-deleted',
        content: 'This guidance is about to be deleted.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      ctx
    )) as { id: number };

    // Present before delete.
    expect(await loadOrgGuidanceBlock(tombOrg.id)).toContain(
      'This guidance is about to be deleted.'
    );

    // Real delete path: inserts an empty-payload tombstone that supersedes it.
    const del = (await deleteContent(
      { content_id: saved.id } as never,
      env,
      ctx
    )) as { tombstone_ids: number[] };
    expect(del.tombstone_ids.length).toBe(1);

    // Gone — not a blank block, not the old text, no dangling title.
    expect(await loadOrgGuidanceBlock(tombOrg.id)).toBeNull();
    const out = await buildWorkspaceInstructions(tombOrg.id);
    expect(out).not.toContain('This guidance is about to be deleted.');
    expect(out).not.toContain('Soon-deleted');
    expect(out).not.toContain('### Organization Context');
  });

  it('an empty/whitespace-payload guidance row never renders (payload guards)', async () => {
    // Defense-in-depth: even a row that carries semantic_type=guidance,
    // connection_id NULL, and a whitespace-only payload_text (not a NULL, so it
    // slips past the SQL `IS NOT NULL` filter) must be dropped by the trim
    // guard in loadOrgGuidanceBlock — no blank block, no dangling title.
    const emptyOrg = await createTestOrganization({ name: 'Empty Payload Org' });
    const sql = getTestDb();
    await sql`
      INSERT INTO events (
        entity_ids, origin_id, title, payload_type, payload_text,
        semantic_type, connection_id, organization_id, created_at
      ) VALUES (
        '{}'::bigint[], ${'empty-guidance-1'}, ${'Blank'}, 'text', ${'   \n  '},
        ${GUIDANCE_SEMANTIC_TYPE}, NULL, ${emptyOrg.id}, NOW()
      )
    `;

    expect(await loadOrgGuidanceBlock(emptyOrg.id)).toBeNull();
    const out = await buildWorkspaceInstructions(emptyOrg.id);
    expect(out).not.toContain('### Organization Context');
    expect(out).not.toContain('Blank');
  });

  it('rejects a member superseding admin guidance with a non-guidance kind', async () => {
    // The removal path: authorship is admin-gated, so a member must not be able
    // to erase guidance by superseding it with a permitted kind (e.g. note).
    const guarded = (await saveContent(
      { content: 'Protected org context.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      ownerCtx
    )) as { id: number };

    await expect(
      saveContent(
        {
          content: 'member overwrite attempt',
          semantic_type: 'note',
          metadata: {},
          supersedes_event_id: guarded.id,
        } as never,
        env,
        memberCtx
      )
    ).rejects.toThrow(/only organization owners\/admins/i);

    // Still present, still injected.
    expect(await loadOrgGuidanceBlock(org.id)).toContain('Protected org context.');
  });

  it('rejects a member deleting admin guidance', async () => {
    const guarded = (await saveContent(
      { content: 'Do not delete me.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      ownerCtx
    )) as { id: number };

    await expect(
      deleteContent({ content_id: guarded.id } as never, env, memberCtx)
    ).rejects.toThrow(/only organization owners\/admins/i);

    expect(await loadOrgGuidanceBlock(org.id)).toContain('Do not delete me.');
  });

  it('accepts an admin (not just owner) author', async () => {
    const admin = await createTestUser({ name: 'Admin' });
    await addUserToOrganization(admin.id, org.id, 'admin');
    const adminCtx: ToolContext = { ...ownerToolContext(org.id, admin.id), memberRole: 'admin' };
    const saved = (await saveContent(
      { content: 'Admins may also author org context.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);
  });

  it('does NOT inject connector-sourced guidance events', async () => {
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'shop.sync2',
    });
    await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      semantic_type: GUIDANCE_SEMANTIC_TYPE,
      content: 'connector smuggled context',
    });

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).not.toContain('connector smuggled context');
  });

  it('does NOT inject webhook-ingested guidance (connector_key set, connection_id NULL)', async () => {
    // webhook-ingest.ts writes connector_key='webhook:<id>' with a NULL
    // connection_id and a caller-configurable semantic_type. `connection_id IS
    // NULL` alone is NOT proof of admin authorship — the connector_key fence
    // must also exclude it, or a webhook token holder injects org-wide prompt text.
    const webhookOrg = await createTestOrganization({ name: 'Webhook Org' });
    const sql = getTestDb();
    await sql`
      INSERT INTO events (
        entity_ids, origin_id, title, payload_type, payload_text,
        semantic_type, connection_id, connector_key, organization_id, created_at
      ) VALUES (
        '{}'::bigint[], ${'wh-guidance-1'}, ${'Injected'}, 'text',
        ${'webhook injected org context'}, ${GUIDANCE_SEMANTIC_TYPE},
        NULL, ${'webhook:9999'}, ${webhookOrg.id}, NOW()
      )
    `;

    expect(await loadOrgGuidanceBlock(webhookOrg.id)).toBeNull();
    const out = await buildWorkspaceInstructions(webhookOrg.id);
    expect(out).not.toContain('webhook injected org context');
    expect(out).not.toContain('### Organization Context');
  });

  it('rejects non-text and empty-content guidance authorship', async () => {
    await expect(
      saveContent(
        {
          content: 'x',
          semantic_type: GUIDANCE_SEMANTIC_TYPE,
          payload_type: 'json_template',
          payload_template: { kind: 'text', text: 'x' },
          metadata: {},
        } as never,
        env,
        ownerCtx
      )
    ).rejects.toThrow(/'text' or 'markdown'/i);

    await expect(
      saveContent(
        { content: '   ', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        ownerCtx
      )
    ).rejects.toThrow(/non-empty content/i);
  });

  it('caps total injected guidance chars deterministically', async () => {
    // Use a fresh org so the cap math is exact.
    const capOrg = await createTestOrganization({ name: 'Cap Org' });
    const owner = await createTestUser({ name: 'Cap Owner' });
    await addUserToOrganization(owner.id, capOrg.id, 'owner');
    const ctx = ownerToolContext(capOrg.id, owner.id);

    for (const marker of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) {
      await saveContent(
        {
          content: `${marker} ${'x'.repeat(1200)}`,
          semantic_type: GUIDANCE_SEMANTIC_TYPE,
          metadata: {},
        } as never,
        env,
        ctx
      );
    }

    const out = await buildWorkspaceInstructions(capOrg.id);
    expect(out).toContain('ALPHA');
    expect(out).toContain('BRAVO');
    // 4 x ~1206 chars > 3000: the tail must be cut and marked.
    expect(out).toContain(ORG_GUIDANCE_TRUNCATION_MARKER.trim());
    expect(out).not.toContain('DELTA');

    // The rendered guidance block (body + marker) stays WITHIN the declared cap
    // — the marker length is reserved, not appended past the budget.
    const block = await loadOrgGuidanceBlock(capOrg.id);
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(ORG_GUIDANCE_CHAR_BUDGET);
    expect(block!.endsWith(ORG_GUIDANCE_TRUNCATION_MARKER)).toBe(true);
    // Exactly one marker (no partial + duplicate).
    expect(block!.split(ORG_GUIDANCE_TRUNCATION_MARKER.trim()).length).toBe(2);

    // Deterministic: two builds render the identical block.
    const out2 = await buildWorkspaceInstructions(capOrg.id);
    expect(out2).toBe(out);
  });

  it('marks row-cap omission without exceeding the char cap or double-marking', async () => {
    // Many tiny guidance rows: under the char budget individually but over the
    // 100-row cap. Exercises the row-limit path — one marker, still within cap.
    const rowOrg = await createTestOrganization({ name: 'Row Cap Org' });
    const owner = await createTestUser({ name: 'Row Owner' });
    await addUserToOrganization(owner.id, rowOrg.id, 'owner');
    const ctx = ownerToolContext(rowOrg.id, owner.id);

    // 120 rows of ~5 chars each ≈ 600 chars total — well under 3000, but > 100 rows.
    for (let i = 0; i < 120; i++) {
      await saveContent(
        { content: `g${i}`, semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        ctx
      );
    }

    const block = await loadOrgGuidanceBlock(rowOrg.id);
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(ORG_GUIDANCE_CHAR_BUDGET);
    expect(block!.endsWith(ORG_GUIDANCE_TRUNCATION_MARKER)).toBe(true);
    expect(block!.split(ORG_GUIDANCE_TRUNCATION_MARKER.trim()).length).toBe(2);
  });
});
