import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { mcpAuth } from '../auth/middleware';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { ingestInputFiles, MAX_INPUT_FILES, MAX_INPUT_TOTAL_BYTES } from '../gateway/files/input-files';
import type { Env } from '../index';
import { getLobuCoreServices } from '../lobu/gateway';
import { extractAuthContext, toToolContext } from '../tools/execute';
import { ToolUserError } from '../utils/errors';
import { resolvePublicGatewayUrl } from '../utils/public-origin';

/** Ordinary authenticated multipart intake, usable by any client. */
export const inputFileRoutes = new Hono<{ Bindings: Env }>();
inputFileRoutes.post('/', mcpAuth, async (c, next) => {
  const ctx = extractAuthContext(c);
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.organizationId || !ctx.memberRole || !hasRequiredMcpScope('write', ctx.scopes)) {
    return c.json({ error: 'File upload requires workspace membership and write access.' }, 403);
  }
  if (ctx.executionMode === 'capture') return c.json({ error: 'File uploads cannot run in preview mode.' }, 400);
  return next();
}, bodyLimit({
  maxSize: MAX_INPUT_TOTAL_BYTES + 1024 * 1024,
  onError: (c) => c.json({ error: 'Files exceed the upload size limit.' }, 413),
}), async (c) => {
  const store = getLobuCoreServices()?.getArtifactStore();
  if (!store) return c.json({ error: 'File storage is unavailable.' }, 503);
  try {
    const form = await c.req.formData();
    const entries = form.getAll('files');
    if (!entries.length || entries.length > MAX_INPUT_FILES || entries.some((entry) => !(entry instanceof File))) {
      return c.json({ error: `Supply 1–${MAX_INPUT_FILES} files in the multipart files field.` }, 400);
    }
    const files = await ingestInputFiles((entries as File[]).map((file) => ({
      name: file.name, mimeType: file.type || 'application/octet-stream', data: file,
    })), toToolContext(extractAuthContext(c)), store, resolvePublicGatewayUrl(), c.req.raw.signal);
    return c.json({ files }, 201);
  } catch (error) {
    if (error instanceof ToolUserError) return c.json({ error: error.message }, error.httpStatus as ContentfulStatusCode);
    if (error instanceof TypeError) return c.json({ error: 'Supply a valid multipart file upload.' }, 400);
    throw error;
  }
});
