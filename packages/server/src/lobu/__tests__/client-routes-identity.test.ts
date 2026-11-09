/**
 * Repro probe: the listed identity of an MCP client must be what it REGISTERED
 * as, not what happens to be driving the current session.
 *
 * `oauth_clients.client_name` is set once at dynamic registration.
 * `metadata.last_client_info.name` is overwritten on every MCP `initialize`,
 * and it reflects the PROCESS holding the connection — so an Owletto Mac build
 * driven by the Claude Code SDK reports `claude-code`.
 *
 * Letting clientInfo win made two things wrong at once, both measured on prod
 * 2026-07-30 (19 rows, all 19 mismatched):
 *   - the displayed vendor was the driver, not the app: "Owletto for Mac" and
 *     "Lobu CLI" both rendered as "claude-code", ChatGPT as "openai-mcp"
 *   - `firstParty` keyed off that polluted name, so Lobu's own surfaces lost
 *     their badge whenever a third-party runtime drove them — that field is
 *     now deleted rather than repaired (see the third test)
 *
 * Both fixtures below are copied from real prod rows.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const ORG = 'org-identity';
const USER = 'u-owner';

/** Prod row: registered "Owletto for Mac", driven by the Claude Code SDK. */
const MAC_CLIENT = 'mcp_client_owletto_mac';
/** Prod row: registered "ChatGPT", reports itself as "openai-mcp". */
const CHATGPT_CLIENT = 'mcp_client_chatgpt';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

async function importClientRoutes() {
  const mod = await import('../client-routes.js');
  return mod.clientRoutes;
}

async function seed(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();

  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Owner', 'owner@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  const { ensureMemberEntity } = await import('../../utils/member-entity.js');
  await ensureMemberEntity({
    organizationId: ORG,
    userId: USER,
    name: 'Owner',
    email: 'owner@test',
    role: 'owner',
  });

  // Registered as "Owletto for Mac" but every session reports `claude-code`,
  // because the Mac app drives its MCP connection through the Claude Code SDK.
  await sql`
    INSERT INTO oauth_clients (id, client_name, software_id, software_version, redirect_uris, metadata)
    VALUES (
      ${MAC_CLIENT}, 'Owletto for Mac', 'owletto-mac', '0.1.0',
      ARRAY['http://127.0.0.1:59123/callback']::text[],
      ${sql.json({
        last_client_info: { name: 'claude-code', version: '2.1.198' },
        last_user_agent: 'claude-code/2.1.198 (sdk-cli)',
      })}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris, metadata)
    VALUES (
      ${CHATGPT_CLIENT}, 'ChatGPT',
      ARRAY['https://chatgpt.com/connector/oauth/vZ8jgAUNyIH4']::text[],
      ${sql.json({
        last_client_info: { name: 'openai-mcp', version: '1.0.0' },
        last_user_agent: 'openai-mcp/1.0.0',
      })}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  for (const clientId of [MAC_CLIENT, CHATGPT_CLIENT]) {
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        ${`tok_${clientId}`}, 'access', ${`hash_${clientId}`}, ${clientId}, ${USER}, ${ORG},
        'mcp:read', now() + interval '1 hour', now()
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

interface ListedClient {
  id: string;
  title: string | null;
  drivenBy: string | null;
  linkedUserEntitySlug: string | null;
}

async function listClients(): Promise<Map<string, ListedClient>> {
  const routes = await importClientRoutes();
  const res = await routes.request('/');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { clients: ListedClient[] };
  return new Map(body.clients.map((c) => [c.id, c]));
}

describe('MCP client identity', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seed();
    authStash.organizationId = ORG;
    authStash.memberRole = 'owner';
  });

  test('the listed title is the registered name, not the driving process', async () => {
    const clients = await listClients();

    // Before the fix both of these returned the clientInfo name, so the UI
    // showed "claude-code" for a Lobu product and "openai-mcp" for ChatGPT.
    expect(clients.get(MAC_CLIENT)?.title).toBe('Owletto for Mac');
    expect(clients.get(CHATGPT_CLIENT)?.title).toBe('ChatGPT');
  });

  test('the driving process is still reported, on its own field', async () => {
    // clientInfo answers a genuinely useful but DIFFERENT question — what is
    // driving the connection. Keeping it costs nothing once it stops
    // overriding identity.
    const clients = await listClients();

    expect(clients.get(MAC_CLIENT)?.drivenBy).toBe('claude-code');
    expect(clients.get(CHATGPT_CLIENT)?.drivenBy).toBe('openai-mcp');
  });

  test('links the granting user to their workspace member entity', async () => {
    const clients = await listClients();
    const { getDb } = await import('../../db/client.js');
    const members = await getDb()`
      SELECT e.slug FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${ORG} AND et.slug = '$member'
        AND e.metadata->>'email' = 'owner@test' AND e.deleted_at IS NULL
    `;
    expect(members).toHaveLength(1);
    for (const clientId of [MAC_CLIENT, CHATGPT_CLIENT]) {
      expect(clients.get(clientId)?.linkedUserEntitySlug).toBe(members[0].slug);
    }
  });

  test('no client is classified as first-party by its self-asserted name', async () => {
    // `firstParty` used to be derived from a hardcoded software-id allowlist
    // plus a "lobu*" name-prefix match. The allowlist went stale at the
    // Lobu→Owletto rename (that staleness was half this bug), and the prefix
    // fallback let any registration claim the category by naming itself.
    // Both signals are supplied by the client at registration, so neither can
    // classify anything. Its only consumers were two cosmetic labels; the
    // field is gone rather than re-derived.
    const clients = await listClients();

    for (const client of clients.values()) {
      expect(client).not.toHaveProperty('firstParty');
    }
  });
});
