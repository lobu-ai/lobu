import { ApiError } from "../commands/memory/_lib/errors.js";
import {
  findContextByUrl,
  getActiveOrg,
  resolveContext,
  type ResolvedContext,
  validateOrgSlug as validateOrgSlugShared,
} from "./context.js";
import { getToken, loadCredentials } from "./credentials.js";
import { extractApiError, fetchWithRetry, parseJsonResponse } from "./http.js";

interface ApiClientOptions {
  context?: string;
  org?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResolvedApiClient {
  client: ApiClient;
  contextName: string;
  apiBaseUrl: string;
  orgSlug: string;
  token: string;
}

interface OrganizationInfo {
  slug: string;
  name?: string;
  /** True for the user's personal org (server marks it via `personal_org_slug`). */
  personal?: boolean;
}

/** HTTP verbs the CLI's REST clients issue. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestWithStatusOptions {
  headers?: Record<string, string>;
  okStatuses?: number[];
  /** Send `Accept: application/json` (default). Off matches the apply client. */
  sendAccept?: boolean;
  /**
   * Always send `Content-Type: application/json` even with no body. Default
   * sends it only when a body is present.
   */
  alwaysJsonContentType?: boolean;
}

export class ApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Extra headers sent on EVERY request (e.g. `x-lobu-apply-id`). */
    private readonly extraHeaders: Record<string, string> = {}
  ) {}

  /**
   * Single HTTP chokepoint: fetch (with retry) → parse JSON → throw `ApiError`
   * on a non-ok / non-allowed status. Returns the response status alongside the
   * parsed body so callers that branch on status (e.g. `lobu apply`'s 404/409
   * handling) don't reimplement the fetch/parse/error pipeline.
   */
  async requestWithStatus<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options: RequestWithStatusOptions = {}
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const url = path.startsWith("http") ? path : `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      ...options.headers,
      Authorization: `Bearer ${this.token}`,
    };
    if (options.sendAccept !== false) headers.Accept = "application/json";
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    } else if (options.alwaysJsonContentType) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetchWithRetry(url, init, {
      fetchImpl: this.fetchImpl,
    });
    const parsed = await parseJsonResponse(response, url, (message) => {
      throw new ApiError(message, response.status);
    });
    const okStatuses = options.okStatuses ?? [200, 201, 204];
    if (!response.ok || !okStatuses.includes(response.status)) {
      const { message, code } = extractApiError(
        parsed,
        response.status,
        response.statusText
      );
      throw new ApiError(
        `${method} ${path} failed: ${message}`,
        response.status,
        code
      );
    }
    return {
      status: response.status,
      body: parsed as T,
      headers: response.headers,
    };
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options: { okStatuses?: number[] } = {}
  ): Promise<T> {
    const { body: parsed } = await this.requestWithStatus<T>(
      method,
      path,
      body,
      options
    );
    return parsed;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path, undefined, {
      okStatuses: [200, 204],
    });
  }
}

export async function resolveApiClient(
  options: ApiClientOptions = {}
): Promise<ResolvedApiClient> {
  const target = await resolveApiTarget(options);
  const apiBaseUrl = apiBaseFromContextUrl(target.url);
  const token = process.env.LOBU_API_TOKEN || (await getToken(target.name));

  if (!token) {
    throw new ApiError(
      `Not logged in to context "${target.name}". Run \`lobu login${options.context ? ` --context ${target.name}` : ""}\` first.`,
      401
    );
  }

  const orgSlug = await resolveOrgSlug({
    ...options,
    contextName: target.name,
    token,
    apiBaseUrl,
    useStoredUserInfoEndpoint: target.useStoredUserInfoEndpoint,
  });

  return {
    client: new ApiClient(apiBaseUrl, token, options.fetchImpl),
    contextName: target.name,
    apiBaseUrl,
    orgSlug,
    token,
  };
}

export async function listOrganizations(
  options: Pick<ApiClientOptions, "context" | "apiUrl" | "fetchImpl"> = {}
): Promise<OrganizationInfo[]> {
  const target = await resolveApiTarget(options);
  const token = process.env.LOBU_API_TOKEN || (await getToken(target.name));
  if (!token) {
    throw new ApiError(
      `Not logged in to context "${target.name}". Run \`lobu login${options.context ? ` --context ${target.name}` : ""}\` first.`,
      401
    );
  }
  return getOrganizationsFromUserInfo(
    target.name,
    token,
    apiBaseFromContextUrl(target.url),
    options.fetchImpl,
    { useStoredUserInfoEndpoint: target.useStoredUserInfoEndpoint }
  );
}

interface ResolvedApiTarget extends ResolvedContext {
  useStoredUserInfoEndpoint: boolean;
}

async function resolveApiTarget(
  options: Pick<ApiClientOptions, "context" | "apiUrl">
): Promise<ResolvedApiTarget> {
  const requested = await resolveContext(options.context);
  if (!options.apiUrl) {
    return { ...requested, useStoredUserInfoEndpoint: true };
  }

  const matched = await findContextByUrl(options.apiUrl);
  if (matched) {
    return { ...matched, useStoredUserInfoEndpoint: true };
  }

  const apiBaseUrl = apiBaseFromContextUrl(options.apiUrl);
  const contextApiBaseUrl = apiBaseFromContextUrl(requested.url);
  if (!process.env.LOBU_API_TOKEN && apiBaseUrl !== contextApiBaseUrl) {
    throw new ApiError(
      `Refusing to send stored context credentials for "${requested.name}" to ${apiBaseUrl}. Add a context for that URL or set LOBU_API_TOKEN explicitly.`
    );
  }

  return {
    ...requested,
    url: options.apiUrl,
    useStoredUserInfoEndpoint: apiBaseUrl === contextApiBaseUrl,
  };
}

export function apiBaseFromContextUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function resolveOrgSlug(
  options: ApiClientOptions & {
    contextName: string;
    token: string;
    apiBaseUrl: string;
    useStoredUserInfoEndpoint: boolean;
  }
): Promise<string> {
  const explicit = options.org?.trim() || process.env.LOBU_ORG?.trim();
  if (explicit) return validateOrgSlug(explicit);

  const active = await getActiveOrg(options.contextName);
  if (active) return validateOrgSlug(active);

  const organizations = await getOrganizationsFromUserInfo(
    options.contextName,
    options.token,
    options.apiBaseUrl,
    options.fetchImpl,
    { useStoredUserInfoEndpoint: options.useStoredUserInfoEndpoint }
  ).catch(() => []);

  if (organizations.length === 1) {
    return validateOrgSlug(organizations[0]!.slug);
  }

  if (organizations.length > 1) {
    throw new ApiError(
      `Multiple organizations are available (${organizations.map((org) => org.slug).join(", ")}). Run \`lobu org set <slug>\` or pass \`--org <slug>\`.`
    );
  }

  throw new ApiError(
    "No organization selected. Run `lobu org set <slug>` or pass `--org <slug>`."
  );
}

async function getOrganizationsFromUserInfo(
  contextName: string,
  token: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: { useStoredUserInfoEndpoint?: boolean } = {}
): Promise<OrganizationInfo[]> {
  const creds =
    options.useStoredUserInfoEndpoint === false
      ? null
      : await loadCredentials(contextName);
  const endpoint =
    creds?.oauth?.userinfoEndpoint ?? `${apiBaseUrl}/oauth/userinfo`;
  const response = await fetchWithRetry(
    endpoint,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    { fetchImpl }
  );
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data) return [];
  const orgs = Array.isArray(data.organizations) ? data.organizations : [];
  // The server exposes the personal-org slug both top-level and per-entry; use
  // whichever is present so device clients (Owletto Mac/Chrome) can target the
  // personal workspace regardless of the active org.
  const personalSlug =
    typeof data.personal_org_slug === "string" ? data.personal_org_slug : "";
  const result: OrganizationInfo[] = [];
  for (const entry of orgs) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const slug = typeof value.slug === "string" ? value.slug : "";
    if (!slug) continue;
    const isPersonal =
      value.personal === true || (personalSlug !== "" && slug === personalSlug);
    result.push({
      slug,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(isPersonal ? { personal: true } : {}),
    });
  }
  return result;
}

/**
 * Wrap the shared {@link validateOrgSlugShared} so the typed `ApiError`
 * (carrying the same human message) propagates instead of a bare `Error`.
 */
function validateOrgSlug(slug: string): string {
  try {
    return validateOrgSlugShared(slug);
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : String(err));
  }
}
