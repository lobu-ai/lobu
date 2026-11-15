import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import type { Env } from "../index";
import { getConfiguredPublicOrigin, normalizeHost } from "../utils/public-origin";
import { getClientIP, getRateLimiter } from "../utils/rate-limiter";

const clientIP = new AsyncLocalStorage<string>();
export const AUTH_CLIENT_IP_HEADER = "x-lobu-auth-client-ip";
export const withAuthClientIP = <T>(ip: string, callback: () => T): T => clientIP.run(ip, callback);

const CAPTCHA_PATHS = new Set([
	"/sign-up/email", "/sign-in/email", "/request-password-reset", "/sign-in/magic-link",
]);

export function getAuthCaptcha(env: Env) {
	const siteKey = env.TURNSTILE_SITE_KEY?.trim();
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
	if (!siteKey && !secretKey && env.AUTH_CAPTCHA_REQUIRED !== "true") return null;
	if (!siteKey || !secretKey) throw new Error("Turnstile requires both site and secret keys");
	// Cloudflare's published testing keys must never protect a production login.
	if ((env.NODE_ENV || process.env.NODE_ENV) === "production" &&
		(/^[123]x0{15,}/.test(siteKey) || /^[123]x0{15,}/.test(secretKey))) {
		throw new Error("Turnstile testing keys are not permitted in production");
	}
	return { provider: "cloudflare-turnstile" as const, siteKey, secretKey, action: "auth" as const };
}

export function authRateKey(secret: string, scope: string, identifier: string): string {
	return `rate:auth:${scope}:${createHmac("sha256", secret).update(identifier).digest("hex")}`;
}

/** Auth never admits a request using the shared limiter's local fallback. */
export async function consumeAuthLimit(key: string, max: number, window: number) {
	const result = await getRateLimiter().consume(key, { limit: max, windowSeconds: window });
	if (!result.countedInDb) throw new APIError("SERVICE_UNAVAILABLE", {
		code: "AUTH_LIMIT_UNAVAILABLE", message: "Sign-in is temporarily unavailable. Try again shortly.",
	});
	return { allowed: result.allowed, retryAfter: result.allowed ? null : Math.max(1, result.resetInSeconds) };
}

export function authRateLimitStorage(secret: string) {
	return { consume: (key: string, rule: { max: number; window: number }) =>
		consumeAuthLimit(authRateKey(secret, `ip:${rule.window}`, key), rule.max, rule.window) };
}

export async function limitAuthRecipient(secret: string, email: string, kind: "login" | "magic-link" | "reset" | "device-email") {
	const identity = email.trim().toLowerCase();
	const rules = kind === "login" ? [[10, 60]] : [[3, 60], [kind === "reset" ? 5 : 10, 3600]];
	for (const [max, window] of rules) {
		const result = await consumeAuthLimit(authRateKey(secret, `${kind}:${window}`, identity), max!, window!);
		if (!result.allowed) throw new APIError("TOO_MANY_REQUESTS", {
			code: "AUTH_RATE_LIMITED", message: "Too many attempts. Try again later.",
		}, { "Retry-After": String(result.retryAfter) });
	}
}

export function authAbuseProtection(env: Env): BetterAuthPlugin {
	const settings = getAuthCaptcha(env);
	return {
		id: "auth-abuse-protection",
		...(settings ? { onRequest: async (request: Request, context: Parameters<NonNullable<BetterAuthPlugin["onRequest"]>>[1]) => {
			const path = new URL(request.url).pathname.replace(/^\/api\/auth(?=\/|$)/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
			if (!CAPTCHA_PATHS.has(path)) return;
			const token = request.headers.get("x-captcha-response");
			if (!token || token.length > 2048 || !token.trim()) return { response: Response.json({
				code: "MISSING_CAPTCHA_RESPONSE", message: "Complete the verification and try again.",
			}, { status: 400 }) };
			// TLS commonly terminates at ingress. The browser Origin names the
			// widget host even when the internal request URL uses plain HTTP.
			let origin: URL;
			try { origin = new URL(request.headers.get("origin") ?? request.url); }
			catch { return { response: Response.json({ code: "CAPTCHA_VERIFICATION_FAILED", message: "Verification failed." }, { status: 403 }) }; }
			const configured = getConfiguredPublicOrigin();
			const zone = normalizeHost(env.AUTH_COOKIE_DOMAIN);
			const allowed = (configured && origin.origin === new URL(configured).origin) ||
				(zone && origin.protocol === "https:" && (origin.hostname === zone || origin.hostname.endsWith(`.${zone}`))) ||
				((env.NODE_ENV || process.env.NODE_ENV) !== "production" && !configured);
			if (!allowed) return { response: Response.json({ code: "CAPTCHA_VERIFICATION_FAILED", message: "Verification failed." }, { status: 403 }) };
			return captcha({
				provider: settings.provider, secretKey: settings.secretKey,
				endpoints: [...CAPTCHA_PATHS], expectedAction: settings.action, allowedHostnames: [origin.hostname],
			}).onRequest!(request, context);
		} } : {}),
		hooks: { before: [{
			matcher: (ctx) => ["/sign-in/email", "/sign-in/magic-link", "/request-password-reset"].includes(ctx.path ?? ""),
			handler: createAuthMiddleware(async (ctx) => {
				if (typeof ctx.body?.email !== "string") return;
				const kind = ctx.path === "/sign-in/email" ? "login" : ctx.path === "/sign-in/magic-link" ? "magic-link" : "reset";
				await limitAuthRecipient(ctx.context.secret, ctx.body.email, kind);
			}),
		}] },
	};
}

/** Only the ingress-resolved address reaches Better Auth, never a caller's header. */
export function withTrustedAuthIP(handler: (request: Request) => Promise<Response>) {
	return async (request: Request): Promise<Response> => {
		const headers = new Headers(request.headers);
		headers.set(AUTH_CLIENT_IP_HEADER, clientIP.getStore() ?? getClientIP(request));
		let response: Response;
		try {
			response = await handler(new Request(request, { headers }));
		} catch (error) {
			// Better Auth runs its IP limiter outside the endpoint error boundary.
			if (!isAPIError(error) || error.statusCode !== 503) throw error;
			return Response.json(error.body, { status: 503, headers: error.headers });
		}
		if (response.status === 429 && response.headers.has("x-retry-after")) {
			response.headers.set("Retry-After", response.headers.get("x-retry-after")!);
		}
		return response;
	};
}
