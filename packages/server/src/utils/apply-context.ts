import type { Context } from 'hono';
import { eventClientId } from '../auth/event-client-id';

/**
 * `x-lobu-apply-id` groups the mutations of one `lobu apply` run into a
 * deployment (`apl_<uuid>`, minted by the CLI). Malformed values are ignored
 * rather than rejected — a bad header must never fail a mutation, only cost
 * the grouping.
 */
const APPLY_ID_RE = /^apl_[A-Za-z0-9-]{1,48}$/;

export type ConfigActorSource = 'cli' | 'ui' | 'api' | 'agent';

export interface ApplyContext {
  applyId: string | null;
  actorSource: ConfigActorSource;
  createdBy: string | null;
  clientId: string | null;
}

export function parseApplyId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  return APPLY_ID_RE.test(raw) ? raw : null;
}

/**
 * Actor source for tool-handler mutations (manage_* tools). Worker-originated
 * calls carry a verified `sourceContext` → 'agent'; the apply header wins over
 * everything (a worker can't send it — the REST proxy is the only populator).
 */
export function deriveToolActorSource(ctx: {
  applyId?: string | null;
  sourceContext?: unknown | null;
  tokenType: string;
}): ConfigActorSource {
  if (ctx.applyId) return 'cli';
  if (ctx.sourceContext) return 'agent';
  return ctx.tokenType === 'session' ? 'ui' : 'api';
}

/**
 * Derive audit-actor context for a Hono mutation handler. Actor source:
 * apply header → 'cli'; web session → 'ui'; other bearer tokens → 'api'.
 * (Worker-originated tool calls go through ToolContext, not here, and derive
 * 'agent' from `sourceContext`.)
 */
export function getApplyContext(c: Context): ApplyContext {
  const applyId = parseApplyId(c.req.header('x-lobu-apply-id'));
  const authSource = c.get('authSource') as 'session' | 'pat' | 'oauth' | null;

  const actorSource: ConfigActorSource = applyId
    ? 'cli'
    : authSource === 'session'
      ? 'ui'
      : 'api';

  // Session auth carries the actor on `user`; bearer auth on `mcpAuthInfo`.
  const user = c.get('user') as { id: string } | null;
  const authInfo = c.get('mcpAuthInfo') as {
    userId?: string;
    clientId?: string;
  } | null;

  return {
    applyId,
    actorSource,
    createdBy: user?.id ?? authInfo?.userId ?? null,
    clientId: eventClientId({ tokenType: authSource, clientId: authInfo?.clientId }),
  };
}
