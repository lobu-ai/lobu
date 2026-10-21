import {
  findContextByMemoryUrl,
  getActiveOrg,
  getMemoryUrl,
  getToken,
  resolveContext,
  setActiveOrg as setContextActiveOrg,
  setMemoryUrl as setContextMemoryUrl,
} from "../../../internal/index.js";

export interface MemorySession {
  mcpUrl: string;
  org?: string;
  tokenType?: string;
  updatedAt?: string;
}

export function normalizeMcpUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/mcp";
  } else if (
    !url.pathname.startsWith("/mcp") &&
    !url.pathname.includes("/mcp/")
  ) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp`;
  }
  return url.toString().replace(/\/+$/, "");
}

/** Strip org suffix from an MCP URL for server-level defaults: /mcp/acme → /mcp */
export function baseMcpUrl(input: string): string {
  const url = new URL(normalizeMcpUrl(input));
  url.hash = "";
  url.search = "";
  url.pathname = "/mcp";
  return url.toString().replace(/\/+$/, "");
}

/** Build an org-scoped MCP URL: `https://host/mcp/{org}` */
export function mcpUrlForOrg(baseUrl: string, org: string): string {
  const url = new URL(normalizeMcpUrl(baseUrl));
  url.pathname = `/mcp/${org}`;
  return url.toString().replace(/\/+$/, "");
}

/** Extract org slug from a /mcp/{org} URL, or null if bare /mcp */
export function orgFromMcpUrl(mcpUrl: string): string | null {
  try {
    const { pathname } = new URL(mcpUrl);
    const match = pathname.match(/^\/mcp\/([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function setActiveOrg(orgSlug: string, context?: string) {
  await setContextActiveOrg(orgSlug, context);
}

export async function setActiveMcpUrl(mcpUrl: string, context?: string) {
  await setContextMemoryUrl(mcpUrl, context);
}

export async function getActiveSession(context?: string): Promise<{
  session: MemorySession | null;
  key: string | null;
}> {
  const { url: key, org } = await resolveToolMcpUrl({ context });
  return {
    session: {
      mcpUrl: key,
      org,
      tokenType: "Bearer",
      updatedAt: new Date().toISOString(),
    },
    key,
  };
}

/**
 * Resolve which server URL to use.
 * Priority: explicit url arg > LOBU_MEMORY_URL > context preference > cloud default.
 */
export async function resolveServerUrl(
  urlFlag?: string,
  context?: string
): Promise<string> {
  if (urlFlag) return normalizeMcpUrl(urlFlag);
  return normalizeMcpUrl(await getMemoryUrl(context));
}

/**
 * True when the process was handed a self-contained runtime credential: an
 * explicit bearer plus the MCP URL it is valid for (a device Automation run's
 * worker access). That URL already names the org, and a worker token is only
 * accepted on MCP routes, so callers must dispatch to it as-is.
 */
export function hasRuntimeMcpAccess(): boolean {
  return Boolean(
    process.env.LOBU_API_TOKEN?.trim() && process.env.LOBU_MEMORY_URL?.trim()
  );
}

/**
 * Resolve which org to use.
 * Priority: explicit org arg > LOBU_MEMORY_ORG > session > context preference.
 */
export async function resolveOrg(
  orgFlag?: string,
  session?: MemorySession | null,
  context?: string
): Promise<string | undefined> {
  if (orgFlag) return orgFlag;
  if (process.env.LOBU_MEMORY_ORG) return process.env.LOBU_MEMORY_ORG;
  // Explicit runtime bearer + MCP URL is self-contained; do not rewrite a mounted endpoint with ambient org state.
  if (hasRuntimeMcpAccess()) return undefined;
  if (session?.org) return session.org;
  return getActiveOrg(context);
}

/**
 * The MCP URL a tool call goes to: the server URL scoped to the resolved org,
 * or the server URL as given when no org resolves (a runtime credential's URL
 * already names its org; see `resolveOrg`).
 */
export async function resolveToolMcpUrl(options: {
  url?: string;
  org?: string;
  context?: string;
}): Promise<{ url: string; org: string | undefined }> {
  const org = await resolveOrg(options.org, undefined, options.context);
  const base = await resolveServerUrl(options.url, options.context);
  return { url: org ? mcpUrlForOrg(base, org) : base, org };
}

/**
 * Resolve a usable bearer token from top-level `lobu login` credentials.
 */
export async function getUsableToken(
  mcpUrl?: string,
  contextName?: string
): Promise<{
  token: string;
  session: MemorySession;
  contextName: string;
} | null> {
  let target = await resolveContext(contextName);
  const resolvedUrl = mcpUrl
    ? normalizeMcpUrl(mcpUrl)
    : await resolveServerUrl(undefined, target.name);

  if (mcpUrl && !contextName) {
    const requestedBase = baseMcpUrl(resolvedUrl);
    const currentContextUrl = await resolveServerUrl(undefined, target.name);
    const currentContextBase = baseMcpUrl(currentContextUrl);

    // Keep the active context when it already targets the requested memory
    // server. Multiple contexts can legitimately share the default memory URL,
    // and blindly picking the first matching context can select credentials for
    // an unrelated context (or one with no login), causing unauthenticated MCP
    // requests.
    if (currentContextBase !== requestedBase) {
      const matched = await findContextByMemoryUrl(resolvedUrl);
      if (matched) target = matched;
    }
  }

  if (mcpUrl && !process.env.LOBU_API_TOKEN) {
    const contextUrl = await resolveServerUrl(undefined, target.name);
    const requestedBase = baseMcpUrl(resolvedUrl);
    const contextBase = baseMcpUrl(contextUrl);
    if (requestedBase !== contextBase) {
      throw new Error(
        `Refusing to send stored context credentials for "${target.name}" to ${requestedBase}. Configure that context's memory URL or set LOBU_API_TOKEN explicitly.`
      );
    }
  }

  const token = await getToken(target.name);
  if (!token) return null;

  const org =
    orgFromMcpUrl(resolvedUrl) ??
    (await resolveOrg(undefined, undefined, target.name));
  const sessionUrl =
    org && !orgFromMcpUrl(resolvedUrl)
      ? mcpUrlForOrg(resolvedUrl, org)
      : resolvedUrl;

  return {
    token,
    contextName: target.name,
    session: {
      mcpUrl: sessionUrl,
      org,
      tokenType: "Bearer",
      updatedAt: new Date().toISOString(),
    },
  };
}
