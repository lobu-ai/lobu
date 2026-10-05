import { createHash } from 'node:crypto';
import { currentMcpActivityAttribution, normalizeMcpConversationTitle } from '../lobu/stores/mcp-client-conversations';
import type { ToolContext } from '../tools/registry';

/** The gateway formats context titles. The extension preserves supplied labels. */
export const BROWSER_GROUP_TITLE_PREFIX = 'Lobu';
const TITLE_HEAD = `${BROWSER_GROUP_TITLE_PREFIX} · `;

/**
 * Who is acting in the browser, stamped on every Chrome action. The extension
 * labels the tabs it opens with `title` (the agent) and `flow_id` (the
 * session), which navigate's reuse and busy_by read. Identity is flow_id +
 * kind; the title is display only.
 */
export type BrowserActionContext = {
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
    title: `${TITLE_HEAD}Browser task · ${runId}`,
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
    typeof record.title !== 'string' ||
    !record.title ||
    typeof record.flow_id !== 'string' ||
    !record.flow_id ||
    !['automation', 'conversation', 'mcp', 'run'].includes(String(record.kind))
  ) {
    return null;
  }
  return {
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
    return {
      title: browserTitle(ctx, 'Conversation', digest),
      flow_id: `conversation:${digest}`,
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
    return {
      title: browserTitle(ctx, 'MCP activity', digest),
      flow_id: `mcp:${digest}`,
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
  // No longer sent, but still stripped: the 0.8 extension keys tab ownership on
  // it, so a caller-supplied copy would let an agent address another flow's tabs.
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
    browser_context_title: context.title,
    browser_flow_id: context.flow_id,
    ...(Number.isInteger(activationTabId) && (activationTabId as number) > 0
      ? { activation_tab_id: activationTabId as number, activation_target_urls: activationTargetUrls }
      : {}),
  };
}
