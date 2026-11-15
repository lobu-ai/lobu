import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { TOKEN_DERIVED_SESSION_USER_AGENT } from "../../../auth/oauth/scopes";
import { oauthRoutes } from "../../../auth/oauth/routes";
import { credentialRoutes } from "../../../auth/routes";
import type { Env } from "../../../index";
import { __resetPublicOriginCachesForTests } from "../../../utils/public-origin";
import { getRateLimiter } from "../../../utils/rate-limiter";
import { getEnvFromProcess } from "../../../utils/env";
import { Browser, totp } from "../../setup/auth-browser";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

const origin = "http://localhost";
const password = "synthetic-security-password-99";


describe("account security through Better Auth HTTP", () => {
	const keys = ["BETTER_AUTH_SECRET", "LOBU_SINGLE_USER", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "AUTH_CAPTCHA_REQUIRED", "PUBLIC_GATEWAY_URL", "AUTH_COOKIE_DOMAIN"] as const;
	let previous: Array<string | undefined>;
	beforeEach(async () => {
		await cleanupTestDatabase();
		previous = keys.map((key) => process.env[key]);
		process.env.BETTER_AUTH_SECRET = "synthetic-test-auth-secret-".repeat(3);
		delete process.env.LOBU_SINGLE_USER;
		delete process.env.TURNSTILE_SITE_KEY;
		delete process.env.TURNSTILE_SECRET_KEY;
		delete process.env.AUTH_CAPTCHA_REQUIRED;
		delete process.env.PUBLIC_GATEWAY_URL;
		delete process.env.AUTH_COOKIE_DOMAIN;
		__resetPublicOriginCachesForTests();
		clearAuthCacheForTests();
		__resetPublicOriginCachesForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
		clearAuthCacheForTests();
	});

	async function enrolled() {
		const auth = await createAuth(getEnvFromProcess());
		const owner = new Browser(auth);
		const signup = await owner.request("/sign-up/email", { email: "factor@example.test", password, name: "Synthetic factor owner" });
		expect(signup.response.status).toBe(200);
		const setup = await owner.request("/two-factor/enable", { password });
		expect(setup.response.status).toBe(200);
		expect((await owner.request("/two-factor/verify-totp", { code: totp(setup.body.totpURI) })).response.status).toBe(200);
		return { auth, owner, userId: signup.body.user.id as string, uri: setup.body.totpURI as string, codes: setup.body.backupCodes as string[] };
	}

	it("requires a recent owner session and rejects remembered-device and OTP bypasses", async () => {
		const { auth, owner, userId } = await enrolled();
		const guest = new Browser(auth);
		expect((await guest.request("/two-factor/disable", { password })).response.status).toBe(401);
		expect((await owner.request("/two-factor/verify-totp", { code: "123456", trustDevice: true })).response.status).toBe(400);
		expect((await owner.request("/two-factor/verify-totp", { code: "12345" })).response.status).toBe(400);
		expect((await owner.request("/two-factor/send-otp", {})).response.status).toBe(404);
		expect((await owner.request("/two-factor/verify-otp", { code: "123456" })).response.status).toBe(404);
		const sql = getTestDb();
		await sql`UPDATE session SET "createdAt" = NOW() - INTERVAL '16 minutes' WHERE "userId" = ${userId}`;
		for (const [path, body] of [
			["/two-factor/enable", { password }], ["/two-factor/disable", { password }],
			["/two-factor/get-totp-uri", { password }], ["/two-factor/generate-backup-codes", { password }],
			["/passkey/generate-register-options", undefined], ["/passkey/delete-passkey", { id: "synthetic-key" }],
		] as const) {
			const result = await owner.request(path, body);
			expect(result.response.status, path).toBe(403);
			expect(result.body.code, path).toBe("SESSION_NOT_FRESH");
		}
	});

	it("requires MFA after a magic link and keeps the callback local", async () => {
		const { auth, userId, codes } = await enrolled();
		const context = await auth.$context;
		await context.internalAdapter.createVerificationValue({
			identifier: "magic-link:synthetic-magic-link-proof", value: JSON.stringify({ type: "magic-link", email: "factor@example.test" }),
			expiresAt: new Date(Date.now() + 60_000),
		});
		const browser = new Browser(auth);
		const result = await browser.request("/magic-link/verify?token=synthetic-magic-link-proof&callbackURL=%2Faccount%2Fsettings");
		expect(result.response.status).toBe(302);
		expect(result.response.headers.get("location")).toBe("/auth/two-factor?callbackUrl=%2Faccount%2Fsettings");
		expect((await browser.request("/get-session")).body).toBeNull();
		expect((await browser.request("/two-factor/verify-backup-code", { code: codes[0] })).response.status).toBe(200);
		expect((await browser.request("/get-session")).body.user.id).toBe(userId);
	});

	it("requires MFA after phone verification", async () => {
		const { auth, userId, codes } = await enrolled();
		const phone = "+12025550123";
		const sql = getTestDb();
		await sql`UPDATE "user" SET "phoneNumber" = ${phone}, "phoneNumberVerified" = true WHERE id = ${userId}`;
		await (await auth.$context).internalAdapter.createVerificationValue({ identifier: phone, value: "654321:0", expiresAt: new Date(Date.now() + 60_000) });
		const browser = new Browser(auth);
		const verified = await browser.request("/phone-number/verify", { phoneNumber: phone, code: "654321" });
		expect(verified.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect((await browser.request("/get-session")).body).toBeNull();
		expect((await browser.request("/two-factor/verify-backup-code", { code: codes[0] })).response.status).toBe(200);
	});

	it("admits one of two concurrent recovery-code submissions and prevents TOTP replay", async () => {
		const { auth, uri, codes } = await enrolled();
		const browsers = [new Browser(auth), new Browser(auth)];
		for (const browser of browsers) await browser.request("/sign-in/email", { email: "factor@example.test", password });
		const attempts = await Promise.all(browsers.map((browser) => browser.request("/two-factor/verify-backup-code", { code: codes[0] })));
		expect(attempts.filter((attempt) => attempt.response.status === 200)).toHaveLength(1);
		const sessions = await Promise.all(browsers.map((browser) => browser.request("/get-session")));
		expect(sessions.filter((session) => session.body?.user)).toHaveLength(1);
		const replay = new Browser(auth);
		await replay.request("/sign-in/email", { email: "factor@example.test", password });
		expect((await replay.request("/two-factor/verify-totp", { code: totp(uri) })).response.status).toBe(401);
		expect((await replay.request("/get-session")).body).toBeNull();
		await replay.request("/sign-in/email", { email: "factor@example.test", password });
		expect((await replay.request("/two-factor/verify-totp", { code: totp(uri, 1) })).response.status).toBe(200);
	});

	it("applies the account limit across client IPs and rejects unavailable shared enforcement", async () => {
		const auth = await createAuth(getEnvFromProcess());
		for (let attempt = 0; attempt < 11; attempt++) {
			const result = await new Browser(auth, `192.0.2.${attempt + 1}`).request("/sign-in/email", { email: "unknown@example.test", password });
			expect(result.response.status).toBe(attempt < 10 ? 401 : 429);
			if (attempt === 10) expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
		}
		vi.spyOn(getRateLimiter(), "consume").mockResolvedValue({ allowed: true, count: 1, limit: 10, resetInSeconds: 60, windowStart: 0, countedInDb: false });
		const failed = await new Browser(auth).request("/sign-in/email", { email: "other@example.test", password });
		expect(failed.response.status).toBe(503);
		expect(failed.body.code).toBe("AUTH_LIMIT_UNAVAILABLE");
	});

	it("keeps account lockout across challenges and expires a pending challenge", async () => {
		const { auth, userId, codes } = await enrolled();
		const browser = new Browser(auth);
		for (let challenge = 0; challenge < 2; challenge++) {
			await browser.request("/sign-in/email", { email: "factor@example.test", password });
			for (let attempt = 0; attempt < 5; attempt++) {
				expect((await browser.request("/two-factor/verify-backup-code", { code: "synthetic-invalid-code" })).response.status).toBe(401);
			}
		}
		await browser.request("/sign-in/email", { email: "factor@example.test", password });
		expect((await browser.request("/two-factor/verify-backup-code", { code: codes[0] })).response.status).toBe(429);
		expect((await browser.request("/get-session")).body).toBeNull();
		const sql = getTestDb();
		const lock = (await sql`SELECT "failedVerificationCount", "lockedUntil" FROM "twoFactor" WHERE "userId" = ${userId}`)[0]!;
		expect(lock.failedVerificationCount).toBe(10);
		expect(new Date(lock.lockedUntil).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
		await sql`UPDATE "twoFactor" SET "lockedUntil" = NOW() - INTERVAL '1 second' WHERE "userId" = ${userId}`;
		await sql`UPDATE verification SET "expiresAt" = NOW() - INTERVAL '1 second' WHERE value = ${userId} AND identifier LIKE '2fa-%'`;
		expect((await browser.request("/two-factor/verify-backup-code", { code: codes[0] })).response.status).toBe(401);
		await browser.request("/sign-in/email", { email: "factor@example.test", password });
		const unlocked = await browser.request("/two-factor/verify-backup-code", { code: codes[0] });
		expect(unlocked.response.status, JSON.stringify(unlocked.body)).toBe(200);
	});

	it("replaces recovery codes, preserves MFA through password change, and disables with the owner password", async () => {
		const { auth, owner, codes } = await enrolled();
		const replacement = await owner.request("/two-factor/generate-backup-codes", { password });
		expect(replacement.response.status).toBe(200);
		expect(replacement.body.backupCodes).toHaveLength(10);
		expect((await owner.request("/change-password", { currentPassword: password, newPassword: `${password}-new` })).response.status).toBe(200);
		const login = new Browser(auth);
		expect((await login.request("/sign-in/email", { email: "factor@example.test", password: `${password}-new` })).body.twoFactorRedirect).toBe(true);
		expect((await login.request("/two-factor/verify-backup-code", { code: codes[0] })).response.status).toBe(401);
		expect((await login.request("/two-factor/verify-backup-code", { code: replacement.body.backupCodes[0] })).response.status).toBe(200);
		expect((await login.request("/two-factor/disable", { password })).response.status).toBe(400);
		expect((await login.request("/two-factor/disable", { password: `${password}-new` })).response.status).toBe(200);
		await login.request("/sign-out", {});
		expect((await login.request("/sign-in/email", { email: "factor@example.test", password: `${password}-new` })).body.user.twoFactorEnabled).toBe(false);
	});

	it("refuses token-derived management sessions", async () => {
		const { owner, userId } = await enrolled();
		const sql = getTestDb();
		await sql`UPDATE session SET "userAgent" = ${TOKEN_DERIVED_SESSION_USER_AGENT} WHERE "userId" = ${userId}`;
		for (const [path, body] of [
			["/two-factor/disable", { password }], ["/two-factor/generate-backup-codes", { password }],
			["/passkey/generate-register-options", undefined], ["/passkey/update-passkey", { id: "synthetic-key", name: "Synthetic" }],
		] as const) {
			expect((await owner.request(path, body)).response.status, path).toBe(403);
		}
	});

	it("lets a recent passwordless owner enroll while retaining password checks for credential accounts", async () => {
		const auth = await createAuth(getEnvFromProcess());
		const owner = new Browser(auth);
		const signup = await owner.request("/sign-up/email", { email: "passwordless@example.test", password, name: "Synthetic passwordless owner" });
		expect((await owner.request("/two-factor/enable", {})).response.status).toBe(400);
		const sql = getTestDb();
		await sql`DELETE FROM account WHERE "userId" = ${signup.body.user.id} AND "providerId" = 'credential'`;
		const setup = await owner.request("/two-factor/enable", {});
		expect(setup.response.status).toBe(200);
		expect((await owner.request("/two-factor/verify-totp", { code: totp(setup.body.totpURI) })).response.status).toBe(200);
		expect((await owner.request("/two-factor/get-totp-uri", {})).response.status).toBe(200);
		expect((await owner.request("/two-factor/generate-backup-codes", {})).response.status).toBe(200);
		expect((await owner.request("/two-factor/disable", {})).response.status).toBe(200);
	});

	it("blocks local-init before minting credentials for an enrolled owner", async () => {
		const { userId } = await enrolled();
		const app = new Hono<{ Bindings: Env }>().route("/api", credentialRoutes);
		const sql = getTestDb();
		const before = await sql`SELECT id FROM session WHERE "userId" = ${userId}`;
		const response = await app.fetch(new Request(`${origin}/api/local-init`, { method: "POST", headers: { "x-lobu-client": "synthetic-cli" } }), {
			...getEnvFromProcess(), LOBU_LOCAL_INIT_ALLOW_MISSING_PEER: "1",
		});
		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("two_factor_required");
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(await sql`SELECT id FROM personal_access_tokens WHERE user_id = ${userId}`).toHaveLength(0);
		expect(await sql`SELECT id FROM session WHERE "userId" = ${userId}`).toEqual(before);
	});

	it("refuses token-derived OAuth consent, device approval, and profile-only auto-approval", async () => {
		process.env.PUBLIC_GATEWAY_URL = origin;
		__resetPublicOriginCachesForTests();
		const { owner, userId } = await enrolled();
		const sql = getTestDb();
		await sql`UPDATE session SET "userAgent" = ${TOKEN_DERIVED_SESSION_USER_AGENT} WHERE "userId" = ${userId}`;
		const app = new Hono<{ Bindings: Env }>().route("/", oauthRoutes);
		const call = (path: string, body?: Record<string, unknown>) => app.fetch(new Request(`${origin}${path}`, {
			method: body ? "POST" : "GET", headers: { origin, cookie: owner.cookieHeader, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		}), getEnvFromProcess());
		for (const path of ["/oauth/authorize/consent", "/oauth/device/approve"]) {
			const response = await call(path, { approved: true });
			expect(response.status, path).toBe(403);
			expect((await response.json()).error).toBe("human_session_required");
		}
		const register = await call("/oauth/register", { client_name: "Synthetic first-party client", redirect_uris: [`${origin}/callback`], grant_types: ["authorization_code"], token_endpoint_auth_method: "none" });
		expect(register.status).toBe(201);
		const client = await register.json();
		const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: `${origin}/callback`, scope: "profile:read", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
		const response = await call(`/oauth/authorize?${query}`);
		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("human_session_required");
	});

	it("ignores a correctly signed legacy remembered-device cookie", async () => {
		const { auth, userId } = await enrolled();
		const context = await auth.$context;
		const identifier = "trust-device-synthetic-legacy";
		await context.internalAdapter.createVerificationValue({ identifier, value: userId, expiresAt: new Date(Date.now() + 60_000) });
		const token = createHmac("sha256", context.secret).update(`${userId}!${identifier}`).digest("base64url");
		const value = `${token}!${identifier}`;
		const signature = createHmac("sha256", context.secret).update(value).digest("base64");
		const cookie = `${context.createAuthCookie("trust_device").name}=${encodeURIComponent(`${value}.${signature}`)}`;
		const browser = new Browser(auth);
		const response = await browser.request("/sign-in/email", { email: "factor@example.test", password }, { cookie });
		expect(response.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect((await browser.request("/get-session")).body).toBeNull();
	});

	it("registers a software WebAuthn credential and still requires MFA after its signed assertion", async () => {
		const { auth, owner, userId, codes } = await enrolled();
		const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const jwk = publicKey.export({ format: "jwk" });
		const credential = randomBytes(32);
		const id = credential.toString("base64url");
		const registration = await owner.request("/passkey/generate-register-options");
		expect(registration.response.status).toBe(200);
		const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
		const rpHash = createHash("sha256").update("localhost").digest();
		// CBOR COSE EC2/P-256/ES256 key, then a 'none' attestation. These
		// protocol bytes stand in for a device, never for server verification.
		const coseKey = Buffer.concat([
			Buffer.from("a5010203262001215820", "hex"), Buffer.from(jwk.x!, "base64url"),
			Buffer.from("225820", "hex"), Buffer.from(jwk.y!, "base64url"),
		]);
		const authData = Buffer.concat([rpHash, Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credential.length]), credential, coseKey]);
		const attestation = Buffer.concat([
			Buffer.from("a363666d74646e6f6e6568617574684461746158", "hex"), Buffer.from([authData.length]), authData,
			Buffer.from("6761747453746d74a0", "hex"),
		]);
		const created = await owner.request("/passkey/verify-registration", { name: "Synthetic software key", response: {
			id, rawId: id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
			response: { clientDataJSON: clientData("webauthn.create", registration.body.challenge).toString("base64url"), attestationObject: attestation.toString("base64url"), transports: ["internal"] },
		} });
		expect(created.response.status, JSON.stringify(created.body)).toBe(200);
		const login = new Browser(auth);
		const challenge = await login.request("/passkey/generate-authenticate-options");
		expect(challenge.response.status).toBe(200);
		const data = clientData("webauthn.get", challenge.body.challenge);
		const authenticator = Buffer.concat([rpHash, Buffer.from([0x05, 0, 0, 0, 1])]);
		const signature = sign("sha256", Buffer.concat([authenticator, createHash("sha256").update(data).digest()]), privateKey);
		const verified = await login.request("/passkey/verify-authentication", { response: {
			id, rawId: id, type: "public-key", clientExtensionResults: {},
			response: { clientDataJSON: data.toString("base64url"), authenticatorData: authenticator.toString("base64url"), signature: signature.toString("base64url"), userHandle: Buffer.from(userId).toString("base64url") },
		} });
		expect(verified.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect((await login.request("/get-session")).body).toBeNull();
		expect((await login.request("/two-factor/verify-backup-code", { code: codes[0] })).response.status).toBe(200);
		expect((await login.request("/get-session")).body.user.id).toBe(userId);
	});

	it("shares native IP budgets across instances and never trusts a caller's private IP header", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 10_000) * 10_000 + 1_000);
		for (let attempt = 0; attempt < 4; attempt++) {
			clearAuthCacheForTests();
			const auth = await createAuth(getEnvFromProcess());
			(await auth.$context).rateLimit.enabled = true;
			const browser = new Browser(auth, "192.0.2.99");
			const response = await browser.request("/sign-in/email", { email: `synthetic-${attempt}@example.test`, password }, { "x-lobu-auth-client-ip": `198.51.100.${attempt}` });
			expect(response.response.status).toBe(attempt < 3 ? 401 : 429);
			if (attempt === 3) expect(Number(response.response.headers.get("retry-after"))).toBeGreaterThan(0);
		}
		clearAuthCacheForTests();
		const auth = await createAuth(getEnvFromProcess());
		(await auth.$context).rateLimit.enabled = true;
		vi.spyOn(getRateLimiter(), "consume").mockResolvedValue({ allowed: true, count: 1, limit: 10, resetInSeconds: 60, windowStart: 0, countedInDb: false });
		expect((await new Browser(auth, "192.0.2.100").request("/sign-up/email", { email: "outage@example.test", password, name: "Synthetic" })).response.status).toBe(503);
		const sql = getTestDb();
		expect(await sql`SELECT id FROM "user" WHERE email = 'outage@example.test'`).toHaveLength(0);
	});

	it("blocks missing, oversized, rejected, misbound, and unavailable CAPTCHA before sign-up", async () => {
		process.env.TURNSTILE_SITE_KEY = "synthetic-site-key";
		process.env.TURNSTILE_SECRET_KEY = "synthetic-secret-key";
		const auth = await createAuth(getEnvFromProcess());
		const browser = new Browser(auth);
		const body = { email: "captcha@example.test", password, name: "Synthetic captcha owner" };
		for (const path of ["/sign-up/email", "//sign-up/email/"]) {
			expect((await browser.request(path, body)).response.status).toBe(400);
			expect((await browser.request(path, body, { "x-captcha-response": "a".repeat(2049) })).response.status).toBe(400);
		}
		const provider = vi.spyOn(globalThis, "fetch");
		for (const verification of [
			{ success: false, "error-codes": ["timeout-or-duplicate"] },
			{ success: true, hostname: "wrong.example.test", action: "auth" },
			{ success: true, hostname: "localhost", action: "wrong-action" },
		]) {
			provider.mockResolvedValueOnce(Response.json(verification));
			expect((await browser.request("/sign-up/email", body, { "x-captcha-response": "synthetic-token" })).response.status).toBe(403);
		}
		provider.mockRejectedValueOnce(new Error("Synthetic provider outage"));
		expect((await browser.request("/sign-up/email", body, { "x-captcha-response": "synthetic-token" })).response.status).toBe(500);
		const sql = getTestDb();
		expect(await sql`SELECT id FROM "user" WHERE email = ${body.email}`).toHaveLength(0);
		provider.mockResolvedValueOnce(Response.json({ success: true, hostname: "localhost", action: "auth" }));
		expect((await browser.request("/sign-up/email", body, { "x-captcha-response": "synthetic-token" })).response.status).toBe(200);
	});

	it("fails closed when required CAPTCHA configuration is incomplete", async () => {
		process.env.AUTH_CAPTCHA_REQUIRED = "true";
		await expect(createAuth(getEnvFromProcess())).rejects.toThrow("Turnstile requires both site and secret keys");
		clearAuthCacheForTests();
		process.env.TURNSTILE_SITE_KEY = "synthetic-site-key";
		await expect(createAuth(getEnvFromProcess())).rejects.toThrow("Turnstile requires both site and secret keys");
	});

	it("binds CAPTCHA to the browser origin behind TLS termination", async () => {
		process.env.TURNSTILE_SITE_KEY = "synthetic-site-key";
		process.env.TURNSTILE_SECRET_KEY = "synthetic-secret-key";
		process.env.PUBLIC_GATEWAY_URL = "https://security.example.test/lobu";
		__resetPublicOriginCachesForTests();
		const auth = await createAuth(getEnvFromProcess());
		const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, hostname: "security.example.test", action: "auth" }));
		const response = await auth.handler(new Request("http://localhost/api/auth/sign-up/email", {
			method: "POST", headers: { origin: "https://security.example.test", "content-type": "application/json", "x-captcha-response": "synthetic-token" },
			body: JSON.stringify({ email: "ingress@example.test", password, name: "Synthetic ingress owner" }),
		}));
		expect(response.status, await response.clone().text()).toBe(200);
		provider.mockRestore();
	});

	it("enrolls only after proof, challenges login, and consumes a recovery code once", async () => {
		const auth = await createAuth(getEnvFromProcess());
		const owner = new Browser(auth);
		const signup = await owner.request("/sign-up/email", {
			email: "security-owner@example.test", password, name: "Security owner",
		});
		expect(signup.response.status).toBe(200);
		const userId = signup.body.user.id;
		const other = new Browser(auth);
		expect((await other.request("/sign-in/email", { email: "security-owner@example.test", password })).response.status).toBe(200);
		const enabled = await owner.request("/two-factor/enable", { password });
		expect(enabled.response.status).toBe(200);
		expect(enabled.body.backupCodes).toHaveLength(10);
		const sql = getTestDb();
		expect((await sql`SELECT "twoFactorEnabled" FROM "user" WHERE id = ${userId}`)[0]?.twoFactorEnabled).toBe(false);
		const stored = (await sql`SELECT secret, "backupCodes", verified FROM "twoFactor" WHERE "userId" = ${userId}`)[0]!;
		expect(stored.verified).toBe(false);
		expect(stored.secret).not.toContain(new URL(enabled.body.totpURI).searchParams.get("secret"));
		expect(stored.backupCodes).not.toContain(enabled.body.backupCodes[0]);
		const verified = await owner.request("/two-factor/verify-totp", { code: totp(enabled.body.totpURI) });
		expect(verified.response.status).toBe(200);
		expect((await other.request("/get-session")).body).toBeNull();
		expect((await owner.request("/get-session")).body.user.twoFactorEnabled).toBe(true);
		await owner.request("/sign-out", {});
		const login = new Browser(auth);
		const challenge = await login.request("/sign-in/email", { email: "security-owner@example.test", password, callbackURL: `${origin}/account/settings` });
		expect(challenge.response.status).toBe(200);
		expect(challenge.response.headers.get("location")).toBeNull();
		expect(challenge.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect((await login.request("/get-session")).body).toBeNull();
		const recovery = await login.request("/two-factor/verify-backup-code", { code: enabled.body.backupCodes[0] });
		expect(recovery.response.status).toBe(200);
		expect((await login.request("/get-session")).body.user.id).toBe(userId);
		await login.request("/sign-out", {});
		await login.request("/sign-in/email", { email: "security-owner@example.test", password });
		expect((await login.request("/two-factor/verify-backup-code", { code: enabled.body.backupCodes[0] })).response.status).toBe(401);
		expect((await login.request("/get-session")).body).toBeNull();
	});
});
