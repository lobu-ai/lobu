import { HTTPException } from "hono/http-exception";
import { getDb } from "../db/client";

const CONTEXT_KEY = "lobuOAuthContext";

function invalidState(): never {
  throw new HTTPException(400, {
    res: Response.json(
      { message: "Invalid OAuth state. Restart sign-in." },
      { status: 400, headers: { "cache-control": "no-store" } },
    ),
  });
}

/** Stamp server-selected scope into Better Auth's existing opaque state payload. */
export function bindOAuthOrganization(
  verification: { identifier: string; value: string },
  organizationId: string | null,
  context: { path?: string; body?: Record<string, unknown> } | null,
): string {
  const path = context?.path;
  const provider = path === "/sign-in/social" || path === "/link-social"
    ? context?.body?.provider
    : path === "/sign-in/oauth2" || path === "/oauth2/link"
      ? context?.body?.providerId
      : undefined;
  if (!provider || typeof provider !== "string") return verification.value;

  const state = JSON.parse(verification.value);
  if (!state || typeof state !== "object" || state.oauthState !== verification.identifier) {
    throw new Error("OAuth verification payload is missing its state binding");
  }
  // Overwrite client additionalData, including when the selected scope is global.
  return JSON.stringify({ ...state, [CONTEXT_KEY]: { organizationId, provider } });
}

/**
 * undefined means this is not an OAuth callback; null is an explicitly global
 * flow. Callback scope never comes from its Referer or destination URL.
 */
export async function resolveOAuthCallbackOrganization(
  request?: Request,
): Promise<string | null | undefined> {
  if (!request) return undefined;
  const url = new URL(request.url);
  const match = /^\/api\/auth\/(?:oauth2\/)?callback\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return undefined;

  let provider: string;
  try { provider = decodeURIComponent(match[1]); } catch { return invalidState(); }
  // Better Auth's built-in POST callback redirects to GET, with query overriding body.
  const states = url.searchParams.getAll("state");
  if (states.length > 1) return invalidState();
  let state: unknown = states[0];
  if (state === undefined && request.method === "POST") {
    try {
      const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("application/json")) {
        const body = await request.clone().json() as Record<string, unknown> | null;
        state = body?.state;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const values = (await request.clone().formData()).getAll("state");
        if (values.length !== 1) return invalidState();
        state = values[0];
      }
    } catch { return invalidState(); }
  }
  if (typeof state !== "string" || !state) return invalidState();

  const sql = getDb();
  const [verification] = await sql<{ value: string }>`
    SELECT value FROM verification
    WHERE identifier = ${state} AND "expiresAt" > NOW()
    ORDER BY "createdAt" DESC LIMIT 1
  `;
  if (!verification) return invalidState();
  let payload;
  try { payload = JSON.parse(verification.value); } catch { return invalidState(); }
  const context = payload?.[CONTEXT_KEY];
  if (
    !payload || payload.oauthState !== state ||
    typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= Date.now() ||
    !context || context.provider !== provider ||
    !(context.organizationId === null || (typeof context.organizationId === "string" && context.organizationId))
  ) return invalidState();

  if (context.organizationId !== null) {
    const [org] = await sql`SELECT id FROM organization WHERE id = ${context.organizationId} LIMIT 1`;
    if (!org) return invalidState();
  }
  // Do not consume state here. Better Auth still verifies the signed state cookie
  // and consumes the verification before exchanging the authorization code.
  return context.organizationId;
}
