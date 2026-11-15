import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getAuthoritativeSessionFromCtx, isAPIError } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { parseUserOutput } from "better-auth/db";
import { twoFactor } from "better-auth/plugins";
import { authRateKey } from "./abuse-protection";
import { logAuthObserved } from "./auth-observed";
import { isTokenDerivedSession } from "./oauth/scopes";

const MANAGEMENT_PATHS = new Set([
	"/two-factor/enable", "/two-factor/disable", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri",
	"/passkey/generate-register-options", "/passkey/verify-registration", "/passkey/update-passkey", "/passkey/delete-passkey",
]);
const VERIFIED_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const FIRST_FACTOR_PATHS = new Set([
	"/sign-in/email", "/sign-in/username", "/sign-in/phone-number", "/phone-number/verify",
	"/passkey/verify-authentication", "/magic-link/verify",
]);
type AccountSecurityContext = { accountSecurityIncoming?: Awaited<ReturnType<typeof getAuthoritativeSessionFromCtx>> };

function isFirstFactorPath(path?: string): boolean {
	return !!path && (FIRST_FACTOR_PATHS.has(path) || path.startsWith("/callback/") || path.startsWith("/oauth2/callback/"));
}

/** A local return path only; never forward an OAuth provider's external URL. */
function localCallback(value: string | null, base: string): string {
	if (!value || /[\\\r\n]/.test(value)) return "/";
	try {
		const url = new URL(value, base);
		if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/") || url.pathname.startsWith("//")) return "/";
		return `${url.pathname}${url.search}${url.hash}`;
	} catch { return "/"; }
}

export function accountSecurity(): BetterAuthPlugin {
	const native = twoFactor({
		allowPasswordless: true,
		issuer: "Lobu", twoFactorCookieMaxAge: 600,
		accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
		backupCodeOptions: { amount: 10, storeBackupCodes: "encrypted" },
		totpOptions: { digits: 6, period: 30 },
	});
	const challenge = native.hooks.after[0]!;
	return {
		...native,
		init() {
			return { options: { databaseHooks: { session: { create: { before: async (session, ctx) => {
				const incoming = (ctx?.context as AccountSecurityContext | undefined)?.accountSecurityIncoming;
				if (!incoming || incoming.user.id !== session.userId || isFirstFactorPath(ctx?.path) || VERIFIED_PATHS.has(ctx?.path ?? "")) return;
				// Replacing a session is not authentication. Carry its original age
				// and credential provenance into every non-login replacement at insert.
				return { data: { ...session, createdAt: incoming.session.createdAt, userAgent: incoming.session.userAgent } };
			} } } } } };
		},
		hooks: {
			before: [{ matcher: () => true, handler: createAuthMiddleware(async (ctx) => {
				const incoming = await getAuthoritativeSessionFromCtx(ctx);
				(ctx.context as typeof ctx.context & AccountSecurityContext).accountSecurityIncoming = incoming;
				// No client, including a direct HTTP caller, may mint a bypass cookie.
				if (ctx.path?.startsWith("/two-factor/") && (ctx.body?.trustDevice || ctx.body?.disableSession)) {
					throw new APIError("BAD_REQUEST", { code: "INVALID_TWO_FACTOR_OPTIONS", message: "Remembered devices are not supported." });
				}
				if (ctx.path === "/two-factor/enable" && ctx.body?.method && ctx.body.method !== "totp") {
					throw new APIError("BAD_REQUEST", { code: "TOTP_ONLY", message: "Use an authenticator app." });
				}
				if (ctx.path === "/two-factor/verify-totp" && (typeof ctx.body?.code !== "string" || !/^\d{6}$/.test(ctx.body.code))) {
					throw new APIError("BAD_REQUEST", { code: "INVALID_CODE", message: "Enter a six-digit code." });
				}
				if (VERIFIED_PATHS.has(ctx.path ?? "") && !incoming) {
					const cookie = ctx.context.createAuthCookie("two_factor");
					const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
					const pending = identifier ? await ctx.context.internalAdapter.findVerificationValue(identifier) : null;
					// Native backup verification consumes a code before consuming the
					// challenge. Reject expiry first so an expired login cannot burn it.
					if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) {
						throw new APIError("UNAUTHORIZED", { code: "INVALID_TWO_FACTOR_COOKIE", message: "Sign-in expired. Start sign-in again." });
					}
				}
				const activatesEnrollment = ctx.path === "/two-factor/verify-totp" && incoming && !incoming.user.twoFactorEnabled;
				if (MANAGEMENT_PATHS.has(ctx.path ?? "") || activatesEnrollment) {
					if (!incoming) throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Sign in first." });
					if (isTokenDerivedSession(incoming.session)) throw new APIError("FORBIDDEN", { code: "HUMAN_SESSION_REQUIRED", message: "Sign in in your browser to manage account security." });
					if (Date.now() - new Date(incoming.session.createdAt).getTime() > 900_000) {
						throw new APIError("FORBIDDEN", { code: "SESSION_NOT_FRESH", message: "Sign out and sign in again to manage account security." });
					}
				}
				const trustCookie = ctx.context.createAuthCookie("trust_device").name;
				if (ctx.headers?.has("cookie")) {
					ctx.headers.set("cookie", ctx.headers.get("cookie")!.split(";").filter((part) => part.trim().split("=")[0] !== trustCookie).join(";"));
				}
			}) }],
			after: [{ matcher: () => true, handler: createAuthMiddleware(async (ctx) => {
				const incoming = (ctx.context as typeof ctx.context & AccountSecurityContext).accountSecurityIncoming;
				const created = ctx.context.newSession;
				const failed = isAPIError(ctx.context.returned) && ctx.context.returned.statusCode >= 400;
				if (failed) return;
				try {
					if (ctx.path === "/two-factor/verify-totp" && typeof ctx.body?.code === "string") {
						// Native verification accepts adjacent periods. Reserve the code across
						// challenges for its entire possible validity, atomically on Postgres.
						const user = created?.user ?? incoming?.user;
						if (user) {
							const identifier = authRateKey(ctx.context.secret, "totp-used", `${user.id}:${ctx.body.code}`);
							await ctx.context.adapter.deleteMany({ model: "verification", where: [
								{ field: "identifier", value: identifier }, { field: "expiresAt", operator: "lt", value: new Date() },
							] });
							const reserved = await ctx.context.internalAdapter.reserveVerificationValue({ identifier, value: user.id, expiresAt: new Date(Date.now() + 90_000) });
							if (!reserved) {
								throw new APIError("UNAUTHORIZED", { code: "INVALID_CODE", message: "This code has already been used. Wait for the next code." });
							}
						}
					}
					if (!created) return;
					if (ctx.path === "/two-factor/verify-totp" && incoming && !incoming.user.twoFactorEnabled && created.user.twoFactorEnabled) {
						// Sessions are database-backed; delete by owner without the
						// adapter's default listing limit, including expired rows.
						await ctx.context.adapter.deleteMany({ model: "session", where: [
							{ field: "userId", value: created.user.id }, { field: "token", operator: "ne", value: created.session.token },
						] });
					}
				} catch (error) {
					// A failed replay reservation or revocation must not leave the
					// freshly minted session usable through cookies or its token.
					if (created) {
						try { await ctx.context.internalAdapter.deleteSession(created.session.token); }
						finally { deleteSessionCookie(ctx, true); ctx.context.setNewSession(null); }
					}
					throw error;
				}
				const firstFactor = isFirstFactorPath(ctx.path);
				if (created.user.twoFactorEnabled && !VERIFIED_PATHS.has(ctx.path ?? "") &&
					(firstFactor || incoming?.user.id !== created.user.id)) {
					const returned = ctx.context.returned;
					const redirect = ctx.context.responseHeaders?.get("location") ?? (isAPIError(returned) ? new Headers(returned.headers).get("location") : null);
					// Middleware's declared result omits the returnHeaders envelope that
					// Better Call supplies at runtime; preserve its challenge cookies.
					const result = await challenge.handler({ ...ctx, returnHeaders: true }) as unknown as
						{ headers: Headers; response: { twoFactorRedirect: boolean; twoFactorMethods: string[] } };
					result.headers?.forEach((value, name) => {
						if (name.toLowerCase() === "set-cookie") ctx.responseHeaders.append(name, value);
						else ctx.setHeader(name, value);
					});
					// Password sign-in sets Location on a successful JSON response
					// when callbackURL is present. Only actual redirects follow it.
					if (ctx.method === "GET" || (isAPIError(returned) && returned.statusCode >= 300 && returned.statusCode < 400)) {
						const callback = localCallback(redirect, ctx.context.baseURL);
						throw ctx.redirect(`/auth/two-factor?callbackUrl=${encodeURIComponent(callback)}`);
					}
					ctx.responseHeaders.delete("location");
					ctx.context.responseHeaders?.delete("location");
					return ctx.json(result.response);
				}
				// Rotations are not sign-ins. Pending factor sessions were deleted above.
				if (!incoming || incoming.user.id !== created.user.id || firstFactor) logAuthObserved(created.session, ctx);
				if (VERIFIED_PATHS.has(ctx.path ?? "")) return ctx.json({ token: created.session.token, user: parseUserOutput(ctx.context.options, created.user) });
				return;
			}) }],
		},
	};
}
