/**
 * An auth endpoint that fails with a non-APIError (a database error, say) must
 * reach the server's structured log with the error, its Postgres SQLSTATE and
 * the request path — not only Better Auth's own console line, which never
 * carries the request and is invisible next to the generic HTTP 500 entry.
 *
 * The failure is a real Postgres error raised by a trigger on `organization`,
 * so it travels the same driver → Better Auth → router path a statement
 * timeout during an organization delete does in production.
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
): Promise<{ status: number; body: Record<string, unknown> }> {
	const auth = await createAuth(getEnvFromProcess());
	const res = await auth.handler(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
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
			CREATE TRIGGER test_org_delete_timeout BEFORE DELETE ON organization
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
