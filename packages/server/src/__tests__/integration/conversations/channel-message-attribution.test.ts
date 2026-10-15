/**
 * Store-only sender attribution for the durable chat transcript.
 *
 * `persistChannelMessage` resolves a real (non-bot) author to its person/$member
 * entity and stamps `channel_messages.author_entity_id` — WITHOUT emitting an
 * event or touching the embed pipeline. Invariants proved here:
 *   1. a known Slack sender (existing person, slack_user_id=T:U) attributes to it;
 *   2. an unknown non-bot sender mints a NEW person; a bot post never attributes;
 *   3. a Slack sender with no team id is never attributed;
 *   4. cross-source collapse (#1646): a signed-in human is a $member carrying the
 *      same slack_user_id, so attribution lands on the $member — no dup person.
 *   5. the edge is registry-driven: a Google Chat sender attributes under
 *      `google_user_id` (bare account id) and a WhatsApp Web sender under
 *      `whatsapp_user_jid` (canonical JID), each minting one person and reusing
 *      it; a transport with no descriptor (the bare `whatsapp` Chat SDK one)
 *      never attributes.
 *   6. attribution grants nothing: a person minted here carries no
 *      `auth_user_id`, so the sender→user lookup still resolves null. A Google
 *      sign-in can then adopt the key onto the signer's real $member.
 */

import { normalizeSlackUserId } from '@lobu/connectors/slack-identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  persistLoginChatIdentity,
  provisionMemberAndCoreIdentities,
} from '../../../auth/subject-identities';
import { persistChannelMessage } from '../../../gateway/connections/channel-transcript';
import {
  resolveChatSenderMember,
  resolveChatUserIdentity,
} from '../../../lobu/stores/chat-identity';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEAM = 'T1ACME';
/** A synthetic Google account id — the shape Google's OIDC `sub` uses. */
const GOOGLE_SUB = '100000000000000000001';
/** The `users/{id}` resource name a Google Chat event carries as the sender. */
const GCHAT_SENDER = `users/${GOOGLE_SUB}`;
/** A synthetic WhatsApp phone JID in the connector's canonical form. */
const PHONE_JID = '15550000001@s.whatsapp.net';

/** Ensure the org has a `person` entity type so auto-create can resolve it. */
async function ensurePersonType(orgId: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, 'person', 'Person', current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
}

async function addIdentity(opts: {
  orgId: string;
  entityId: number;
  namespace: string;
  identifier: string;
  source?: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
    VALUES (${opts.orgId}, ${opts.entityId}, ${opts.namespace}, ${opts.identifier}, ${opts.source ?? 'connector:slack'})
  `;
}

/** Capture one inbound message and read its attribution back. */
async function captureAndRead(params: {
  orgId: string;
  connectionId: string;
  platform?: string;
  channelId: string;
  authorId: string | null;
  teamId: string | null;
  isBot: boolean;
  text: string;
}): Promise<number | null> {
  const sql = getTestDb();
  await persistChannelMessage({
    organizationId: params.orgId,
    connectionId: params.connectionId,
    platform: params.platform ?? 'slack',
    channelId: params.channelId,
    platformMessageId: `${params.channelId}-${Math.random().toString(36).slice(2)}`,
    authorId: params.authorId,
    authorName: 'Sender',
    teamId: params.teamId,
    isBot: params.isBot,
    text: params.text,
    occurredAt: new Date(),
  });
  const rows = (await sql`
    SELECT author_entity_id, team_id
    FROM channel_messages
    WHERE organization_id = ${params.orgId} AND connection_id = ${params.connectionId}
    ORDER BY id DESC LIMIT 1
  `) as Array<{ author_entity_id: number | string | null; team_id: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].author_entity_id == null ? null : Number(rows[0].author_entity_id);
}

async function identityRows(
  orgId: string,
  namespace: string
): Promise<Array<{ entity_id: number; identifier: string; source_connector: string }>> {
  const rows = (await getTestDb()`
    SELECT entity_id, identifier, source_connector FROM entity_identities
    WHERE organization_id = ${orgId} AND namespace = ${namespace} AND deleted_at IS NULL
    ORDER BY id ASC
  `) as Array<{ entity_id: number | string; identifier: string; source_connector: string }>;
  return rows.map((r) => ({ ...r, entity_id: Number(r.entity_id) }));
}

async function personEntityIds(orgId: string): Promise<number[]> {
  const rows = (await getTestDb()`
    SELECT e.id FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = 'person'
    WHERE e.organization_id = ${orgId} AND e.deleted_at IS NULL
    ORDER BY e.id ASC
  `) as Array<{ id: number | string }>;
  return rows.map((r) => Number(r.id));
}

describe('channel_messages sender attribution', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('attributes a known Slack sender (existing person, slack_user_id=T:U)', async () => {
    const org = await createTestOrganization({ name: 'Attr Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    const person = await createTestEntity({
      name: 'Alice',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const slackId = normalizeSlackUserId(TEAM, 'U1ALICE');
    await addIdentity({
      orgId: org.id,
      entityId: person.id,
      namespace: 'slack_user_id',
      identifier: slackId as string,
    });

    const resolved = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-attr',
      channelId: 'C1',
      authorId: 'U1ALICE',
      teamId: TEAM,
      isBot: false,
      text: 'hello from alice',
    });
    expect(resolved).toBe(person.id);
  });

  it('mints a new person for an unknown non-bot sender, and never attributes a bot', async () => {
    const org = await createTestOrganization({ name: 'Mint Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    // Unknown non-bot → a fresh person is minted and attributed.
    const minted = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-mint',
      channelId: 'C1',
      authorId: 'U2BOB',
      teamId: TEAM,
      isBot: false,
      text: 'first message from bob',
    });
    expect(minted).not.toBeNull();

    const slackId = normalizeSlackUserId(TEAM, 'U2BOB');
    const idRows = (await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'slack_user_id' AND identifier = ${slackId}
    `) as Array<{ entity_id: number | string }>;
    expect(idRows).toHaveLength(1);
    expect(Number(idRows[0].entity_id)).toBe(minted);

    // A bot post is never attributed.
    const botAttr = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-mint',
      channelId: 'C1',
      authorId: 'B1BOT',
      teamId: TEAM,
      isBot: true,
      text: 'beep boop',
    });
    expect(botAttr).toBeNull();
  });

  it('never attributes (or mints a malformed key) when there is no team id', async () => {
    const org = await createTestOrganization({ name: 'NoTeam Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    const resolved = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-noteam',
      channelId: 'C1',
      authorId: 'U3CAROL',
      teamId: null,
      isBot: false,
      text: 'no team here',
    });
    expect(resolved).toBeNull();

    // No identity row was written for a bare, team-less Slack id.
    const idRows = (await sql`
      SELECT 1 FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'slack_user_id'
    `) as Array<unknown>;
    expect(idRows).toHaveLength(0);
  });

  it('collapses onto a signed-in $member carrying the same slack_user_id (no dup person)', async () => {
    const org = await createTestOrganization({ name: 'Collapse Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    // A signed-in human: $member carrying auth_user_id + the team-scoped slack id.
    const member = await createTestEntity({
      name: 'Dave',
      entity_type: '$member',
      organization_id: org.id,
      created_by: user.id,
    });
    const slackId = normalizeSlackUserId(TEAM, 'U4DAVE');
    await addIdentity({
      orgId: org.id,
      entityId: member.id,
      namespace: 'auth_user_id',
      identifier: user.id,
    });
    await addIdentity({
      orgId: org.id,
      entityId: member.id,
      namespace: 'slack_user_id',
      identifier: slackId as string,
    });

    const resolved = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-collapse',
      channelId: 'C1',
      authorId: 'U4DAVE',
      teamId: TEAM,
      isBot: false,
      text: 'dave in slack',
    });
    expect(resolved).toBe(member.id);

    // No person entity was minted for the same identity — attribution and ACL
    // converge on the single $member.
    const personRows = (await sql`
      SELECT e.id FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = 'person'
      WHERE e.organization_id = ${org.id} AND e.deleted_at IS NULL
    `) as Array<unknown>;
    expect(personRows).toHaveLength(0);
  });

  it('attributes a Google Chat sender under google_user_id, minting one person and reusing it', async () => {
    const org = await createTestOrganization({ name: 'GChat Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);

    // Google Chat events carry no team id; the sender is `users/{id}`.
    const first = await captureAndRead({
      platform: 'gchat',
      orgId: org.id,
      connectionId: 'conn-gchat',
      channelId: 'spaces/AAAA',
      authorId: GCHAT_SENDER,
      teamId: null,
      isBot: false,
      text: 'hello from chat',
    });
    expect(first).not.toBeNull();

    // Keyed on the BARE account id — the key a Google sign-in stamps on the
    // `$member`, so a captured message and a sign-in meet on one row.
    expect(await identityRows(org.id, 'google_user_id')).toEqual([
      {
        entity_id: first,
        identifier: GOOGLE_SUB,
        source_connector: 'connector:gchat',
      },
    ]);

    // A second message from the same sender resolves the same person.
    const second = await captureAndRead({
      platform: 'gchat',
      orgId: org.id,
      connectionId: 'conn-gchat',
      channelId: 'spaces/AAAA',
      authorId: GCHAT_SENDER,
      teamId: null,
      isBot: false,
      text: 'and again',
    });
    expect(second).toBe(first);
    expect(await personEntityIds(org.id)).toEqual([first]);
  });

  it('attributes a WhatsApp Web sender under its canonical JID, minting one person and reusing it', async () => {
    const org = await createTestOrganization({ name: 'WA Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);

    // The web client's `@c.us` spelling plus a device suffix — the same person
    // as the canonical phone JID.
    const first = await captureAndRead({
      platform: 'whatsapp.web',
      orgId: org.id,
      connectionId: 'conn-wa',
      channelId: '15550000001@s.whatsapp.net',
      authorId: '15550000001:7@c.us',
      teamId: null,
      isBot: false,
      text: 'hello from whatsapp',
    });
    expect(first).not.toBeNull();
    expect(await identityRows(org.id, 'whatsapp_user_jid')).toEqual([
      {
        entity_id: first,
        identifier: PHONE_JID,
        source_connector: 'connector:whatsapp.web',
      },
    ]);

    // The canonical spelling of the same JID resolves the same person.
    const second = await captureAndRead({
      platform: 'whatsapp.web',
      orgId: org.id,
      connectionId: 'conn-wa',
      channelId: '15550000001@s.whatsapp.net',
      authorId: PHONE_JID,
      teamId: null,
      isBot: false,
      text: 'and again',
    });
    expect(second).toBe(first);
    expect(await personEntityIds(org.id)).toEqual([first]);
  });

  it('collapses a Google Chat sender onto the signed-in $member carrying the same google_user_id', async () => {
    const org = await createTestOrganization({ name: 'GChat Collapse Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);

    // A signed-in human: $member carrying auth_user_id + the bare Google id a
    // Google sign-in stamps.
    const member = await createTestEntity({
      name: 'Erin',
      entity_type: '$member',
      organization_id: org.id,
      created_by: user.id,
    });
    await addIdentity({
      orgId: org.id,
      entityId: member.id,
      namespace: 'auth_user_id',
      identifier: user.id,
      source: 'auth:signup',
    });
    await addIdentity({
      orgId: org.id,
      entityId: member.id,
      namespace: 'google_user_id',
      identifier: GOOGLE_SUB,
      source: 'auth:signup',
    });

    const resolved = await captureAndRead({
      platform: 'gchat',
      orgId: org.id,
      connectionId: 'conn-gchat-collapse',
      channelId: 'spaces/BBBB',
      authorId: GCHAT_SENDER,
      teamId: null,
      isBot: false,
      text: 'erin in chat',
    });
    expect(resolved).toBe(member.id);
    expect(await personEntityIds(org.id)).toEqual([]);
  });

  it('never attributes a sender on a transport with no identity descriptor (bare `whatsapp`)', async () => {
    const org = await createTestOrganization({ name: 'No Descriptor Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);

    // The Chat SDK WhatsApp transport is `whatsapp`, not `whatsapp.web`; no
    // connector contributes a descriptor for it, so a well-formed JID still
    // fails closed.
    const resolved = await captureAndRead({
      platform: 'whatsapp',
      orgId: org.id,
      connectionId: 'conn-wa-sdk',
      channelId: PHONE_JID,
      authorId: PHONE_JID,
      teamId: null,
      isBot: false,
      text: 'no descriptor here',
    });
    expect(resolved).toBeNull();
    expect(await identityRows(org.id, 'whatsapp_user_jid')).toEqual([]);
    expect(await personEntityIds(org.id)).toEqual([]);
  });

  it('a person minted by attribution never resolves to a Lobu user (gchat, whatsapp.web)', async () => {
    const org = await createTestOrganization({ name: 'Boundary Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    const gchatPerson = await captureAndRead({
      platform: 'gchat',
      orgId: org.id,
      connectionId: 'conn-boundary-gchat',
      channelId: 'spaces/CCCC',
      authorId: GCHAT_SENDER,
      teamId: null,
      isBot: false,
      text: 'unlinked gchat sender',
    });
    const waPerson = await captureAndRead({
      platform: 'whatsapp.web',
      orgId: org.id,
      connectionId: 'conn-boundary-wa',
      channelId: PHONE_JID,
      authorId: PHONE_JID,
      teamId: null,
      isBot: false,
      text: 'unlinked whatsapp sender',
    });
    expect(gchatPerson).not.toBeNull();
    expect(waPerson).not.toBeNull();

    // The attribution rows exist under the platforms' own namespaces …
    expect((await identityRows(org.id, 'google_user_id')).map((r) => r.entity_id)).toEqual([
      gchatPerson,
    ]);
    expect((await identityRows(org.id, 'whatsapp_user_jid')).map((r) => r.entity_id)).toEqual([
      waPerson,
    ]);
    // … but neither person carries an `auth_user_id`, and the sender→user
    // lookup only resolves a chat identity that shares its entity with a
    // provider-proven (`auth:signup`) `auth_user_id`. Mere presence of the
    // platform namespace is not a link.
    const authRows = (await sql`
      SELECT 1 FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'auth_user_id'
        AND entity_id IN (${gchatPerson}, ${waPerson})
    `) as Array<unknown>;
    expect(authRows).toHaveLength(0);
    expect(await resolveChatUserIdentity('gchat', undefined, GCHAT_SENDER, org.id)).toBeNull();
    expect(await resolveChatSenderMember('gchat', undefined, GCHAT_SENDER, org.id)).toBeNull();
    expect(await resolveChatUserIdentity('whatsapp.web', undefined, PHONE_JID, org.id)).toBeNull();
    expect(await resolveChatSenderMember('whatsapp.web', undefined, PHONE_JID, org.id)).toBeNull();

    // Positive control, so the nulls above are the trust rule and not a broken
    // fixture: a provider-proven sign-in adopts the key from the attributed
    // person onto the signer's real $member (the designed sign-in-after-
    // attribution path), and only THEN does the sender resolve — to that user.
    const signer = await createTestUser({ name: 'Signer', email: 'signer@example.test' });
    await addUserToOrganization(signer.id, org.id, 'member');
    const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
      userId: signer.id,
      email: 'signer@example.test',
      name: 'Signer',
      role: 'member',
    });
    await persistLoginChatIdentity({
      providerId: 'google',
      accountId: GOOGLE_SUB,
      userId: signer.id,
    });
    expect(await identityRows(org.id, 'google_user_id')).toEqual([
      {
        entity_id: memberEntityId,
        identifier: GOOGLE_SUB,
        source_connector: 'auth:signup',
      },
    ]);
    expect(await resolveChatSenderMember('gchat', undefined, GCHAT_SENDER, org.id)).toEqual({
      userId: signer.id,
      role: 'member',
    });
    // The WhatsApp person, with no sign-in, stays unresolvable.
    expect(await resolveChatSenderMember('whatsapp.web', undefined, PHONE_JID, org.id)).toBeNull();
  });
});
