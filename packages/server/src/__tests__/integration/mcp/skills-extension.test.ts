/**
 * The MCP Skills extension (SEP-2640) on the real `/mcp` endpoint:
 * initialize → skills/list → skills/get → resources/read. A caller is served
 * the bundled Lobu skill plus the enabled library skills whose subjects match
 * its acting principal, in workspaces this connection reaches and whose
 * `skill_config` read policy admits it. Everything else is -32602.
 */
import { createHash } from 'node:crypto';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveAppPrincipalId } from '../../../auth/app-principal';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { LOBU_SKILL_MARKDOWN } from '../../../skills/lobu-skill.generated';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  createTestWorkspaceSkill,
} from '../../setup/test-fixtures';
import { mcpRequest, post } from '../../setup/test-helpers';

interface SkillEntry {
  uri: string;
  frontmatter: { name: string; description: string };
  resources: Array<{ uri: string; digest: string; size: number }>;
}

const LOBU_URI = 'skill://lobu/SKILL.md';

/** A hosted web app's OAuth client, and the app key its tokens act as. */
async function hostedApp(host: string) {
  const redirectUri = `https://${host}/oauth/callback`;
  const client = await createTestOAuthClient({ redirect_uris: [redirectUri], client_name: `${host} app` });
  const appKey = deriveAppPrincipalId({
    kind: 'oauth',
    clientId: client.client_id,
    clientName: `${host} app`,
    authorizationGrantType: 'authorization_code',
    redirectUris: [redirectUri],
  });
  return { clientId: client.client_id, appKey };
}

describe('MCP Skills extension', () => {
  let userId: string;
  let orgA: { id: string; slug: string };
  let orgB: { id: string; slug: string };
  let orgC: { id: string; slug: string };
  let reader: Awaited<ReturnType<typeof hostedApp>>;
  let other: Awaited<ReturnType<typeof hostedApp>>;
  let denied: Awaited<ReturnType<typeof hostedApp>>;

  const tokenFor = async (
    app: { clientId: string },
    organizationId: string | null,
    grantedOrganizationIds: string[],
    resource?: string,
  ) =>
    (
      await createTestAccessToken(userId, organizationId as string, app.clientId, {
        authorizationGrantType: 'authorization_code',
        scope: 'mcp:read',
        grantedOrganizationIds,
        ...(resource ? { resource } : {}),
      })
    ).token;

  const scoped = async (app: { clientId: string }, org: { id: string; slug: string }) => ({
    token: await tokenFor(app, org.id, [org.id], `http://localhost/mcp/${org.slug}`),
    orgSlug: org.slug,
  });

  const listUris = async (connection: { token: string; orgSlug?: string }) => {
    const response = await mcpRequest('skills/list', {}, connection);
    expect(response.error, JSON.stringify(response.error)).toBeUndefined();
    expect(response.result.resultType).toBe('complete');
    expect(response.result.nextCursor).toBeUndefined();
    return (response.result.skills as SkillEntry[]).map((entry) => entry.uri);
  };

  const expectUnknown = async (connection: { token: string; orgSlug?: string }, uri: string) => {
    for (const method of ['skills/get', 'resources/read']) {
      const response = await mcpRequest(method, { uri }, connection);
      expect(response.result, `${method} ${uri}`).toBeUndefined();
      expect(response.error?.code, `${method} ${uri}`).toBe(-32602);
    }
  };

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    orgA = await createTestOrganization({ slug: 'skills-ext-a' });
    orgB = await createTestOrganization({ slug: 'skills-ext-b' });
    orgC = await createTestOrganization({ slug: 'skills-ext-c' });
    const user = await createTestUser({ email: 'skills-ext@example.test' });
    userId = user.id;
    await addUserToOrganization(userId, orgA.id, 'owner');
    await addUserToOrganization(userId, orgB.id, 'member');
    // The user is not a member of orgC; its skills are never reachable.
    const agent = await createTestAgent({ organizationId: orgA.id, ownerUserId: userId, agentId: 'skills-ext-agent' });

    reader = await hostedApp('chat.skills-reader.test');
    other = await hostedApp('chat.skills-other.test');
    denied = await hostedApp('chat.skills-denied.test');
    expect(new Set([reader.appKey, other.appKey, denied.appKey]).size).toBe(3);

    await createTestWorkspaceSkill({ organizationId: orgA.id, name: 'everyone-guide', description: 'Line one\n"quoted": yes' });
    await createTestWorkspaceSkill({ organizationId: orgA.id, name: 'all-apps', appliesTo: [{ kind: 'app', id: null }] });
    await createTestWorkspaceSkill({ organizationId: orgA.id, name: 'reader-only', appliesTo: [{ kind: 'app', id: reader.appKey }] });
    await createTestWorkspaceSkill({ organizationId: orgA.id, name: 'other-only', appliesTo: [{ kind: 'app', id: other.appKey }] });
    await createTestWorkspaceSkill({ organizationId: orgA.id, name: 'agent-only', appliesTo: [{ kind: 'agent', id: agent.agentId }] });
    await createTestWorkspaceSkill({ organizationId: orgA.id, name: 'disabled-guide', enabled: false });
    await createTestWorkspaceSkill({ organizationId: orgB.id, name: 'b-guide' });
    await createTestWorkspaceSkill({ organizationId: orgC.id, name: 'c-guide' });
    await upsertEntityApprovalPolicy(orgA.id, {
      resourceClass: 'skill_config',
      principalKind: 'app',
      principalId: denied.appKey,
      effects: { read: 'deny' },
    });
  });

  it('declares the extension alongside resources in the initialize result', async () => {
    const response = await post(`/mcp/${orgA.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'skills-test', version: '1.0' } },
      },
      token: (await scoped(reader, orgA)).token,
    });
    const body = await response.json();
    expect(body.result.capabilities.resources).toBeDefined();
    expect(body.result.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({});
  });

  it('serves an allowed app the skills that apply to it, with digests over the served bytes', async () => {
    const connection = await scoped(reader, orgA);
    expect(await listUris(connection)).toEqual([
      LOBU_URI,
      'skill://skills-ext-a/all-apps/SKILL.md',
      'skill://skills-ext-a/everyone-guide/SKILL.md',
      'skill://skills-ext-a/reader-only/SKILL.md',
    ]);

    for (const uri of [LOBU_URI, 'skill://skills-ext-a/everyone-guide/SKILL.md', 'skill://skills-ext-a/reader-only/SKILL.md']) {
      const got = await mcpRequest('skills/get', { uri }, connection);
      expect(got.result.resultType).toBe('complete');
      const entry = got.result.skill as SkillEntry;
      expect(entry.uri).toBe(uri);
      expect(uri.split('/').at(-2)).toBe(entry.frontmatter.name);
      const read = await mcpRequest('resources/read', { uri }, connection);
      const [content] = read.result.contents;
      expect(content).toMatchObject({ uri, mimeType: 'text/markdown' });
      const bytes = Buffer.from(content.text, 'utf8');
      expect(entry.resources).toEqual([
        { uri, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.byteLength },
      ]);
    }

    const everyone = await mcpRequest('resources/read', { uri: 'skill://skills-ext-a/everyone-guide/SKILL.md' }, connection);
    expect(everyone.result.contents[0].text).toBe(
      '---\nname: "everyone-guide"\ndescription: "Line one\\n\\"quoted\\": yes"\n---\n\nFollow the everyone-guide procedure.',
    );
    const bundled = await mcpRequest('skills/get', { uri: LOBU_URI }, connection);
    expect(bundled.result.skill.frontmatter.name).toBe('lobu');
    // `skill://lobu` stays readable as an alias of the canonical SKILL.md.
    for (const uri of [LOBU_URI, 'skill://lobu']) {
      const read = await mcpRequest('resources/read', { uri }, connection);
      expect(read.result.contents[0].text).toBe(LOBU_SKILL_MARKDOWN);
    }
  });

  it('keeps one app from skills that target a different app', async () => {
    const connection = await scoped(other, orgA);
    expect(await listUris(connection)).toEqual([
      LOBU_URI,
      'skill://skills-ext-a/all-apps/SKILL.md',
      'skill://skills-ext-a/everyone-guide/SKILL.md',
      'skill://skills-ext-a/other-only/SKILL.md',
    ]);
    await expectUnknown(connection, 'skill://skills-ext-a/reader-only/SKILL.md');
    await expectUnknown(connection, 'skill://skills-ext-a/agent-only/SKILL.md');
    await expectUnknown(connection, 'skill://skills-ext-a/disabled-guide/SKILL.md');
  });

  it('serves nothing from a workspace whose skill_config read policy denies the app', async () => {
    const connection = await scoped(denied, orgA);
    expect(await listUris(connection)).toEqual([LOBU_URI]);
    await expectUnknown(connection, 'skill://skills-ext-a/everyone-guide/SKILL.md');
    await expectUnknown(connection, 'skill://skills-ext-a/all-apps/SKILL.md');
  });

  it('serves only the workspaces this connection reaches', async () => {
    const both = { token: await tokenFor(reader, null, [orgA.id, orgB.id, orgC.id]) };
    expect(await listUris(both)).toEqual([
      LOBU_URI,
      'skill://skills-ext-a/all-apps/SKILL.md',
      'skill://skills-ext-a/everyone-guide/SKILL.md',
      'skill://skills-ext-a/reader-only/SKILL.md',
      'skill://skills-ext-b/b-guide/SKILL.md',
    ]);
    const got = await mcpRequest('skills/get', { uri: 'skill://skills-ext-b/b-guide/SKILL.md' }, both);
    expect(got.result.skill.uri).toBe('skill://skills-ext-b/b-guide/SKILL.md');
    await expectUnknown(both, 'skill://skills-ext-c/c-guide/SKILL.md');

    const onlyA = { token: await tokenFor(reader, null, [orgA.id]) };
    expect(await listUris(onlyA)).not.toContain('skill://skills-ext-b/b-guide/SKILL.md');
    await expectUnknown(onlyA, 'skill://skills-ext-b/b-guide/SKILL.md');

    const scopedA = await scoped(reader, orgA);
    expect(await listUris(scopedA)).not.toContain('skill://skills-ext-b/b-guide/SKILL.md');
    await expectUnknown(scopedA, 'skill://skills-ext-b/b-guide/SKILL.md');
    // The workspace is named by its slug; its id is not another address for it.
    await expectUnknown(scopedA, `skill://${orgA.id}/everyone-guide/SKILL.md`);
  });

  it('answers -32602 for an unknown or malformed skill URI', async () => {
    const connection = await scoped(reader, orgA);
    for (const uri of [
      'skill://skills-ext-a/no-such-skill/SKILL.md',
      'skill://skills-ext-a/everyone-guide/README.md',
      'skill://skills-ext-a/everyone-guide',
      'skill://no-such-workspace/everyone-guide/SKILL.md',
    ]) {
      await expectUnknown(connection, uri);
    }
    // The alias names a resource, not a skill's SKILL.md.
    expect((await mcpRequest('skills/get', { uri: 'skill://lobu' }, connection)).error?.code).toBe(-32602);
    expect((await mcpRequest('skills/get', {}, connection)).error?.code).toBe(-32602);
    expect((await mcpRequest('skills/list', { cursor: 'not-a-cursor' }, connection)).error?.code).toBe(-32602);
  });

  it('pages a long listing without splitting or repeating an entry', async () => {
    const sql = getTestDb();
    await sql`
      INSERT INTO workspace_skills (id, organization_id, name, description, content)
      SELECT 'skill-page-' || n, ${orgB.id}, 'page-' || lpad(n::text, 3, '0'), 'Paged skill', 'Body'
      FROM generate_series(1, 120) AS n
    `;
    await sql`
      INSERT INTO workspace_skill_subjects (skill_id, organization_id, principal_kind, principal_id)
      SELECT 'skill-page-' || n, ${orgB.id}, NULL, NULL FROM generate_series(1, 120) AS n
    `;
    const connection = await scoped(reader, orgB);
    const first = await mcpRequest('skills/list', {}, connection);
    expect(first.result.skills).toHaveLength(100);
    expect(first.result.nextCursor).toEqual(expect.any(String));
    const second = await mcpRequest('skills/list', { cursor: first.result.nextCursor }, connection);
    expect(second.result.nextCursor).toBeUndefined();
    const uris = [...first.result.skills, ...second.result.skills].map((entry: SkillEntry) => entry.uri);
    expect(uris).toHaveLength(122);
    expect(new Set(uris).size).toBe(122);
    expect(uris).toEqual([...uris].sort());
  });
});
