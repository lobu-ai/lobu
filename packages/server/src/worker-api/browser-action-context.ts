import { createHash } from 'node:crypto';
import { currentMcpActivityAttribution, normalizeMcpConversationTitle } from '../lobu/stores/mcp-client-conversations';
import type { ToolContext } from '../tools/registry';

/** The gateway formats context titles. The extension preserves supplied labels. */
export const BROWSER_GROUP_TITLE_PREFIX = 'Lobu';
const TITLE_HEAD = `${BROWSER_GROUP_TITLE_PREFIX} · `;

export type BrowserActionContext = {
  id: string;
  title: string;
  flow_id: string;
  kind: 'automation' | 'conversation' | 'mcp' | 'run';
};

function shortDigest(parts: Array<string | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => part ?? '').join('\0'))
    .digest('hex')
    .slice(0, 12);
}

function positiveRunId(value: unknown): number | null {
  const runId = Number(value);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

export function runScopedBrowserActionContext(runIdValue: unknown): BrowserActionContext {
  const runId = positiveRunId(runIdValue);
  if (runId == null) throw new Error('Browser action context requires a positive run id.');
  return {
    id: `run:${runId}`,
    title: `${TITLE_HEAD}Browser task · ${runId}`,
    flow_id: String(runId),
    kind: 'run',
  };
}

/**
 * Shared container for standalone Chrome actions that belong to no richer
 * context. Without this, every unparented action fell back to its own run id as
 * the context key, so ten SDK navigates produced ten visible tab groups.
 *
 * The key is derived from server-held provenance (organization + browser
 * connection) — never from caller input, which `trustedChromeActionInput`
 * strips precisely so an agent cannot address another flow's group. Two
 * unrelated actions therefore share the visible GROUP while each tab keeps its
 * own per-run flow lease, so they display together without either being able
 * to close or drive the other's tab.
 */
export function standaloneBrowserActionContext(
  organizationId: string | null,
  connectionId: number | null,
  runIdValue: unknown
): BrowserActionContext | null {
  const runId = positiveRunId(runIdValue);
  if (runId == null || !organizationId || connectionId == null) return null;
  const digest = shortDigest([organizationId, String(connectionId)]);
  return {
    id: `run:standalone-${digest}`,
    title: `${TITLE_HEAD}Browser actions`,
    // The flow stays per-run: shared group, unshared ownership.
    flow_id: String(runId),
    kind: 'run',
  };
}

export function browserContextWithFlow(
  context: BrowserActionContext,
  runIdValue: unknown
): BrowserActionContext {
  const runId = positiveRunId(runIdValue);
  if (runId == null) throw new Error('Browser flow ownership requires a positive run id.');
  return { ...context, flow_id: String(runId) };
}

export function browserActionContextFromMetadata(
  metadata: unknown
): BrowserActionContext | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).browser_context;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.title !== 'string' ||
    !record.title ||
    typeof record.flow_id !== 'string' ||
    !record.flow_id ||
    !['automation', 'conversation', 'mcp', 'run'].includes(String(record.kind))
  ) {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    flow_id: record.flow_id,
    kind: record.kind as BrowserActionContext['kind'],
  };
}

function browserTitle(ctx: ToolContext, fallback: string, suffix: string): string {
  const subject = normalizeMcpConversationTitle(ctx.sdkBrowserInvocation?.title ?? '');
  return `${TITLE_HEAD}${subject || fallback} · ${suffix}`;
}

export function deriveSdkBrowserActionContext(ctx: ToolContext): BrowserActionContext | null {
  if (!ctx.sdkBrowserInvocation || !ctx.userId || !ctx.isAuthenticated) return null;
  const digest = createHash('sha256')
    .update(JSON.stringify([ctx.organizationId, ctx.userId, ctx.sdkBrowserInvocation.nonce]))
    .digest('hex');
  return {
    id: `run:sdk-${digest}`,
    flow_id: `sdk-${digest}`,
    title: browserTitle(ctx, 'Browser task', digest.slice(0, 12)),
    kind: 'run',
  };
}

export function deriveBrowserActionContext(ctx: ToolContext): BrowserActionContext | null {
  const automationId = positiveRunId(ctx.actingAutomationId);
  const actingRunId = positiveRunId(ctx.actingRunId);
  if (automationId != null && actingRunId != null) {
    return {
      id: `automation:${actingRunId}`,
      title: browserTitle(ctx, `Automation ${automationId}`, `Run ${actingRunId}`),
      flow_id: String(actingRunId),
      kind: 'automation',
    };
  }

  const sourceConversationId = ctx.sourceContext?.conversationId?.trim();
  if (sourceConversationId) {
    const digest = shortDigest([
      ctx.organizationId,
      ctx.sourceContext?.platform,
      ctx.sourceContext?.connectionId,
      ctx.sourceContext?.teamId,
      ctx.sourceContext?.channelId,
      sourceConversationId,
    ]);
    const id = `conversation:${digest}`;
    return {
      id,
      title: browserTitle(ctx, 'Conversation', digest),
      flow_id: id,
      kind: 'conversation',
    };
  }

  const activity = currentMcpActivityAttribution(ctx);
  if (activity) {
    const digest = shortDigest([
      ctx.organizationId,
      activity.clientIdentity,
      activity.activityKind,
      activity.activityId,
    ]);
    const id = `mcp:${digest}`;
    return {
      id,
      title: browserTitle(ctx, 'MCP activity', digest),
      flow_id: id,
      kind: 'mcp',
    };
  }

  return null;
}

export function trustedChromeActionInput(
  input: Record<string, unknown>,
  context: BrowserActionContext,
  activationTabId?: number | null,
  activationTargetUrls: string[] = []
): Record<string, unknown> {
  const trusted = { ...input };
  delete trusted.browser_context_id;
  delete trusted.browser_context_title;
  delete trusted.browser_flow_id;
  delete trusted.holder_run_id;
  delete trusted.parent_run_id;
  // Always deleted, then re-added only from the server's own resolution below.
  // A connector that names an activated tab — or the pages that tab is allowed
  // to be on — must never be believed: together these fields are what let the
  // extension mutate a tab the USER owns, so a caller-supplied copy would be a
  // way to launder any tab id, or any target URL, into that authority.
  delete trusted.activation_tab_id;
  delete trusted.activation_target_urls;
  return {
    ...trusted,
    browser_context_id: context.id,
    browser_context_title: context.title,
    browser_flow_id: context.flow_id,
    ...(Number.isInteger(activationTabId) && (activationTabId as number) > 0
      ? { activation_tab_id: activationTabId as number, activation_target_urls: activationTargetUrls }
      : {}),
  };
}
