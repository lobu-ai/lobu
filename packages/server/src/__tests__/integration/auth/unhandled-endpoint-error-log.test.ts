/**
 * What the auth endpoints write to the server's structured log.
 *
 * Every sign-in the Better Auth handler completes, sign-up included, writes
 * one `auth.observed` line that carries ids only, plus the Cloudflare ray id
 * that joins it to Logpush.
 *
 * An auth endpoint that fails with a non-APIError (a database error, say) must
 * reach the server's structured log with the error, its Postgres SQLSTATE and
 * the request path — not only Better Auth's own console line, which never
 * carries the request and is invisible next to the generic HTTP 500 entry.
 *
 * The failure is a real Postgres error raised by a trigger on `organization`
 * (the delete request stamps the row), so it travels the same driver → Better
 * Auth → router path a statement timeout does in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { getEnvFromProcess } from "../../../utils/env";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

const BASE = "http://localhost/api/auth";

async function call(
	path: string,
	body: Record<string, unknown>,
	token?: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const auth = await createAuth(getEnvFromProcess());
	const res = await auth.handler(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...headers,
			},
			body: JSON.stringify(body),
		}),
	);
	const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body: parsed };
}

function captureStdout(): { lines: () => Array<Record<string, unknown>>; restore: () => void } {
	const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	return {
		lines: () =>
			write.mock.calls.flatMap(([chunk]) =>
				String(chunk)
					.split("\n")
					.filter((line) => line.startsWith("{"))
					.map((line) => JSON.parse(line) as Record<string, unknown>),
			),
		restore: () => write.mockRestore(),
	};
}

describe("unhandled auth endpoint errors", () => {
	const originalSecret = process.env.BETTER_AUTH_SECRET;

	beforeEach(async () => {
		await cleanupTestDatabase();
		process.env.BETTER_AUTH_SECRET = "b".repeat(64);
		clearAuthCacheForTests();
	});

	afterEach(async () => {
		const sql = getTestDb();
		await sql`DROP TRIGGER IF EXISTS test_org_delete_timeout ON organization`;
		await sql`DROP FUNCTION IF EXISTS test_org_delete_timeout()`;
		if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
		else process.env.BETTER_AUTH_SECRET = originalSecret;
		clearAuthCacheForTests();
	});

	it("logs a database failure in /organization/delete with its code and path", async () => {
		const signUp = await call("/sign-up/email", {
			email: "owner@delete-log.test",
			password: "ownerpassword99",
			name: "Owner",
		});
		expect(signUp.status).toBe(200);
		const token = signUp.body.token as string;
		expect(token).toBeTruthy();

		const created = await call(
			"/organization/create",
			{ name: "Large Workspace", slug: "large-workspace-delete-log" },
			token,
		);
		expect(created.status).toBe(200);
		const organizationId = created.body.id as string;

		const sql = getTestDb();
		await sql.unsafe(`
			CREATE FUNCTION test_org_delete_timeout() RETURNS trigger AS $$
			BEGIN
				RAISE EXCEPTION 'canceling statement due to statement timeout'
					USING ERRCODE = '57014';
			END;
			$$ LANGUAGE plpgsql
		`);
		await sql.unsafe(`
			CREATE TRIGGER test_org_delete_timeout BEFORE UPDATE ON organization
			FOR EACH ROW EXECUTE FUNCTION test_org_delete_timeout()
		`);

		const stdout = captureStdout();
		let deleted: Awaited<ReturnType<typeof call>>;
		let records: Array<Record<string, unknown>>;
		try {
			deleted = await call("/organization/delete", { organizationId }, token);
			records = stdout.lines();
		} finally {
			stdout.restore();
		}

		// The response is Better Auth's own, unchanged.
		expect(deleted.status).toBe(500);

		const entries = records.filter(
			(record) => record.msg === "Unhandled auth endpoint error",
		);
		expect(entries).toHaveLength(1);
		const entry = entries[0] as Record<string, unknown> & {
			err: { message: string; stack: string; type: string };
		};
		expect(entry).toMatchObject({
			level: "error",
			path: "/api/auth/organization/delete",
			pg_code: "57014",
		});
		expect(entry.err.message).toContain("statement timeout");
		expect(entry.err.stack).toContain("statement timeout");
		expect(entry.err.type).toBeTruthy();
		// No credential travels with the record.
		expect(JSON.stringify(entry)).not.toContain(token);
	});
});

describe("auth.observed", () => {
	const originalSecret = process.env.BETTER_AUTH_SECRET;

	beforeEach(async () => {
		await cleanupTestDatabase();
		process.env.BETTER_AUTH_SECRET = "b".repeat(64);
		clearAuthCacheForTests();
	});

	afterEach(() => {
		if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
		else process.env.BETTER_AUTH_SECRET = originalSecret;
		clearAuthCacheForTests();
	});

	it("logs one line per sign-up and sign-in with ids and the ray id only", async () => {
		const email = "observed@auth-observed.test";
		const password = "observedpassword99";
		const name = "Observed Person";
		const client = {
			"x-forwarded-for": "203.0.113.7",
			"user-agent": "SyntheticBrowser/1.0",
		};

		const stdout = captureStdout();
		let signUp: Awaited<ReturnType<typeof call>>;
		let signIn: Awaited<ReturnType<typeof call>>;
		let records: Array<Record<string, unknown>>;
		try {
			signUp = await call("/sign-up/email", { email, password, name }, undefined, {
				...client,
				"cf-ray": "a53b9d57c926253b-LHR",
			});
			signIn = await call("/sign-in/email", { email, password }, undefined, client);
			records = stdout.lines();
		} finally {
			stdout.restore();
		}
		expect(signUp.status).toBe(200);
		expect(signIn.status).toBe(200);
		const userId = (signUp.body.user as { id: string }).id;
		const [personalOrg] = await getTestDb()`
			SELECT id FROM "organization"
			WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${userId}
		`;
		expect(personalOrg?.id).toBeTruthy();

		const observed = records.filter((record) => record.event === "auth.observed");
		expect(observed).toHaveLength(2);
		const [signedUp, signedIn] = observed;
		expect(signedUp).toMatchObject({
			kind: "sign_up",
			user_id: userId,
			org_id: personalOrg?.id,
			method: "/sign-up/email",
			cf_ray: "a53b9d57c926253b",
		});
		expect(signedIn).toMatchObject({
			kind: "sign_in",
			user_id: userId,
			org_id: null,
			method: "/sign-in/email",
			cf_ray: null,
		});
		expect(signedUp?.auth_event_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(signedIn?.auth_event_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(signedUp?.auth_event_id).not.toBe(signedIn?.auth_event_id);

		const secrets = [
			email,
			name,
			password,
			"203.0.113.7",
			"SyntheticBrowser",
			signUp.body.token as string,
			signIn.body.token as string,
		];
		for (const line of observed) {
			const serialized = JSON.stringify(line);
			for (const secret of secrets) expect(serialized).not.toContain(secret);
		}
	});
});
