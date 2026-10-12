import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOBU_CONFIG_DIR = join(homedir(), ".config", "lobu");
export const DEFAULT_CONTEXT_NAME = "lobu";
const DEFAULT_CONTEXT_URL = "https://app.lobu.ai/api/v1";

const CONTEXTS_FILE = join(LOBU_CONFIG_DIR, "config.json");

export const DEFAULT_LOBU_MCP_URL = "https://lobu.ai/mcp";

/**
 * Org slugs are lowercase alphanumerics plus `-`/`_`, no leading/trailing
 * separator. Single source of truth for both the API client's slug guard and
 * `setActiveOrg` validation.
 */
export const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Validate an org slug against {@link ORG_SLUG_PATTERN}, throwing `Error` with a
 * consistent message when it doesn't match. Callers that need a typed error
 * (e.g. `ApiClientError`) catch and rewrap.
 */
export function validateOrgSlug(slug: string): string {
  if (!ORG_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid organization slug "${slug}". Slugs may only contain alphanumeric characters, hyphens, and underscores.`
    );
  }
  return slug;
}

export interface LobuServerConfig {
  port?: number;
  host?: string;
  // Directory the lifecycle owner should `cd` into before spawning
  // `lobu run`. Used by per-worktree contexts so the menubar launches
  // the server against the worktree's source (hot-reload on the right
  // checkout). Absent → spawner uses its own cwd.
  cwd?: string;
  // "managed" → the Mac menubar (or another lifecycle owner) spawns
  // `lobu run` for this context. "external" → just connect; never
  // spawn or kill. Absent → infer at the lifecycle owner only.
  lifecycle?: "managed" | "external";
}

interface LobuContextEntry {
  url: string;
  activeOrg?: string;
  memoryUrl?: string;
  lifecycle?: "managed" | "external";
  cwd?: string;
}

interface LobuContextConfig {
  currentContext: string;
  contexts: Record<string, LobuContextEntry>;
}

export interface ResolvedContext {
  name: string;
  url: string;
  source: "default" | "config" | "env";
}

interface StoredContextEntry {
  url?: unknown;
  apiUrl?: unknown;
  activeOrg?: unknown;
  memoryUrl?: unknown;
  lifecycle?: unknown;
  cwd?: unknown;
  server?: unknown;
}

interface StoredContextConfig {
  currentContext?: string;
  contexts?: Record<string, StoredContextEntry>;
}

export async function loadContextConfig(): Promise<LobuContextConfig> {
  try {
    const raw = await readFile(CONTEXTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoredContextConfig;
    return normalizeContextConfig(parsed);
  } catch {
    return normalizeContextConfig({});
  }
}

async function saveContextConfig(config: LobuContextConfig): Promise<void> {
  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(CONTEXTS_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export async function getCurrentContextName(): Promise<string> {
  const envContext = process.env.LOBU_CONTEXT?.trim();
  if (envContext) {
    return envContext;
  }

  const config = await loadContextConfig();
  return config.currentContext;
}

export async function getActiveOrg(
  contextName?: string
): Promise<string | undefined> {
  const envOrg = process.env.LOBU_ORG?.trim();
  if (envOrg) return envOrg;

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  return config.contexts[name]?.activeOrg;
}

export async function getMemoryUrl(contextName?: string): Promise<string> {
  const envUrl = process.env.LOBU_MEMORY_URL?.trim();
  if (envUrl) return normalizeApiUrl(envUrl);

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  return normalizeApiUrl(defaultMemoryUrlForContext(config.contexts[name]));
}

export async function setActiveOrg(
  orgSlug: string,
  contextName?: string
): Promise<LobuContextConfig> {
  const trimmed = orgSlug.trim();
  if (!trimmed) {
    throw new Error("Organization slug cannot be empty.");
  }
  validateOrgSlug(trimmed);

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  const context = config.contexts[name];
  if (!context) {
    throw new Error(`Unknown context "${name}".`);
  }

  context.activeOrg = trimmed;
  await saveContextConfig(config);
  return config;
}

export async function setMemoryUrl(
  memoryUrl: string,
  contextName?: string
): Promise<LobuContextConfig> {
  const trimmed = memoryUrl.trim();
  if (!trimmed) {
    throw new Error("Memory URL cannot be empty.");
  }

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  const context = config.contexts[name];
  if (!context) {
    throw new Error(`Unknown context "${name}".`);
  }

  context.memoryUrl = normalizeAndValidateApiUrl(trimmed);
  await saveContextConfig(config);
  return config;
}

export async function resolveContext(
  preferredContext?: string
): Promise<ResolvedContext> {
  const envApiUrl = process.env.LOBU_API_URL?.trim();
  const requestedContext =
    preferredContext?.trim() || process.env.LOBU_CONTEXT?.trim();

  if (envApiUrl) {
    return {
      name: requestedContext || (await getCurrentContextName()),
      url: normalizeApiUrl(envApiUrl),
      source: "env",
    };
  }

  const config = await loadContextConfig();
  const contextName = requestedContext || config.currentContext;
  const context = config.contexts[contextName];
  if (context) {
    return contextToResolvedContext(contextName, context);
  }

  throw new Error(
    `Unknown context "${contextName}". Run \`lobu context list\` to see configured contexts.`
  );
}

export async function addContext(
  name: string,
  url: string,
  server?: LobuServerConfig
): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }
  if (trimmedName === DEFAULT_CONTEXT_NAME) {
    throw new Error(
      `Cannot overwrite the default context "${trimmedName}". Pick a different name.`
    );
  }

  const config = await loadContextConfig();
  const previous = config.contexts[trimmedName];
  // Re-registering a running named context must not erase lifecycle ownership.
  // Org and memory targeting are still reset by the refreshed registration.
  const entry: LobuContextEntry = {
    url: normalizeAndValidateApiUrl(url),
    ...(previous?.lifecycle ? { lifecycle: previous.lifecycle } : {}),
    ...(previous?.cwd ? { cwd: previous.cwd } : {}),
  };
  const lifecycle = normalizeLifecycle(server?.lifecycle);
  const cwd = server?.cwd?.trim();
  // `cwd` only takes effect for managed contexts — getServerConfig() drops
  // everything else. Persisting it on a non-managed context would be a silent
  // no-op, so reject the combination instead of saving dead config.
  if (cwd && lifecycle !== "managed") {
    throw new Error("`cwd` can only be set on managed contexts.");
  }
  if (lifecycle) entry.lifecycle = lifecycle;
  if (entry.lifecycle !== "managed") delete entry.cwd;
  if (cwd) entry.cwd = cwd;

  config.contexts[trimmedName] = entry;
  await saveContextConfig(config);
  return config;
}

export async function removeContext(name: string): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }

  const config = await loadContextConfig();
  if (!config.contexts[trimmedName]) {
    // Idempotent: removing a non-existent context is a no-op.
    return config;
  }
  if (trimmedName === DEFAULT_CONTEXT_NAME) {
    throw new Error(`Cannot remove the default context "${trimmedName}".`);
  }

  delete config.contexts[trimmedName];
  if (config.currentContext === trimmedName) {
    config.currentContext = DEFAULT_CONTEXT_NAME;
  }
  await saveContextConfig(config);
  return config;
}

export async function setCurrentContext(
  name: string
): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }

  const config = await loadContextConfig();
  if (!config.contexts[trimmedName]) {
    throw new Error(
      `Unknown context "${trimmedName}". Run \`lobu context add ${trimmedName} --url <url>\` first.`
    );
  }

  config.currentContext = trimmedName;
  await saveContextConfig(config);
  return config;
}

function normalizeContextConfig(raw: StoredContextConfig): LobuContextConfig {
  const contexts: Record<string, LobuContextEntry> = {
    [DEFAULT_CONTEXT_NAME]: { url: DEFAULT_CONTEXT_URL },
  };

  for (const [name, value] of Object.entries(raw.contexts ?? {})) {
    const normalized = normalizeContextEntry(value);
    if (normalized) contexts[name] = normalized;
  }

  const currentContext =
    raw.currentContext && contexts[raw.currentContext]
      ? raw.currentContext
      : DEFAULT_CONTEXT_NAME;

  return {
    currentContext,
    contexts,
  };
}

function normalizeContextEntry(
  raw: StoredContextEntry
): LobuContextEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const legacyServer = normalizeLegacyServerConfig(raw.server);
  const rawUrl = firstString(raw.url, raw.apiUrl);
  if (!rawUrl) return undefined;

  // Reject hand-edited / malformed stored URLs (e.g. "localhost:4111" with no
  // scheme) instead of letting them survive normalization. Every write path
  // already validates, so a stored entry that fails validation is corrupt —
  // dropping it keeps the invariant that resolveContext() returns a usable
  // endpoint.
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeAndValidateApiUrl(rawUrl);
  } catch {
    return undefined;
  }

  const entry: LobuContextEntry = { url: normalizedUrl };
  const activeOrg = normalizeString(raw.activeOrg);
  if (activeOrg) entry.activeOrg = activeOrg;
  const memoryUrl = normalizeString(raw.memoryUrl);
  if (memoryUrl) entry.memoryUrl = memoryUrl;
  const lifecycle = normalizeLifecycle(raw.lifecycle) ?? legacyServer.lifecycle;
  if (lifecycle) entry.lifecycle = lifecycle;
  const cwd = normalizeString(raw.cwd) ?? legacyServer.cwd;
  if (cwd) entry.cwd = cwd;

  return entry;
}

function normalizeLegacyServerConfig(
  raw: unknown
): Pick<LobuServerConfig, "cwd" | "lifecycle"> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Pick<LobuServerConfig, "cwd" | "lifecycle"> = {};
  const cwd = normalizeString(src.cwd);
  if (cwd) out.cwd = cwd;
  const lifecycle = normalizeLifecycle(src.lifecycle);
  if (lifecycle) out.lifecycle = lifecycle;
  return out;
}

function normalizeLifecycle(
  value: unknown
): "managed" | "external" | undefined {
  return value === "managed" || value === "external" ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export async function getServerConfig(
  contextName?: string
): Promise<LobuServerConfig | undefined> {
  const config = await loadContextConfig();
  // Honor LOBU_CONTEXT the same way resolveContext() does — without this,
  // a caller that sets the env var to pin a context (e.g. the Mac menubar
  // spawning `lobu run` with LOBU_CONTEXT=local) gets the server settings
  // from `currentContext` instead.
  const name =
    contextName?.trim() ||
    process.env.LOBU_CONTEXT?.trim() ||
    config.currentContext;
  const context = config.contexts[name];
  if (!context || context.lifecycle !== "managed") return undefined;

  return deriveManagedServerConfig(context);
}

function deriveManagedServerConfig(
  context: LobuContextEntry
): LobuServerConfig | undefined {
  const out: LobuServerConfig = { lifecycle: context.lifecycle };
  if (context.cwd) out.cwd = context.cwd;

  try {
    const parsed = new URL(context.url);
    const port = derivePort(parsed);
    if (port && Number.isInteger(port) && port > 0 && port <= 65535) {
      out.port = port;
    }
    const host = stripIpv6Brackets(parsed.hostname);
    if (host) {
      out.host = host;
    }
  } catch {
    // URL validation happens when contexts are saved/loaded; ignore here so a
    // hand-edited malformed config does not make the caller crash.
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Resolve the effective port for a parsed context URL. An explicit `:port`
 * wins; otherwise fall back to the protocol default (80 for http, 443 for
 * https) so callers that bind from this struct don't drift from a context URL
 * like `http://localhost/api/v1` that already implies a port.
 */
function derivePort(parsed: URL): number | undefined {
  if (parsed.port) return Number.parseInt(parsed.port, 10);
  if (parsed.protocol === "http:") return 80;
  if (parsed.protocol === "https:") return 443;
  return undefined;
}

/**
 * `new URL("http://[::1]:8787").hostname` returns `[::1]` with brackets, which
 * Node's `server.listen({ host })` rejects. Strip them before exporting HOST.
 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function normalizeAndValidateApiUrl(apiUrl: string): string {
  const normalized = normalizeApiUrl(apiUrl.trim());
  if (!normalized) {
    throw new Error("URL cannot be empty.");
  }

  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol || !parsed.host) {
      throw new Error("Missing protocol or host");
    }
  } catch {
    throw new Error(`Invalid URL: ${apiUrl}`);
  }

  return normalized;
}

function normalizeApiUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === url.length ? url : url.slice(0, end);
}

/**
 * Reduce a context's API URL to the gateway ORIGIN the worker API is mounted on.
 *
 * Context URLs carry the SDK path (`https://app.lobu.ai/api/v1`) but
 * `/api/workers/*` is mounted at the app root, so passing the context URL
 * straight through builds `/api/v1/api/workers/poll` and every device call
 * 404s. Only production contexts carry that path — a local context is a bare
 * `http://localhost:<port>` — which is why the mismatch is invisible in dev.
 * The Owletto Mac app already reduces the same way before polling
 * (`LobuContextIdentity.origin(of:)`).
 */
export function apiUrlToGatewayOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // Not a parseable absolute URL — hand it back trimmed and let the caller's
    // first request fail with the address the user actually configured.
    return normalizeApiUrl(url);
  }
}

/**
 * Origin that serves the tool API (`/api/{org}/{tool}`) behind an MCP URL.
 *
 * The hosted MCP resource `https://lobu.ai/mcp` is an edge proxy for `/mcp`
 * only (it is the RFC 8707 resource identifier, deliberately not the gateway
 * host), so a tool call built from its origin answers 405. The hosted gateway
 * serves the tool API behind it; every other installation serves both from
 * one origin.
 */
export function toolApiOriginForMcpUrl(mcpUrl: string): string {
  const origin = apiUrlToGatewayOrigin(mcpUrl);
  return origin === apiUrlToGatewayOrigin(DEFAULT_LOBU_MCP_URL)
    ? apiUrlToGatewayOrigin(DEFAULT_CONTEXT_URL)
    : origin;
}

export async function findContextByUrl(
  apiUrl: string
): Promise<ResolvedContext | undefined> {
  const config = await loadContextConfig();
  const normalizedSearch = normalizeApiUrl(apiUrl);

  for (const [name, context] of Object.entries(config.contexts)) {
    if (normalizeApiUrl(context.url) === normalizedSearch) {
      return contextToResolvedContext(name, context);
    }
  }

  return undefined;
}

/**
 * Find the named context whose API URL belongs to the same gateway origin.
 *
 * Device endpoints live at the origin while a hosted context carries the
 * `/api/v1` SDK suffix — the built-in `lobu` context included. Matching those
 * two spellings is safe because an OAuth bearer never crosses the URL origin
 * boundary. The current context wins ties; otherwise user-named contexts win
 * over the always-present built-in context, because that is normally where the
 * installation login is stored.
 */
export async function findContextByOrigin(
  apiUrl: string
): Promise<ResolvedContext | undefined> {
  const config = await loadContextConfig();
  let searchOrigin: string;
  try {
    searchOrigin = new URL(apiUrl).origin;
  } catch {
    return undefined;
  }

  // The built-in "lobu" context is always materialized at the hosted origin, so
  // it would shadow a context the user named themselves for that same
  // installation — and it is not normally where their credentials live. Try
  // the current context first, then user-named contexts, and leave the built-in
  // fallback last. This also covers `currentContext=local` with a logged-in
  // `prod` context targeting the hosted origin.
  const entries = Object.entries(config.contexts);
  const priority = (name: string): number => {
    if (name === config.currentContext) return 0;
    if (name === DEFAULT_CONTEXT_NAME) return 2;
    return 1;
  };
  entries.sort(([a], [b]) => priority(a) - priority(b));

  for (const [name, context] of entries) {
    if (new URL(context.url).origin === searchOrigin) {
      return contextToResolvedContext(name, context);
    }
  }

  return undefined;
}

export async function findContextByMemoryUrl(
  memoryUrl: string
): Promise<ResolvedContext | undefined> {
  const config = await loadContextConfig();
  const normalizedSearch = normalizeMemoryBaseUrl(memoryUrl);

  for (const [name, context] of Object.entries(config.contexts)) {
    const candidate = normalizeMemoryBaseUrl(
      defaultMemoryUrlForContext(context)
    );
    if (candidate === normalizedSearch) {
      return contextToResolvedContext(name, context);
    }
  }

  return undefined;
}

function defaultMemoryUrlForContext(
  context: LobuContextEntry | undefined
): string {
  if (context?.memoryUrl) return context.memoryUrl;
  if (context && isLoopbackContextUrl(context.url)) {
    const url = new URL(context.url);
    url.pathname = "/mcp";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  }
  return DEFAULT_LOBU_MCP_URL;
}

function isLoopbackContextUrl(input: string): boolean {
  try {
    const { hostname } = new URL(input);
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function contextToResolvedContext(
  name: string,
  context: LobuContextEntry
): ResolvedContext {
  return {
    name,
    url: normalizeApiUrl(context.url),
    source: name === DEFAULT_CONTEXT_NAME ? "default" : "config",
  };
}

function normalizeMemoryBaseUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    url.search = "";
    // Compare at the *base* MCP path (`/mcp`) so a context whose memoryUrl is
    // org-scoped (`/mcp/<slug>`) still matches a bare-base search and vice
    // versa — mirrors `baseMcpUrl()` in memory-auth.ts.
    url.pathname = "/mcp";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalizeApiUrl(input);
  }
}
