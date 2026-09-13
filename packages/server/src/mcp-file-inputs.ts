import { type Static, Type } from '@sinclair/typebox';
import type { AccountToolContext } from './tools/registry';
import { resolveCrossOrgToolContext } from './sandbox/client-sdk';
import { resolveGrantedWorkspaceTarget } from './auth/oauth/workspace-grants';
import { getLobuCoreServices } from './lobu/gateway';
import { attachmentFromUrl, ingestInputFiles, MAX_INPUT_FILES } from './gateway/files/input-files';
import { ToolUserError } from './utils/errors';
import { resolvePublicGatewayUrl } from './utils/public-origin';

/** OpenAI's host file envelope is normalized only at this MCP boundary. */
export const McpHostFilesSchema = Type.Array(Type.Object({
  download_url: Type.String({ minLength: 1, maxLength: 16_384 }),
  file_id: Type.String({ minLength: 1, maxLength: 1024 }),
  mime_type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  file_name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
}, { additionalProperties: false }), {
  minItems: 1,
  maxItems: MAX_INPUT_FILES,
  description: 'Files supplied by the chat host. The server imports bytes before running the script; ctx.files contains reusable Lobu file references. Do not invent download URLs, file IDs, or local paths.',
});

export const StoredInputFileSchema = Type.Object({
  $file: Type.String(),
  filename: Type.String(),
  content_type: Type.String(),
  size_bytes: Type.Integer(),
  sha256: Type.String(),
});

export async function ingestMcpFiles(
  files: Static<typeof McpHostFilesSchema>,
  organization: string | undefined,
  ctx: AccountToolContext,
) {
  let owner = ctx;
  if (organization && organization !== ctx.organizationId) {
    if (ctx.allowCrossOrg) owner = await resolveCrossOrgToolContext(organization, ctx);
    else {
      // A scoped connection may name its current workspace by slug, but cannot switch.
      const current = ctx.organizationId && ctx.userId
        ? await resolveGrantedWorkspaceTarget({ userId: ctx.userId, grantedOrganizationIds: [ctx.organizationId], slugOrId: organization })
        : null;
      if (!current) throw new ToolUserError('File workspace is unavailable to this connection.', 403);
      owner = { ...ctx, memberRole: current.role };
    }
  }
  if (!owner.organizationId || !owner.memberRole) {
    throw new ToolUserError('Set file_organization to a granted workspace before uploading attachments.', 403);
  }
  const store = getLobuCoreServices()?.getArtifactStore();
  if (!store) throw new ToolUserError('File storage is unavailable. Try again when the gateway is ready.', 503);
  return ingestInputFiles(files.map((file) => attachmentFromUrl(file.download_url, {
    name: file.file_name,
    mimeType: file.mime_type,
  }, ctx.abortSignal)), owner, store, resolvePublicGatewayUrl(), ctx.abortSignal);
}
