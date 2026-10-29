/** Keep registered generic OAuth URLs working across Better Auth's 1.7 route merge. */
export function withGenericOAuthRoutes(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/auth/sign-in/oauth2" || path === "/api/auth/oauth2/link") {
      if (request.method !== "POST") return handler(request);
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await request.clone().json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return Response.json({ message: "Invalid JSON body" }, { status: 400 });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return Response.json({ message: "Invalid JSON body" }, { status: 400 });
      }
      url.pathname = path === "/api/auth/sign-in/oauth2"
        ? "/api/auth/sign-in/social"
        : "/api/auth/link-social";
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      return handler(new Request(url, {
        method: "POST", headers,
        body: JSON.stringify({ ...body, provider: body.providerId }),
      }));
    }
    if (path.startsWith("/api/auth/oauth2/callback/")) {
      url.pathname = path.replace("/api/auth/oauth2/callback/", "/api/auth/callback/");
      return handler(new Request(url, request));
    }
    return handler(request);
  };
}
