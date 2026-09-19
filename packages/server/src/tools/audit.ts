import { createHash, randomUUID } from 'node:crypto';
import { REDACTED_SENTINEL } from '@lobu/core';
import { currentMcpActivityEventMetadata } from '../lobu/stores/mcp-client-conversations';
import { parsePositiveIntegerId } from '../utils/errors';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { sanitizeAuditArgs } from './audit-args';
import { AUDIT_SEMANTIC_TYPE } from './constants';
import { getTool, type ToolContext } from './registry';

const MAX_PREVIEW_CHARS = 500;
const MAX_REQUEST_BYTES = 256 * 1024;
// These tools retain their request, except host file capabilities, on the
// audit event. Other tools retain only the sanitized summary below.
const REQUEST_EVENT_TOOLS = new Set(['run_sdk', 'query_sdk', 'query_sql']);
const KNOWN_SECRET_SHAPE_RE =
  /\b(?:sk[-_][a-z0-9_-]{8,}|xox[baprs]-[a-z0-9-]{8,}|gh[pousr]_[a-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/gi;
// Redaction principle: consume the COMPLETE credential. Over-consumption is
// fine (previews are display-only; identity comes from the hash of the
// redacted form), partial redaction is not — a stop at the first space,
// comma, or scheme word leaks the remainder.
//
// Header-named credentials carry STRUCTURED values (scheme + params, cookie
// lists), so everything after the separator is credential material — consume
// to the end of the string/line.
const HEADER_CREDENTIAL_RE =
  /\b(authorization|proxy-authorization|www-authenticate|set-cookie|cookie)\s*["']?\s*[:=]\s*[^\n]+/gi;
// Bare scheme credentials: Digest takes a comma-delimited key=value list
// (quoted values included); token schemes take a single blob.
const AUTH_SCHEME_RE =
  /\b(bearer|basic|digest)\s+(?:[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+)(?:\s*,\s*[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+))*|[a-z0-9._~+/=:-]+)/gi;
// Denylisted key assignments: a quoted string up to its closing quote (spaces
// included), otherwise an unquoted run that does not stop at commas.
const SENSITIVE_ASSIGNMENT_RE =
  /(api[_-]?key|credential|password|private[_-]?key|secret|token)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s'"}]+)/gi;

interface ToolInvocationAuditParams {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  durationMs: number;
  ctx: Pick<ToolContext, 'userId' | 'tokenType' | 'clientId' | 'agentId' |
    'mcpSessionId' | 'mcpConversationId'> & { organizationId: string | null };
}

function captureRequest(params: ToolInvocationAuditParams): Record<string, unknown> | null {
  if (!REQUEST_EVENT_TOOLS.has(params.toolName)) return null;

  try {
    const request = { ...params.args };
    // Host attachment fields contain signed download URLs. Use the tool's
    // declaration, including on validation failure, and never retain them.
    const fileParams = getTool(params.toolName)?.mcpMeta?.['openai/fileParams'];
    if (Array.isArray(fileParams)) {
      for (const key of fileParams) {
        if (typeof key === 'string' && Object.hasOwn(request, key)) request[key] = REDACTED_SENTINEL;
      }
    }
    const serialized = JSON.stringify(request);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_REQUEST_BYTES) {
      return { request_status: 'too_large', request_bytes: bytes };
    }
    return {
      request_status: 'complete',
      request,
    };
  } catch (error) {
    logger.warn({ error, toolName: params.toolName }, 'Failed to capture tool request');
    return { request_status: 'unavailable' };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactSensitiveText(value: string): string {
  return value
    .replace(HEADER_CREDENTIAL_RE, (_match, key: string) => `${key}=[redacted]`)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}=[redacted]`)
    .replace(KNOWN_SECRET_SHAPE_RE, '[redacted]');
}

function redactPreview(value: string): string {
  // Redact BEFORE truncating: slicing first can split a quoted credential and
  // the unbalanced quote defeats the pattern, leaking the visible fragment.
  return redactSensitiveText(value).slice(0, MAX_PREVIEW_CHARS);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorPayload(
  error: unknown,
  fallbackName: string = 'Error'
): Record<string, unknown> | null {
  if (!error) return null;
  if (error instanceof Error) {
    return { name: error.name, message: redactPreview(error.message) };
  }
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : fallbackName,
      message:
        typeof record.message === 'string'
          ? redactPreview(record.message)
          : fallbackName,
    };
  }
  return { name: fallbackName, message: redactPreview(String(error)) };
}

/**
 * Error shape for GENERIC audit entries: the class name (and `code` when the
 * error carries one) only. Handler-supplied message text can echo user values
 * in shapes no pattern enumerates, so it never reaches the append-only ledger
 * — the caller already received the full error on the live response.
 */
function errorNameOnly(error: unknown, fallbackName: string): Record<string, unknown> | null {
  if (!error) return null;
  const record =
    typeof error === 'object' ? (error as Record<string, unknown>) : ({} as Record<string, unknown>);
  const name =
    error instanceof Error ? error.name
    : typeof record.name === 'string' ? record.name
    : fallbackName;
  return typeof record.code === 'string' ? { name, code: record.code } : { name };
}

function manageAutomationsIdentity(args: Record<string, unknown>): {
  action: string | null;
  automation_id: string | null;
  automation_ids: string[];
} {
  const validActions = new Set([
    'list', 'create', 'update', 'create_version', 'create_from_version',
    'claim_next_window', 'complete_window', 'trigger', 'delete',
    'set_reaction_script', 'get_versions', 'get_version_details',
    'get_component_reference', 'submit_feedback', 'get_feedback', 'list_promoted',
  ]);
  const action = typeof args.action === 'string' && validActions.has(args.action)
    ? args.action
    : null;
  const validId = (value: unknown): string | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value);
    try {
      parsePositiveIntegerId(text, 'automation_id');
      return text;
    } catch {
      return null;
    }
  };
  const automationId = validId(args.automation_id);
  const ids = Array.isArray(args.automation_ids)
    ? args.automation_ids.map(validId).filter((v): v is string => v != null)
    : [];
  return { action, automation_id: automationId ?? ids[0] ?? null, automation_ids: ids };
}

function buildManageAutomationsInvocationPayload(
  params: ToolInvocationAuditParams,
  result: Record<string, unknown>
): Record<string, unknown> | null {
  const identity = manageAutomationsIdentity(params.args as Record<string, unknown>);
  const sanitizedArgsJson = JSON.stringify(
    sanitizeAuditArgs(params.args, getTool(params.toolName)?.inputSchema)
  );
  // Delete returns an aggregate summary, not a top-level success flag: an
  // all-failed batch (failed>0 && successful=0) is a failure, while a partial
  // batch (successful>0) remains completed with per-ID failures in the summary.
  const summary = asObject(result.summary);
  const deleteAllFailed =
    typeof summary.failed === 'number' &&
    summary.failed > 0 &&
    summary.successful === 0;
  const reportedFailure =
    result.error != null ||
    result.success === false ||
    result.status === 'failed' ||
    result.status === 'error' ||
    result.status === 'timeout' ||
    deleteAllFailed;
  const softError = reportedFailure ? errorNameOnly(result.error, 'ToolError') ?? { name: 'ToolError' } : null;
  const thrownError = errorNameOnly(params.error, 'Error');
  return {
    tool_name: params.toolName,
    action: identity.action,
    automation_id: identity.automation_id,
    automation_ids: identity.automation_ids,
    args_sha256: sha256(sanitizedArgsJson),
    args_preview_redacted: sanitizedArgsJson.slice(0, MAX_PREVIEW_CHARS),
    success: !(thrownError || softError),
    error: thrownError ?? softError,
    duration_ms: params.durationMs,
  };
}

function buildPayload(params: ToolInvocationAuditParams): Record<string, unknown> | null {
  const result = asObject(params.result);
  const toolError = params.error ? errorPayload(params.error) : null;

  if (params.toolName === 'run_sdk') {
    const script = typeof params.args.script === 'string' ? params.args.script : '';
    const resultError = errorPayload(result.error);
    return {
      tool_name: params.toolName,
      dry_run: params.args.dry_run === true,
      script_sha256: script ? sha256(script) : null,
      script_preview_redacted: script ? redactPreview(script) : null,
      sdk_call_count: typeof result.sdk_calls === 'number' ? result.sdk_calls : null,
      sdk_call_trace: Array.isArray(result.sdk_call_trace) ? result.sdk_call_trace : [],
      side_effect_preview: Array.isArray(result.side_effect_preview)
        ? result.side_effect_preview
        : [],
      // `skipped_calls` survives preview truncation; fall back to array length
      // for older payloads.
      side_effect_count:
        typeof result.skipped_calls === 'number'
          ? result.skipped_calls
          : Array.isArray(result.side_effect_preview)
            ? result.side_effect_preview.length
            : 0,
      success: toolError ? false : result.success === true,
      error: toolError ?? resultError,
      duration_ms: params.durationMs,
    };
  }

  if (params.toolName === 'query_sql') {
    const sql = typeof params.args.sql === 'string' ? params.args.sql : '';
    const resultError =
      typeof result.error === 'string'
        ? { name: 'QuerySqlError', message: redactPreview(result.error) }
        : null;
    return {
      tool_name: params.toolName,
      sql_sha256: sql ? sha256(sql) : null,
      sql_preview_redacted: sql ? redactPreview(sql) : null,
      // The event stays in the bound org, so retain the requested target.
      org_slug: typeof params.args.org_slug === 'string' ? params.args.org_slug : null,
      sort_by: typeof params.args.sort_by === 'string' ? params.args.sort_by : null,
      sort_order: params.args.sort_order === 'desc' ? 'desc' : 'asc',
      limit: typeof params.args.limit === 'number' ? params.args.limit : null,
      offset: typeof params.args.offset === 'number' ? params.args.offset : null,
      row_count: Array.isArray(result.rows) ? result.rows.length : 0,
      total_count: typeof result.total_count === 'number' ? result.total_count : null,
      success: !(toolError || resultError),
      error: toolError ?? resultError,
      duration_ms: params.durationMs,
    };
  }

  // manage_automations invocations are the distinguishable record for
  // failed/denied attempts (#3664): applied mutations emit category='config'
  // events, while every invocation — including web/session and denied ones —
  // lands here as category='audit' with the structured action + automation id.
  // This never touches the config fold.
  if (params.toolName === 'manage_automations') {
    return buildManageAutomationsInvocationPayload(params, result);
  }

  // Browser-session and anonymous generic reads stay out of Activity. Power
  // tools are retained because their invocation history is the audit product.
  if (
    !REQUEST_EVENT_TOOLS.has(params.toolName) &&
    params.ctx.tokenType !== 'oauth' &&
    params.ctx.tokenType !== 'pat'
  ) {
    return null;
  }
  // The preview and hash are built from the SANITIZED args: a leaf survives
  // only when it is structural (boolean/null) or is a member of the closed
  // literal set the tool's own schema declares for that top-level key — see
  // `sanitizeAuditArgs`. A raw or pattern-redacted serialization would persist
  // free-text values (and an unsalted credential-derived digest) whenever a
  // secret hides in a shape no pattern enumerates. These two fields record the
  // call shape and its declared discriminators; request-bearing tools
  // additionally retain their request below, excluding host file capabilities.
  const sanitizedArgsJson = JSON.stringify(
    sanitizeAuditArgs(params.args, getTool(params.toolName)?.inputSchema)
  );
  const reportedFailure =
    result.error != null ||
    result.success === false ||
    result.status === 'failed' ||
    result.status === 'error' ||
    result.status === 'timeout';
  const softError = reportedFailure ? errorNameOnly(result.error, 'ToolError') ?? { name: 'ToolError' } : null;
  const thrownError = errorNameOnly(params.error, 'Error');
  return {
    tool_name: params.toolName,
    args_sha256: sha256(sanitizedArgsJson),
    args_preview_redacted: sanitizedArgsJson.slice(0, MAX_PREVIEW_CHARS),
    success: !(thrownError || softError),
    error: thrownError ?? softError,
    duration_ms: params.durationMs,
  };
}

export async function recordToolInvocationAudit(
  params: ToolInvocationAuditParams
): Promise<void> {
  try {
    const payload = buildPayload(params);
    if (!payload) return;
    const request = captureRequest(params);
    if (request) Object.assign(payload, request);
    const success = payload.success === true;
    const identity =
      params.toolName === 'manage_automations'
        ? manageAutomationsIdentity(params.args as Record<string, unknown>)
        : null;
    await insertEvent({
      entityIds: [],
      organizationId: params.ctx.organizationId,
      originId: `tool_invocation:${params.toolName}:${Date.now()}:${randomUUID()}`,
      title: `${params.toolName} ${success ? 'completed' : 'failed'}`,
      payloadType: 'empty',
      payloadData: payload,
      semanticType: AUDIT_SEMANTIC_TYPE,
      originType: 'tool_invocation',
      metadata: {
        category: 'audit',
        event_type: 'tool_invocation.completed',
        tool_name: params.toolName,
        token_type: params.ctx.tokenType,
        agent_id: params.ctx.agentId ?? null,
        ...(identity?.action ? { action: identity.action } : {}),
        ...(identity?.automation_id ? { automation_id: identity.automation_id } : {}),
        ...(identity && identity.automation_ids.length > 0 ? { automation_ids: identity.automation_ids } : {}),
        ...currentMcpActivityEventMetadata(params.ctx),
      },
      createdBy: params.ctx.userId ?? null,
      clientId: params.ctx.clientId ?? null,
    });
  } catch (auditError) {
    logger.warn(
      { err: auditError, toolName: params.toolName },
      'Failed to record tool invocation audit event'
    );
  }
}
