import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import logger from "../utils/logger";

/**
 * `auth.observed`: one structured log line per successful Better Auth sign-in,
 * where a sign-up is a sign-in whose user row the same request created.
 * `cf_ray` joins the line to the Cloudflare request log (Logpush), which
 * stores the ray id without its `-COLO` suffix.
 *
 * The line carries ids only: never an email, name, IP, user agent, token or
 * cookie.
 *
 * Better Auth hands its database hooks no request of their own, so the request
 * each handler call serves is carried here, as in `endpoint-error-log.ts`.
 */
interface SignInScope {
	cfRay: string | null;
	/** Set by `user.create.after` when this request created the user. */
	createdUser: { id: string; organizationId: string | null } | null;
}

const signInScope = new AsyncLocalStorage<SignInScope>();

/** `a53b9d57c926253b-LHR` → `a53b9d57c926253b`. */
function rayId(header: string | null): string | null {
	const id = header?.split("-", 1)[0]?.trim();
	return id || null;
}

export function withSignInScope(
	handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
	return (request) =>
		signInScope.run(
			{ cfRay: rayId(request.headers.get("cf-ray")), createdUser: null },
			() => handler(request),
		);
}

/** Called from `user.create.after`, with the personal org it provisioned. */
export function noteUserCreated(
	userId: string,
	organizationId: string | null,
): void {
	const scope = signInScope.getStore();
	if (scope) scope.createdUser = { id: userId, organizationId };
}

/** The slice of Better Auth's endpoint context a sign-in method comes from. */
type HookEndpointContext = {
	path?: string;
	params?: Record<string, unknown>;
} | null;

function signInMethod(context: HookEndpointContext): string | null {
	// An OAuth callback names its provider in the route (`/callback/:id`);
	// every other sign-in endpoint is its own method.
	const provider = context?.params?.id ?? context?.params?.providerId;
	if (typeof provider === "string" && provider) return provider;
	return context?.path || null;
}

/**
 * `session.create.after`. Never throws: a log line must not fail or slow a
 * sign-in.
 */
export function logAuthObserved(
	session: { userId: string; activeOrganizationId?: string | null },
	context: HookEndpointContext,
): void {
	try {
		const scope = signInScope.getStore();
		// Sessions minted outside the Better Auth handler (`/exchange-token`,
		// `/extension-session`, `/local-init`) stand in for a credential that
		// was already verified, so they are not sign-ins.
		if (!scope) return;
		const signedUp = scope.createdUser?.id === session.userId;
		logger.info(
			{
				event: "auth.observed",
				auth_event_id: randomUUID(),
				kind: signedUp ? "sign_up" : "sign_in",
				user_id: session.userId,
				// A sign-in resolves no org without a query; only a sign-up has
				// just provisioned one.
				org_id:
					session.activeOrganizationId ??
					(signedUp ? scope.createdUser?.organizationId : null) ??
					null,
				method: signInMethod(context),
				cf_ray: scope.cfRay,
			},
			"auth.observed",
		);
	} catch (error) {
		logger.debug({ err: error }, "auth.observed could not be logged");
	}
}
