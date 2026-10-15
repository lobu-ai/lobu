import { AsyncLocalStorage } from "node:async_hooks";
import { isAPIError } from "better-auth/api";
import postgres from "postgres";
import logger from "../utils/logger";

/**
 * Better Auth catches an endpoint's unexpected error itself and answers a bare
 * 500; by default it only prints the error to the console, without the request
 * it belongs to. `onAPIError.onError` is its hook for that error, but it is
 * handed no request, and the instance is cached across requests — so the
 * request each handler call serves is carried here instead.
 *
 * Only the method and pathname are kept, with password-reset path tokens
 * redacted. Query strings, headers and bodies are not included in the scope.
 */
const authRequest = new AsyncLocalStorage<{ method: string; path: string }>();

// Better Auth's one endpoint that carries a credential in the path itself is
// `/reset-password/:token`.
function redactPathToken(pathname: string): string {
	const segments = pathname.split("/");
	const at = segments.indexOf("reset-password");
	if (at >= 0 && at + 1 < segments.length) segments[at + 1] = "[REDACTED]";
	return segments.join("/");
}

export function withAuthRequestScope(
	handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
	return (request) =>
		authRequest.run(
			{
				method: request.method,
				path: redactPathToken(new URL(request.url).pathname),
			},
			() => handler(request),
		);
}

/**
 * `onAPIError.onError` for the Better Auth instance. A deliberate APIError
 * (4xx, redirects) is the endpoint's answer, not a server failure. Better
 * Auth's predicate also recognizes Better Call's validation errors.
 */
export function logUnhandledAuthEndpointError(error: unknown): void {
	if (isAPIError(error) && error.statusCode < 500) {
		return;
	}
	logger.error(
		{
			err: error,
			pg_code: error instanceof postgres.PostgresError ? error.code : undefined,
			...authRequest.getStore(),
		},
		"Unhandled auth endpoint error",
	);
}
