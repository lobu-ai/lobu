import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization, createTestOrganization, createTestSession,
  createTestUser, ownerToolContext,
} from '../../setup/test-fixtures';
import { post, testRequest } from '../../setup/test-helpers';
import { buildClientSDK } from '../../../sandbox/client-sdk';

describe('workspace navigation through the HTTP and SDK entrypoints', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let ownerCookie: string;
  let memberCookie: string;
  const document = {
    sections: [{ id: 'catalog', label: 'Catalog', items: [{
      id: 'companies', label: 'Companies', target: { type: 'collection', entity_type: 'company' },
      children: [{ id: 'hiring', label: 'Hiring companies', target: { type: 'collection', entity_type: 'company', preset: 'hiring' } }],
    }] }, { id: 'operations', label: 'Private operator dashboards', items: [{
      id: 'overview', label: 'Internal overview', target: { type: 'view', key: 'overview' },
      children: [{ id: 'under-private', label: 'Private grouping label', target: { type: 'collection', entity_type: 'company' } }],
    }] }],
  };
  const call = (body: Record<string, unknown>, cookie: string | undefined = ownerCookie) =>
    post(`/api/${org.slug}/manage_navigation`, { body, cookie });
  const read = async () => {
    const response = await call({ action: 'get' });
    expect(response.status).toBe(200);
    return response.json();
  };

  beforeAll(cleanupTestDatabase);
  beforeEach(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Navigation fixture', visibility: 'public' });
    owner = await createTestUser();
    const member = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(member.id, org.id, 'member');
    ownerCookie = (await createTestSession(owner.id)).cookieHeader;
    memberCookie = (await createTestSession(member.id)).cookieHeader;
    const sql = getTestDb();
    await sql`INSERT INTO entity_types (organization_id, slug, name, metadata_schema)
      VALUES (${org.id}, 'company', 'Company', ${sql.json({
        type: 'object', properties: { hiring: { type: 'boolean' } },
        'x-lobu-collection': { presets: [{ key: 'hiring', label: 'Hiring', selection: {} }] },
      })})`;
    await sql`INSERT INTO views (organization_id, key, name, source_code, content_hash, attach, last_writer)
      VALUES (${org.id}, 'overview', 'Internal overview', 'export default () => null', 'fixture', '[{"workspace":true}]'::jsonb, 'test')`;
  });

  it('uses defaults until configured and preserves hierarchy through HTTP and SDK', async () => {
    const initial = await read();
    expect(initial.document).toBeNull();
    const result = await call({ action: 'set', document, expected_revision: initial.revision });
    expect(result.status).toBe(200);
    const saved = await result.json();
    expect(saved.document).toEqual(document);
    expect(saved.revision).not.toBe(initial.revision);
    const sdk = buildClientSDK(ownerToolContext(org.id, owner.id), { ENVIRONMENT: 'test' });
    expect(await sdk.navigation.get()).toMatchObject({ document, revision: saved.revision });
    const same = await sdk.navigation.set({ document, expected_revision: saved.revision } as never);
    expect(same).toMatchObject({ written: false, revision: saved.revision });
  });

  it('serializes competing saves and rejects missing and stale revisions', async () => {
    const initial = await read();
    const responses = await Promise.all([
      call({ action: 'set', document, expected_revision: initial.revision }),
      call({ action: 'set', document: { sections: [] }, expected_revision: initial.revision }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find(response => response.status === 409)!;
    expect(await conflict.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
    const current = await read();
    expect((await call({ action: 'set', document: null })).status).toBe(409);
    expect((await read()).revision).toBe(current.revision);
  });

  it('keeps an old absent token invalid after reset and rejects cross-workspace tokens', async () => {
    const absent = await read();
    await call({ action: 'set', document, expected_revision: absent.revision });
    const current = await read();
    expect((await call({ action: 'set', document: null, expected_revision: current.revision })).status).toBe(200);
    expect((await read()).document).toBeNull();
    expect((await call({ action: 'set', document, expected_revision: absent.revision })).status).toBe(409);
    const other = await createTestOrganization({ visibility: 'public' });
    await addUserToOrganization(owner.id, other.id, 'owner');
    const response = await post(`/api/${other.slug}/manage_navigation`, { body: { action: 'get' }, cookie: ownerCookie });
    const otherState = await response.json();
    expect((await call({ action: 'set', document, expected_revision: otherState.revision })).status).toBe(409);
  });

  it('projects visitor navigation without leaking private branches and enforces membership', async () => {
    await call({ action: 'set', document, expected_revision: (await read()).revision });
    const publicResponse = await post(`/api/${org.slug}/manage_navigation`, { body: { action: 'get' } });
    expect(publicResponse.status).toBe(200);
    expect((await publicResponse.json()).document).toEqual({ sections: [document.sections[0]] });
    const memberResponse = await call({ action: 'get' }, memberCookie);
    expect((await memberResponse.json()).document).toEqual(document);
    const outsider = await createTestUser();
    const outsiderCookie = (await createTestSession(outsider.id)).cookieHeader;
    expect((await (await call({ action: 'get' }, outsiderCookie)).json()).document)
      .toEqual({ sections: [document.sections[0]] });
    expect((await call({ action: 'set', document: null, expected_revision: (await read()).revision }, memberCookie)).status).toBe(403);
    const privateOrg = await createTestOrganization();
    expect((await post(`/api/${privateOrg.slug}/manage_navigation`, { body: { action: 'get' } })).status).toBe(401);
  });

  it('keeps unavailable targets editable while pruning them from every display projection', async () => {
    await call({ action: 'set', document, expected_revision: (await read()).revision });
    const saved = await read();
    const sql = getTestDb();
    await sql`DELETE FROM views WHERE organization_id = ${org.id} AND key = 'overview'`;
    await sql`UPDATE entity_types SET metadata_schema = '{"type":"object","properties":{}}'::jsonb
      WHERE organization_id = ${org.id} AND slug = 'company'`;
    expect(await read()).toEqual(saved);
    const display = await call({ action: 'get', projection: 'display' });
    expect((await display.json()).document).toEqual({ sections: [{
      ...document.sections[0], items: [{ ...document.sections[0].items[0], children: [] }],
    }] });
    expect((await call({ action: 'set', document, expected_revision: saved.revision })).status).toBe(422);
  });

  it('requires admin MCP scope even when the SDK caller owns the workspace', async () => {
    const ctx = { ...ownerToolContext(org.id, owner.id), scopes: ['mcp:read'] };
    const sdk = buildClientSDK(ctx, { ENVIRONMENT: 'test' });
    const current = await sdk.navigation.get();
    await expect(sdk.navigation.set({ document: null, expected_revision: current.revision }))
      .rejects.toMatchObject({ requiredScope: 'mcp:admin' });
    expect(await read()).toMatchObject({ document: null, revision: current.revision });
  });

  it('keeps the navigation envelope out of generic organization readers and writers', async () => {
    await call({ action: 'set', document, expected_revision: (await read()).revision });
    const saved = await read();
    for (const path of ['/api/organizations', `/api/${org.slug}/public/organization`]) {
      const response = await testRequest('GET', path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('navigation');
      expect(body).not.toContain('Private operator dashboards');
    }
    const full = await testRequest('GET', `/api/auth/organization/get-full-organization?organizationId=${org.id}`, { cookie: ownerCookie });
    expect(full.status).toBe(200);
    expect(await full.json()).not.toHaveProperty('navigation');
    const genericWrite = await post('/api/auth/organization/update', {
      cookie: ownerCookie,
      body: { organizationId: org.id, data: { name: org.name, navigation: { id: 'bypass', document: null } } },
    });
    expect(genericWrite.status).toBe(200);
    expect(await read()).toEqual(saved);
  });

  it('rejects missing targets, duplicate IDs, and deeper trees before writing', async () => {
    const initial = await read();
    const badTarget = structuredClone(document);
    badTarget.sections[0].items[0].target.entity_type = 'missing';
    expect((await call({ action: 'set', document: badTarget, expected_revision: initial.revision })).status).toBe(422);
    const duplicate = structuredClone(document);
    duplicate.sections[1].id = 'catalog';
    expect((await call({ action: 'set', document: duplicate, expected_revision: initial.revision })).status).toBe(422);
    const deep = structuredClone(document) as any;
    deep.sections[0].items[0].children[0].children = [{ ...deep.sections[0].items[0].children[0] }];
    expect((await call({ action: 'set', document: deep, expected_revision: initial.revision })).status).toBe(400);
    expect((await read()).revision).toBe(initial.revision);
  });

  it('rolls back the document and revision if its durable audit insert fails', async () => {
    const initial = await read();
    const sql = getTestDb();
    await sql.unsafe(`CREATE FUNCTION reject_navigation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'action' = 'set_navigation' THEN RAISE EXCEPTION 'synthetic navigation audit failure'; END IF; RETURN NEW; END $$`);
    await sql.unsafe('CREATE TRIGGER reject_navigation_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_navigation_audit()');
    try {
      const failed = await call({ action: 'set', document, expected_revision: initial.revision });
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(await read()).toEqual(initial);
    } finally {
      await sql.unsafe('DROP TRIGGER reject_navigation_audit ON events');
      await sql.unsafe('DROP FUNCTION reject_navigation_audit()');
    }
  });
});
