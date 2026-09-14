/**
 * An inline connector action that returns file bytes must publish them, exactly
 * as the worker lane does in `/api/workers/complete-action`.
 *
 * A server-executed connector (no device pin, no approval) never touches the
 * worker completion endpoint: `manage_operations execute` runs the connector in
 * process and writes `action_output` itself. Without publication the base64
 * bytes land in the jsonb column and come straight back to the requester, which
 * is both a multi-megabyte tool result and a binary blob in the database.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index';
import * as gateway from '../../lobu/gateway';
import {
  ArtifactStore,
  runArtifactBinding,
} from '../../gateway/files/artifact-store';
import { manageOperations } from '../../tools/admin/manage_operations';
import type { ToolContext } from '../../tools/registry';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';

const CONNECTOR = 'demo.inline.attachment';
const FILE_BYTES = Buffer.from('%PDF-1.4 inline attachment bytes');

describe('inline connector action attachments', () => {
  let ctx: ToolContext;
  let connectionId: number;
  let directory: string;
  let store: ArtifactStore;

  beforeAll(async () => {
    vi.stubEnv('LOBU_CLOUD_MODE', 'false');
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const seeded = await seedOwnerContext({ orgName: 'Inline attachment test' });
    ctx = seeded.ctx;
    directory = await mkdtemp(join(tmpdir(), 'lobu-inline-attachment-test-'));
    store = new ArtifactStore(directory);
    vi.spyOn(gateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => store,
    });
    await createTestConnectorDefinition({
      key: CONNECTOR,
      name: 'Inline attachment test',
      organization_id: ctx.organizationId,
    });
    const sql = getTestDb();
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      download: {
        name: 'Download a file',
        kind: 'read',
        requiresApproval: false,
        input_schema: { type: 'object', properties: {} },
      },
    })} WHERE organization_id = ${ctx.organizationId} AND key = ${CONNECTOR}`;
    await sql`UPDATE connector_versions SET compiled_code = ${`
      class ConnectorRuntime {
        async sync() { return { items: [] }; }
        async execute() {
          return { success: true, output: {
            name: 'report.pdf',
            attachments: [{
              filename: 'report.pdf',
              mime_type: 'application/pdf',
              data: '${FILE_BYTES.toString('base64')}',
            }],
          } };
        }
      }
      module.exports = { ConnectorRuntime };
    `} WHERE connector_key = ${CONNECTOR}`;
    connectionId = (
      await createTestConnection({
        organization_id: ctx.organizationId,
        connector_key: CONNECTOR,
        created_by: ctx.userId!,
        visibility: 'private',
      })
    ).id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('publishes the bytes and returns a download_url instead of base64', async () => {
    const result = (await manageOperations(
      {
        action: 'execute',
        connection_id: connectionId,
        operation_key: 'download',
        input: {},
      },
      {} as Env,
      ctx,
    )) as { run_id: number; status: string; output: Record<string, unknown> };

    expect(result.status).toBe('completed');
    const [attachment] = result.output.attachments as Array<
      Record<string, unknown>
    >;
    expect(attachment).toMatchObject({
      kind: 'file',
      filename: 'report.pdf',
      mime_type: 'application/pdf',
      size_bytes: FILE_BYTES.length,
    });
    expect(attachment.data).toBeUndefined();
    expect(String(attachment.download_url)).toContain(
      String(attachment.artifact_id),
    );

    // The stored bytes are the connector's, byte for byte, and they are bound to
    // the run that produced them.
    const stored = await store.read(String(attachment.artifact_id), {
      binding: runArtifactBinding(result.run_id),
    });
    expect(stored?.bytes).toEqual(FILE_BYTES);

    // And the durable row carries the reference, not the blob.
    const [run] = await getTestDb()`
      SELECT action_output FROM runs WHERE id = ${result.run_id}`;
    expect(JSON.stringify(run.action_output)).not.toContain(
      FILE_BYTES.toString('base64'),
    );
    expect(run.action_output.attachments[0].artifact_id).toBe(
      attachment.artifact_id,
    );
  });
});
