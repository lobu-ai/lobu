/**
 * New connector attribution declarations cannot claim chat sender namespaces.
 *
 * The shared definition writer rejects installs and upgrades that would let
 * connector data claim the identity slots used by chat senders. This does not
 * retroactively disable declarations already stored before the guard.
 *
 * Platform-owned attribution that supplies its rules directly (the Slack
 * channel ACL graph) is not a connector declaration and keeps linking members.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { slackAclSource, slackChannelsToResources } from '@lobu/connectors/slack-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAccessGraph } from '../../../authz/access-graph';
import { CHAT_USER_IDENTITIES } from '../../../lobu/stores/chat-identity-sources';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const FEED = 'messages';

function metadataDeclaring(key: string, namespace: string): ConnectorMetadata {
  return {
    key,
    name: 'Chat namespace probe',
    version: '1.0.0',
    authSchema: null,
    webhook: null,
    feeds: {
      [FEED]: {
        key: FEED,
        name: 'Messages',
        eventKinds: {
          message: {
            attributions: [
              {
                role: 'authored_by',
                autoCreate: true,
                target: {
                  entityType: 'person',
                  titlePath: 'metadata.author',
                  identities: [{ namespace, eventPath: 'metadata.author_id' }],
                },
              },
            ],
          },
        },
      },
    },
    actions: null,
    automationEvents: null,
    optionsSchema: null,
  };
}

async function seedOrganization(): Promise<string> {
  const sql = getTestDb();
  const org = await createTestOrganization({ name: 'Chat Namespace Guard Org' });
  const user = await createTestUser({ email: 'chat-namespace-guard@example.test' });
  await addUserToOrganization(user.id, org.id, 'owner');
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
  `;
  return org.id;
}

describe('connector attribution rules and chat sender namespaces', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it.each(CHAT_USER_IDENTITIES.map((identity) => identity.namespace))(
    "refuses a connector declaring '%s' and leaves nothing for a sync to write",
    async (namespace) => {
      const orgId = await seedOrganization();
      const sql = getTestDb();
      const key = `probe-${namespace.replace(/_/g, '-')}`;
      await expect(upsertConnectorDefinitionRecords({
        sql,
        organizationId: orgId,
        metadata: metadataDeclaring(key, namespace),
        versionRecord: {
          compiledCode: '// compiled',
          compiledCodeHash: `hash-${key}`,
          compileConfigHash: COMPILE_CONFIG_HASH,
          sourceCode: '// source',
          sourcePath: `${key}@1.0.0.ts`,
        },
        versionScope: 'organization',
      })).rejects.toThrow(new RegExp(`'${namespace}'.*chat sender`));

      const definitions = await sql`
        SELECT 1 FROM connector_definitions WHERE organization_id = ${orgId} AND key = ${key}
      `;
      const versions = await sql`
        SELECT 1 FROM connector_versions WHERE organization_id = ${orgId} AND connector_key = ${key}
      `;
      const scopes = await sql`
        SELECT 1 FROM connector_identity_scope_registry WHERE organization_id = ${orgId} AND connector_key = ${key}
      `;
      expect(definitions).toHaveLength(0);
      expect(versions).toHaveLength(0);
      expect(scopes).toHaveLength(0);

      // Run after rejection so the rule cache cannot hide a partial install.
      clearEntityLinkRulesCache();
      await applyEventAttributions({
        connectorKey: key,
        orgId,
        feedKey: FEED,
        items: [{ origin_type: 'message', metadata: { author: 'Synthetic Sender', author_id: 'T0SYNTH:U0SYNTH' } }],
      });
      const written = await sql`
        SELECT 1 FROM entity_identities WHERE organization_id = ${orgId} AND namespace = ${namespace}
      `;

      expect(written).toHaveLength(0);
    },
  );

  it('refuses an upgrade that adds a chat sender namespace to an installed connector', async () => {
    const orgId = await seedOrganization();
    const sql = getTestDb();
    const key = 'probe-upgrade';
    const install = (namespace: string, version: string) =>
      upsertConnectorDefinitionRecords({
        sql,
        organizationId: orgId,
        metadata: { ...metadataDeclaring(key, namespace), version },
        versionRecord: {
          compiledCode: `// compiled ${version}`,
          compiledCodeHash: `hash-${key}-${version}`,
          compileConfigHash: COMPILE_CONFIG_HASH,
          sourceCode: `// source ${version}`,
          sourcePath: `${key}@${version}.ts`,
        },
        versionScope: 'organization',
      });
    await install('probe_author_id', '1.0.0');
    await expect(install('slack_user_id', '1.0.1')).rejects.toThrow(/'slack_user_id'.*chat sender/);
    const [active] = await sql<{ version: string }>`
      SELECT version FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${key} AND status = 'active'
    `;
    expect(active.version).toBe('1.0.0');
  });

  it('keeps the Slack channel ACL linking members on slack_user_id', async () => {
    const orgId = await seedOrganization();
    const connection = await createTestConnection({
      organization_id: orgId, connector_key: 'slack', visibility: 'org', createDefaultFeed: false,
    });
    await buildAccessGraph({
      organizationId: orgId,
      connectionId: String(connection.id),
      connectorKey: 'slack',
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources('T0SYNTH', [
        { channelId: 'C0SYNTH', name: 'general', memberSlackUserIds: ['U0SYNTH'] },
      ]),
    });
    const rows = await getTestDb()<{ identifier: string; source_connector: string }>`
      SELECT identifier, source_connector FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = 'slack_user_id'
    `;
    expect(rows).toEqual([{ identifier: 'T0SYNTH:U0SYNTH', source_connector: 'connector:slack' }]);
  });
});
