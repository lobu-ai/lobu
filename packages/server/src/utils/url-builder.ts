/**
 * URL Builder for Frontend Links
 *
 * Generates consistent URLs for the frontend application.
 */

import {
  AGENT_ERRORS,
  type AgentErrorCode,
  type AgentErrorContext,
} from '@lobu/core';
import { INFERENCE_ROW_KEY_PREFIX } from '@lobu/core/reserved';
import { getWorkspaceProvider } from '../workspace';
import {
  getConfiguredPublicOrigin,
  HOSTED_UI_FALLBACK_ORIGIN,
  hasLocalFrontend,
} from './public-origin';

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  return baseUrl.replace(/\/+$/, '');
}

function withBaseUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl}${path}`;
}

/**
 * Absolutise a permalink for a destination that cannot resolve a relative one.
 *
 * In-app links are built relative on purpose so the inbox resolves them against
 * whatever origin the user is on. Chat has no origin: Slack rejects a relative
 * `url` on a button with `invalid_blocks` and drops the WHOLE message, so a
 * relative link there costs the notification its delivery.
 *
 * Returns undefined when no public origin is configured — a card with no button
 * still delivers, which a rejected message does not.
 */
export function toAbsolutePermalink(
  url: string | null | undefined,
  baseUrl?: string
): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Refused BEFORE the origin join, because the join is what makes them
  // dangerous. `//evil.example/x` and `javascript:alert(1)` both carry no
  // `http` prefix, so without this they come back out as
  // `https://app.lobu.ai//evil.example/x` — a link wearing our domain and
  // going nowhere — from a card the reader trusts. Every caller needs this,
  // not just the ones that remembered: `notify`'s `resource_url` is an
  // agent-supplied tool argument.
  if (trimmed.startsWith('//')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  const origin = getPublicWebUrl(undefined, baseUrl);
  if (!origin) return undefined;
  return `${origin}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

export function getPublicWebUrl(requestUrl?: string, baseUrl?: string): string | undefined {
  const base = baseUrl || getConfiguredPublicOrigin();
  if (base) return normalizeBaseUrl(base);
  // Backend-only self-hosters (no PUBLIC_GATEWAY_URL, no bundled frontend) should
  // still produce usable links by pointing at the hosted UI.
  if (!hasLocalFrontend()) return HOSTED_UI_FALLBACK_ORIGIN;
  if (requestUrl) return normalizeBaseUrl(new URL(requestUrl).origin);
  return undefined;
}

export async function getOrganizationSlug(
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) return null;
  return getWorkspaceProvider().getOrgSlug(organizationId);
}

/**
 * Build the agent's model/provider settings URL —
 * `<webOrigin>/<orgSlug>/agents/<agentId>/settings` — the CTA target for
 * provider/model errors (connect a provider, choose a model, reconnect
 * credentials). Returns null when any required piece is missing; callers fall
 * back to a non-linked message.
 *
 * The `/settings` suffix names the exact configuration surface instead of
 * relying on the bare agent route's default destination. A `run_id` query can
 * additionally open a held manage_agents proposal for review.
 *
 * `publicGatewayUrl` is the gateway base, which in embedded mode carries the
 * `/lobu` path suffix (the gateway is mounted at `/lobu` under the web app).
 * Admin UI routes live at the web origin (`/<slug>/agents/...`) NOT under
 * `/lobu`, so a trailing `/lobu` is stripped before composing the link.
 */
export async function buildAgentSettingsUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  agentId: string | undefined,
  // A pending manage_agents update run to review: appends `?run_id=<id>` so the
  // settings form prefills the proposed change for Approve/Reject (WI-0.3).
  opts?: { runId?: number }
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId || !agentId) return null;
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const webOrigin = publicGatewayUrl.replace(/\/+$/, '').replace(/\/lobu$/, '');
  const base = `${webOrigin}/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/settings`;
  return opts?.runId ? `${base}?run_id=${opts.runId}` : base;
}

/**
 * Build an Automation's edit URL —
 * `<webOrigin>/<orgSlug>/automations/<automationId>` — the
 * review target for a pending `manage_automations` update. Mirrors
 * {@link buildAgentSettingsUrl}: `?run_id=<id>` prefills the Automation edit form
 * with the proposed change for Approve/Reject.
 *
 * Automations live in the workspace-level Automations section (agent-owned and
 * agentless alike), so no agent id is needed. Returns null when any required
 * piece is missing; the producer falls back to the run permalink.
 */
export async function buildAutomationSettingsUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  automationId: string | number | undefined,
  opts?: { runId?: number }
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId || automationId == null) {
    return null;
  }
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const base = buildAutomationUrl(slug, automationId, publicGatewayUrl);
  return opts?.runId ? `${base}?run_id=${opts.runId}` : base;
}

/**
 * The provider's connector-detail path under an org: `/<orgSlug>/connectors/
 * <INFERENCE_ROW_KEY_PREFIX><provider>` — model providers are ordinary
 * connectors, so both provider CTAs land on the shared connector detail page.
 * The prefixed key is one path segment and contains `:`, so it is
 * percent-encoded (`inference-provider%3A…`); the SPA router decodes the param.
 * No provider → the connectors list.
 */
function providerConnectorPath(slug: string, provider?: string): string {
  const base = `/${encodeURIComponent(slug)}/connectors`;
  if (!provider) return base;
  return `${base}/${encodeURIComponent(`${INFERENCE_ROW_KEY_PREFIX}${provider}`)}`;
}

/**
 * Build the org's "connect a provider" URL — the provider's connector detail
 * page (which hosts the create-provider form while the provider is not
 * connected yet) — as opposed to *picking a model* on an agent (which is
 * {@link buildAgentSettingsUrl}). This is the same live route the pre-enqueue
 * model-provider preflight links to.
 *
 * `model`/`reason`/`agentId` prefill the connect form and drive the agent
 * explainer banner. Returns null when any required piece is missing; callers
 * fall back to a non-linked message. The `/lobu` embedded-mode suffix is
 * stripped like the sibling builders.
 */
export async function buildProviderConnectUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  prefill?: {
    provider?: string;
    model?: string;
    reason?: string;
    agentId?: string;
  }
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId) return null;
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const webOrigin = publicGatewayUrl.replace(/\/+$/, '').replace(/\/lobu$/, '');
  const url = new URL(providerConnectorPath(slug, prefill?.provider), `${webOrigin}/`);
  if (prefill?.provider) {
    if (prefill.model) url.searchParams.set('model', prefill.model);
    if (prefill.reason) url.searchParams.set('reason', prefill.reason);
    if (prefill.agentId) url.searchParams.set('agentId', prefill.agentId);
  }
  return url.toString();
}

/**
 * Build the org's existing-provider management URL — the same connector detail
 * page as {@link buildProviderConnectUrl} (a connected provider renders its
 * management body there). `model` is non-secret targeting context carried from
 * the worker; it opens the provider's edit controls.
 */
export async function buildProviderManagementUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  target?: { provider?: string; model?: string }
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId) return null;
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const webOrigin = publicGatewayUrl.replace(/\/+$/, '').replace(/\/lobu$/, '');
  const url = new URL(providerConnectorPath(slug, target?.provider), `${webOrigin}/`);
  if (target?.provider && target.model) url.searchParams.set('model', target.model);
  return url.toString();
}

export interface RenderedAgentError {
  /** User-facing body (no link appended — carry `ctaUrl` separately). */
  text: string;
  /** Resolved CTA link, or null when the code has no CTA / it couldn't build. */
  ctaUrl: string | null;
  /** Button/link label for `ctaUrl`. */
  ctaLabel?: string;
  /** True when this code is intentionally silent (no user message emitted). */
  silent: boolean;
}

/**
 * Per-CTA-kind URL resolvers, injected so `renderAgentError` stays free of the
 * per-surface plumbing (org slug / agent id / public origin live in the caller).
 * The catalog's actionable CTA kinds land on DIFFERENT pages:
 *   - `agent-settings`   → the agent's model/provider settings (pick a model).
 *   - `provider-connect` → the org's connect-a-provider page (wire credentials).
 *   - `provider-management` → the existing provider's management surface.
 * A kind whose resolver is absent (or resolves null) renders with no button.
 */
export interface AgentErrorCtaResolvers {
  'agent-settings'?: () => Promise<string | null>;
  'provider-connect'?: () => Promise<string | null>;
  'provider-management'?: () => Promise<string | null>;
}

/**
 * Registry names that cannot be derived by capitalising the slug. This stays
 * static so reporting an error never depends on registry I/O; the contract test
 * pins the values to `config/providers.json`.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  chatgpt: 'ChatGPT',
  'together-ai': 'Together AI',
  nvidia: 'NVIDIA NIM',
  fireworks: 'Fireworks AI',
  openrouter: 'OpenRouter',
  'opencode-zen': 'OpenCode Zen',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  openai: 'OpenAI API',
  // SDK vendor alias used before a registry slug is available.
  anthropic: 'Anthropic',
};

function providerDisplayName(slug: string): string {
  const known = PROVIDER_DISPLAY_NAMES[slug.toLowerCase()];
  if (known) return known;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * Label provider errors and unwrap the common JSON message envelope without
 * rewording plain-text bodies.
 */
export function labelProviderErrorBody(
  body: string | undefined,
  provider: string | undefined
): string | undefined {
  if (!body) return body;
  if (!provider) return body;

  // Bodies arrive as `<status> <json>` (e.g. `400 {...}`) or bare JSON. Find the
  // first brace so the status code does not defeat the parse.
  const braceAt = body.indexOf('{');
  let message = body;
  if (braceAt !== -1) {
    try {
      const parsed: unknown = JSON.parse(body.slice(braceAt));
      const inner =
        typeof parsed === 'object' && parsed !== null
          ? ((parsed as { error?: { message?: unknown }; message?: unknown })
              .error?.message ??
            (parsed as { message?: unknown }).message)
          : undefined;
      if (typeof inner === 'string' && inner.trim()) message = inner.trim();
    } catch {
      // Preserve a plain-text body that happens to contain a brace.
    }
  }

  return `${providerDisplayName(provider)} returned an error:\n${message}`;
}

/**
 * THE renderer: turn an `AgentErrorCode` + the raw provider message into the
 * user-facing body and a resolved CTA link. Every surface — Slack/Telegram
 * bridge, browser SSE — calls this so the same error reads identically
 * everywhere.
 *
 * Provider errors use {@link labelProviderErrorBody}; synthesized worker/config
 * errors use the catalog message. The catalog's CTA kind is resolved to a URL
 * through the matching injected resolver.
 */
export async function renderAgentError(
  code: AgentErrorCode,
  providerMessage: string | undefined,
  resolvers: AgentErrorCtaResolvers,
  errorContext?: AgentErrorContext
): Promise<RenderedAgentError> {
  const spec = AGENT_ERRORS[code];
  const text =
    spec.message ??
    labelProviderErrorBody(providerMessage, errorContext?.provider) ??
    '';
  let ctaUrl: string | null = null;
  const resolve =
    spec.cta === 'agent-settings' ||
    spec.cta === 'provider-connect' ||
    spec.cta === 'provider-management'
      ? resolvers[spec.cta]
      : undefined;
  if (resolve) {
    ctaUrl = await resolve().catch(() => null);
  }
  return {
    text,
    ctaUrl,
    ctaLabel: spec.ctaLabel,
    silent: spec.silent ?? false,
  };
}

export interface EntityInfo {
  ownerSlug: string;
  entityType: string;
  slug: string;
  parentType?: string | null;
  parentSlug?: string | null;
}

/**
 * Build URL to view an entity
 * Pattern: /{ownerSlug}/{type}/{slug}/[{type}/{slug}]
 */
export function buildEntityUrl(info: EntityInfo, baseUrl?: string): string {
  const segments: string[] = [];
  if (info.parentType && info.parentSlug) {
    segments.push(`${info.parentType}/${info.parentSlug}`);
  }
  segments.push(`${info.entityType}/${info.slug}`);
  return withBaseUrl(normalizeBaseUrl(baseUrl), `/${info.ownerSlug}/${segments.join('/')}`);
}

/** Build the canonical Automation detail URL (workspace-level Automations section). */
export function buildAutomationUrl(
  ownerSlug: string,
  automationId: string | number,
  baseUrl?: string
): string {
  const webOrigin = normalizeBaseUrl(baseUrl)?.replace(/\/lobu$/, '');
  const path = `/${encodeURIComponent(ownerSlug)}/automations/${encodeURIComponent(String(automationId))}`;
  return withBaseUrl(webOrigin, path);
}

/**
 * Build URL to view connections (data sources) for a workspace.
 *
 * - No connectorKey → list page: `/{ownerSlug}/connectors`
 * - With connectorKey → detail page: `/{ownerSlug}/connectors/{connectorKey}`
 * - `query.install` adds `?install=…` (useful with or without a connector key)
 */
export function buildConnectionsUrl(
  ownerSlug: string,
  baseUrl?: string,
  connectorKey?: string | null,
  query?: { install?: string } | null
): string {
  const detailSegment = connectorKey ? `/${connectorKey}` : '';
  const params = new URLSearchParams();
  if (query?.install) params.set('install', query.install);
  const queryString = params.toString();
  const queryPart = queryString ? `?${queryString}` : '';
  return withBaseUrl(
    normalizeBaseUrl(baseUrl),
    `/${ownerSlug}/connectors${detailSegment}${queryPart}`
  );
}

/** Build the exact installed-connection detail route. */
export function buildConnectionUrl(
  ownerSlug: string,
  connectorKey: string,
  connectionId: number,
  baseUrl?: string
): string {
  return withBaseUrl(
    normalizeBaseUrl(baseUrl),
    `/${ownerSlug}/connectors/${connectorKey}/${connectionId}`
  );
}

/** Open the existing connection's authorization controls, preserving workspace identity. */
export function buildConnectionAuthUrl(
  ownerSlug: string,
  connectorKey: string,
  connectionId: number,
  baseUrl?: string,
  result?: 'connected' | 'cancelled' | 'failed'
): string {
  const params = new URLSearchParams({ settings: 'true' });
  if (result) params.set('auth_result', result);
  return `${buildConnectionUrl(ownerSlug, connectorKey, connectionId, baseUrl)}?${params}#connection-auth`;
}

/**
 * A slice of the memory/events log to permalink into. One discriminated union
 * so every caller (approval_url, notification resourceUrl, agent output) picks a
 * *kind* and the URL shape is decided in exactly one place — no caller
 * hand-assembles `?content_ids=`/`?run_ids=`/`?feed_ids=` strings.
 *
 * Which kind to use:
 *  - `run`   — the link's identity is one execution (an operation approval, an
 *    automation/scheduled run). Survives the supersede chain by construction: a
 *    run's events share one run_id and run-scoped reads were never masked by
 *    `superseded_by IS NULL`.
 *  - `event` — a point in the log (a specific card). Read-side chain resolution
 *    (get_content) resolves a superseded id to its full lineage, so a frozen
 *    event permalink still lands even after it's superseded.
 *  - `feed`  — a channel / conversational stream (all activity in #leads).
 *  - `automation_run` — one execution scoped to its Automation drill-down. Requires
 *    both route identifiers: the owning agent and the Automation.
 */
export type MemoryResource =
  | { kind: 'run'; runId: number }
  | { kind: 'automation_run'; runId: number; agentId: string; automationId: number }
  | { kind: 'event'; eventId: number }
  | { kind: 'feed'; feedId: number };

/** The `?param=value` query for a {@link MemoryResource}. */
function memoryResourceQuery(resource: MemoryResource): string {
  switch (resource.kind) {
    case 'run':
      return `run_ids=${resource.runId}`;
    case 'automation_run':
      return `agent=${encodeURIComponent(resource.agentId)}&automation=${resource.automationId}&run_ids=${resource.runId}`;
    case 'event':
      return `content_ids=${resource.eventId}`;
    case 'feed':
      return `feed_ids=${resource.feedId}`;
  }
}

/**
 * Build a permalink into the memory/events log for a {@link MemoryResource}.
 * Pattern: /{ownerSlug}/memory?<resource query>
 *
 * This is the ONE place a memory permalink is assembled. `ownerSlug` empty →
 * returns undefined (no org context, can't build a usable link).
 */
export function buildResourcePermalink(
  ownerSlug: string | null | undefined,
  resource: MemoryResource,
  baseUrl?: string
): string | undefined {
  if (!ownerSlug) return undefined;
  return withBaseUrl(
    normalizeBaseUrl(baseUrl),
    `/${ownerSlug}/memory?${memoryResourceQuery(resource)}`
  );
}

/**
 * Build URL to view entity content
 */
export function buildContentUrl(
  info: EntityInfo,
  filters?: {
    platform?: string;
    since?: string;
    until?: string;
    connectionId?: number;
  },
  baseUrl?: string
): string {
  const basePath = `${buildEntityUrl(info, baseUrl)}/content`;

  if (!filters) return basePath;

  const params = new URLSearchParams();
  if (filters.platform) params.set('platform', filters.platform);
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  if (filters.connectionId) params.set('connection_id', String(filters.connectionId));

  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

/**
 * Convert the gateway's configured PUBLIC base into the origin an agent composes
 * user-openable Lobu links against.
 *
 * Never a request Host header and never `DISPATCHER_URL`: the worker calls the
 * gateway over an internal cluster address, so both resolve to hostnames no user
 * can open.
 *
 * The `/lobu` strip mirrors {@link buildAgentSettingsUrl} EXACTLY, including its
 * limits. Prod runs `PUBLIC_GATEWAY_URL=https://app.lobu.ai/lobu` with the
 * gateway mounted under that prefix while the frontend routes these links target
 * are not, so an unstripped base 404s. A different mount path is preserved
 * rather than dropped — not because that is obviously right, but because
 * `buildAgentSettingsUrl` preserves it, and an agent whose links disagree with
 * the server's is worse than both being wrong the same way. Change the two
 * together or not at all.
 *
 * Returns undefined for an unparseable or non-HTTP(S) base so the caller omits
 * the link: a mangled origin — or a `javascript:` one — pasted into a reply to a
 * user is worse than no link.
 */
export function toPublicWebOrigin(
  publicGatewayUrl: string | undefined
): string | undefined {
  if (!publicGatewayUrl?.trim()) return undefined;
  try {
    const parsed = new URL(publicGatewayUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\/lobu$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return undefined;
  }
}
