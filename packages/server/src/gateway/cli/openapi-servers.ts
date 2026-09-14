/**
 * Base URLs for the published OpenAPI document.
 *
 * The same gateway app is served from two different bases:
 *   - standalone (`lobu` CLI gateway): at the origin, so `/api/v1/agents`.
 *   - embedded in the server: `server-lifecycle.ts` mounts it at `/lobu`, so
 *     `/lobu/api/v1/agents`. Every deployment runs this layout — see
 *     `packages/cli/src/internal/gateway-url.ts`, whose `agentApiBase()`
 *     appends the same prefix.
 *
 * The merged document ALSO carries the org-scoped dispatch surface
 * (`POST /api/{orgSlug}/{tool}`), and that half is served by the main app at
 * the ORIGIN in both topologies. So one document describes two bases, and a
 * single hardcoded `servers` entry is wrong for at least one of them: it is
 * what made the published quick-start advertise a bare `/api/v1/agents` that
 * falls through to `/api/:orgSlug/*` and answers `Organization 'v1' not found`.
 *
 * Both bases are therefore derived from the request that fetched the document,
 * and emitted RELATIVE. OpenAPI 3.1 resolves a relative server URL against the
 * document's own retrieval URL, so one byte-identical document is correct on
 * every host — it names no deployment origin, developer machine, or tenant.
 */

/** Where the merged OpenAPI document is served, relative to the gateway app. */
export const OPENAPI_DOC_PATH = "/api/docs/openapi.json";

/** Where the Scalar reference UI is served, relative to the gateway app. */
export const OPENAPI_REFERENCE_PATH = "/api/docs";

/**
 * The prefix the gateway app is mounted under, read off the request path that
 * reached `servedPath`: `""` at the origin, `"/lobu"` when embedded.
 */
export function gatewayMountPrefix(
	requestPath: string,
	servedPath: string,
): string {
	return requestPath.endsWith(servedPath)
		? requestPath.slice(0, requestPath.length - servedPath.length)
		: "";
}

/** A mount prefix as an OpenAPI `servers` URL (`""` has to be spelled `"/"`). */
export function serverUrlForMountPrefix(prefix: string): string {
	return prefix === "" ? "/" : prefix;
}

/**
 * Attach a path-item-level `servers` override to every path in `paths`.
 *
 * Used for the gateway's own routes, which live under the gateway mount rather
 * than at the origin the root `servers` entry describes.
 */
export function withPathServers(
	paths: Record<string, unknown>,
	url: string,
	description: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [path, item] of Object.entries(paths)) {
		out[path] = {
			...(item as Record<string, unknown>),
			servers: [{ url, description }],
		};
	}
	return out;
}
