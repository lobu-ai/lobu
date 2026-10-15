import { APIError, betterAuth } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import logger from "../../utils/logger";
import {
	logUnhandledAuthEndpointError,
	withAuthRequestScope,
} from "../endpoint-error-log";

afterEach(() => vi.restoreAllMocks());

function handler(before: () => Promise<unknown>) {
	const auth = betterAuth({
		baseURL: "http://localhost",
		secret: "synthetic-auth-error-log-secret-for-tests",
		hooks: { before: createAuthMiddleware(before) },
		onAPIError: { onError: logUnhandledAuthEndpointError },
	});
	return withAuthRequestScope(auth.handler);
}

describe("auth endpoint error logging", () => {
	it.each([500, "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE"] as const)(
		"logs server failures with status %s",
		async (status) => {
			const log = vi.spyOn(logger, "error").mockImplementation(() => {});
			const request = handler(async () => {
				throw new APIError(status, { message: "synthetic failure" });
			});
			const response = await request(new Request("http://localhost/api/auth/ok"));
			expect(response.status).toBe(status === "SERVICE_UNAVAILABLE" ? 503 : 500);
			expect(log).toHaveBeenCalledOnce();
		},
	);

	it.each([302, 400, 401, 403, 429] as const)(
		"does not log status %s as a server failure",
		async (status) => {
			const log = vi.spyOn(logger, "error").mockImplementation(() => {});
			const request = handler(async () => {
				throw new APIError(status);
			});
			const response = await request(new Request("http://localhost/api/auth/ok"));
			expect(response.status).toBe(status);
			expect(log).not.toHaveBeenCalled();
		},
	);

	it("preserves the router's bare 500 for unexpected errors", async () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const error = new Error("synthetic unexpected failure");
		const request = handler(async () => {
			throw error;
		});
		const response = await request(new Request("http://localhost/api/auth/ok"));
		expect(response.status).toBe(500);
		expect(await response.text()).toBe("");
		expect(log).toHaveBeenCalledExactlyOnceWith(
			{ err: error, pg_code: undefined, method: "GET", path: "/api/auth/ok" },
			"Unhandled auth endpoint error",
		);
	});

	it("does not log Better Call validation errors as server failures", async () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		const validate = createAuthEndpoint(
			"/validate",
			{ method: "POST", body: z.object({ required: z.string() }) },
			async () => ({}),
		);
		const request = handler(async () =>
			validate({ body: {} as { required: string } }),
		);
		const response = await request(new Request("http://localhost/api/auth/ok"));
		expect(response.status).toBe(400);
		expect(log).not.toHaveBeenCalled();
	});

	it("keeps concurrent request context isolated and omits request secrets", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = withAuthRequestScope(async (req) => {
			if (req.method === "GET") await pending;
			logUnhandledAuthEndpointError(new Error(`${req.method} failed`));
			return new Response(null, { status: 500 });
		});
		const first = request(
			new Request(
				"http://localhost/api/auth/reset-password/synthetic-path-secret?token=synthetic-query-secret",
				{ headers: { authorization: "Bearer synthetic-header-secret" } },
			),
		);
		await request(
			new Request("http://localhost/api/auth/organization/delete", {
				method: "POST",
				body: "synthetic-body-secret",
			}),
		);
		release();
		await first;
		logUnhandledAuthEndpointError(new Error("outside request"));
		const output = write.mock.calls.map(([line]) => String(line)).join("");
		const records = output.trim().split("\n").map((line) => JSON.parse(line));
		expect(records).toMatchObject([
			{ method: "POST", path: "/api/auth/organization/delete" },
			{ method: "GET", path: "/api/auth/reset-password/[REDACTED]" },
			{ err: { message: "outside request" } },
		]);
		expect(records[2]).not.toHaveProperty("path");
		for (const secret of ["path", "query", "header", "body"]) {
			expect(output).not.toContain(`synthetic-${secret}-secret`);
		}
	});
});
