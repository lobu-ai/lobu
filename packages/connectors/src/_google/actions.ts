/**
 * Connector actions compiled from a pinned Google Discovery document.
 *
 * One action per Discovery method, executed by one generic `execute`. What
 * Discovery cannot say is supplied per API by a small {@link GoogleApiPolicy}:
 * which scopes the connector may ask for, which methods stay hidden, which
 * POSTs only read, and parameter defaults such as Gmail's `userId: 'me'`.
 */
import {
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type ConnectorFile,
  downloadSizeError,
  fileDownloadOutput,
  type HttpClient,
} from '@lobu/connector-sdk';
import {
  buildGoogleRequest,
  type DiscoveryDocument,
  type DiscoveryMethod,
  discoveryMethods,
  methodInputSchema,
  methodParameters,
  type UploadMedia,
} from './discovery';
import { classifyGoogleError, type GoogleError } from './errors';

export interface GoogleApiPolicy {
  /**
   * Scopes this connector may request, narrowest first. Discovery lists the
   * scopes that can EACH authorize a method (any-of); a method requires the
   * first ladder scope it accepts. A method that accepts none is not exposed.
   */
  scopeLadder: string[];
  /**
   * Rungs every connection is granted at connect time (the auth method's
   * `requiredScopes`); the narrowest rung when omitted. A method one of them
   * authorizes requires it rather than a narrower rung the connection lacks.
   */
  connectScopes?: string[];
  /** Exact method ids never exposed. */
  blockedMethods?: string[];
  /** Method id prefixes never exposed. */
  blockedPrefixes?: string[];
  /** Non-GET methods that only read, e.g. `calendar.freebusy.query`. */
  readMethods?: string[];
  /** Non-DELETE methods that destroy data irreversibly, e.g. `calendar.calendars.clear`. */
  destructiveMethods?: string[];
  /** Filled when the caller omits the parameter, e.g. `{ userId: 'me' }`. */
  defaults?: Record<string, unknown>;
}

/**
 * Push-channel plumbing. A `watch` call registers a callback URL with Google
 * and must be paired with renewal and teardown, which the connector owns
 * through its webhook lifecycle — never something an agent invokes ad hoc.
 */
const CHANNEL_METHOD = /\.(watch|(?:channels|users)\.stop)$/;

type SkipReason = 'blocked' | 'channel' | 'deprecated' | 'scope_outside_ladder';

interface ActionTarget {
  method: DiscoveryMethod;
  /** The policy defaults this method takes, applied under the caller's input. */
  defaults: Record<string, unknown>;
  /**
   * The response is file bytes: `alt` asks for them with `alt=media` (Drive
   * `files.get`, whose plain response is JSON metadata); `body` is a method
   * that only ever answers with bytes (Drive `files.export`).
   */
  download?: 'alt' | 'body';
}

export interface CompiledGoogleApi {
  doc: DiscoveryDocument;
  actions: Record<string, ActionDefinition>;
  targets: Map<string, ActionTarget>;
  skipped: Array<{ methodId: string; reason: SkipReason }>;
}

/** `calendar.events.list` → `events_list`. */
function actionKeyFor(doc: DiscoveryDocument, methodId: string): string {
  return methodId.replace(`${doc.name}.`, '').replace(/\./g, '_');
}

function connectScopes(policy: GoogleApiPolicy): string[] {
  return policy.connectScopes ?? policy.scopeLadder.slice(0, 1);
}

/**
 * The OAuth method's scope fields. Only `optionalScopes` can be requested as an
 * upgrade later, so every rung a compiled action may require is listed there.
 */
export function oauthScopes(policy: GoogleApiPolicy): { requiredScopes: string[]; optionalScopes: string[] } {
  const required = connectScopes(policy);
  return { requiredScopes: required, optionalScopes: policy.scopeLadder.filter((s) => !required.includes(s)) };
}

function pickScope(accepted: string[] | undefined, policy: GoogleApiPolicy): string | null | undefined {
  if (!accepted || accepted.length === 0) return null; // public method: no scope needed
  const granted = connectScopes(policy).find((scope) => accepted.includes(scope));
  return granted ?? policy.scopeLadder.find((scope) => accepted.includes(scope));
}

export function compileGoogleActions(doc: DiscoveryDocument, policy: GoogleApiPolicy): CompiledGoogleApi {
  const compiled: CompiledGoogleApi = { doc, actions: {}, targets: new Map(), skipped: [] };
  const blocked = (id: string) =>
    policy.blockedMethods?.includes(id) || policy.blockedPrefixes?.some((p) => id.startsWith(p));

  for (const method of discoveryMethods(doc)) {
    const skip = (reason: SkipReason) => compiled.skipped.push({ methodId: method.id, reason });
    if (blocked(method.id)) {
      skip('blocked');
      continue;
    }
    if (CHANNEL_METHOD.test(method.id)) {
      skip('channel');
      continue;
    }
    if (method.deprecated) {
      skip('deprecated');
      continue;
    }
    const scope = pickScope(method.scopes, policy);
    if (scope === undefined) {
      skip('scope_outside_ladder');
      continue;
    }

    const isRead = method.httpMethod === 'GET' || policy.readMethods?.includes(method.id) === true;
    const defaults = Object.fromEntries(
      methodParameters(method)
        .filter(([name]) => policy.defaults && name in policy.defaults)
        .map(([name]) => [name, policy.defaults?.[name]])
    );
    const key = actionKeyFor(doc, method.id);
    const base: ActionDefinition = {
      key,
      name: method.id,
      description: method.description,
      kind: isRead ? 'read' : 'write',
      ...(scope ? { requiredScopes: [scope] } : {}),
      annotations: isRead
        ? { readOnlyHint: true, idempotentHint: true }
        : {
            openWorldHint: true,
            ...(method.httpMethod === 'DELETE' || policy.destructiveMethods?.includes(method.id)
              ? { destructiveHint: true }
              : {}),
            ...(method.httpMethod === 'PUT' ? { idempotentHint: true } : {}),
          },
      inputSchema: methodInputSchema(doc, method, defaults),
    };
    compiled.actions[key] = base;
    const bytesOnly = method.supportsMediaDownload && !method.response;
    compiled.targets.set(key, { method, defaults, ...(bytesOnly ? { download: 'body' as const } : {}) });

    if (method.supportsMediaDownload && method.response) {
      const mediaKey = `${key}_media`;
      compiled.actions[mediaKey] = {
        ...base,
        key: mediaKey,
        name: `${method.id} (media)`,
        description: `Download the content bytes of ${method.id} (alt=media) as an attachment.`,
        kind: 'read',
        annotations: { readOnlyHint: true, idempotentHint: true },
      };
      compiled.targets.set(mediaKey, { method, defaults, download: 'alt' });
    }
  }
  return compiled;
}

const MAX_RATE_LIMIT_ATTEMPTS = 3;

export async function executeGoogleAction(
  compiled: CompiledGoogleApi,
  ctx: ActionContext,
  http: HttpClient,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<ActionResult> {
  const target = compiled.targets.get(ctx.actionKey);
  if (!target) return { success: false, error: `Unknown action: ${ctx.actionKey}` };
  const action = compiled.actions[ctx.actionKey];
  const { media, ...input } = { ...target.defaults, ...ctx.input };

  try {
    const request = buildGoogleRequest(compiled.doc, target.method, input, {
      ...(target.download === 'alt' ? { media: 'download' as const } : {}),
      ...(media === undefined ? {} : { upload: uploadMedia(media, target.method) }),
    });
    for (let attempt = 1; ; attempt++) {
      const response = await http.raw(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        idempotent: action.kind === 'read',
      });
      if (response.ok) {
        if (target.download) return await downloadResult(response, String(input.fileId ?? input.id ?? target.method.id));
        return { success: true, output: jsonOutput(await response.text()) };
      }

      const error = classifyGoogleError(response.status, await response.text());
      // The SDK throws after retrying 429/5xx. Google also reports per-user rate
      // limits as 403 `rateLimitExceeded`, which only the body identifies.
      if (response.status === 403 && error.code === 'rate_limited' && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      return actionFailure(target.method.id, error);
    }
  } catch (error) {
    // The SDK client throws its HttpStatusError for 429/5xx once its own
    // retries are spent. Read the fields, not `instanceof`: the class reaches
    // this module through more than one copy of the SDK (bundles, test mocks).
    const { status, bodyText } = (error ?? {}) as { status?: unknown; bodyText?: unknown };
    if (typeof status === 'number') {
      return actionFailure(target.method.id, classifyGoogleError(status, typeof bodyText === 'string' ? bodyText : ''));
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function actionFailure(methodId: string, error: GoogleError): ActionResult {
  return {
    success: false,
    error: `${methodId} failed (${error.status} ${error.code}): ${error.message}`,
    output: { error_code: error.code, http_status: error.status, retryable: error.retryable },
  };
}

/** The server hands a resolved file input over as base64; Google wants the bytes. */
function uploadMedia(media: unknown, method: DiscoveryMethod): UploadMedia {
  const file = media as Partial<ConnectorFile> | null;
  if (typeof file?.base64 !== 'string' || typeof file.content_type !== 'string') {
    throw new Error(`${method.id}: \`media\` must be a file input (run_sdk ctx.files or a Lobu file reference).`);
  }
  return { bytes: Buffer.from(file.base64, 'base64'), contentType: file.content_type };
}

/**
 * File bytes as an attachment. Refused before reading when Google declares a
 * size over the connector limit, and again after, for responses that do not:
 * an isolate buffers the whole body, so an unbounded read is an OOM.
 */
async function downloadResult(response: Response, label: string): Promise<ActionResult> {
  const declared = Number(response.headers.get('content-length'));
  const tooBig = downloadSizeError(Number.isFinite(declared) && declared > 0 ? declared : undefined, label);
  if (tooBig) {
    await response.body?.cancel();
    return { success: false, error: tooBig };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const receivedTooBig = downloadSizeError(bytes.length, label);
  if (receivedTooBig) return { success: false, error: receivedTooBig };
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { success: true, output: fileDownloadOutput({ bytes, filename: label, mimeType }) };
}

/** Google answers JSON; an empty body (DELETE) is `{}`, anything else is kept as text. */
function jsonOutput(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { content: text };
  }
}
