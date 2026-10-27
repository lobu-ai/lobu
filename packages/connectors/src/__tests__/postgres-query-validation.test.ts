import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Socket } from "node:net";
import PostgresConnector from "../postgres";

describe("Postgres query preexecution validation", () => {
	let connect: ReturnType<typeof spyOn>;

	beforeEach(() => {
		connect = spyOn(Socket.prototype, "connect").mockImplementation(() => {
			throw new Error("unexpected socket connection");
		});
	});

	afterEach(() => {
		connect.mockRestore();
	});

	test.each([
		["SELECT 1 LIMIT 1", /top-level LIMIT/],
		["SELECT1LIMIT1", /single read-only SELECT/],
		["", /query is empty/],
		["DELETE FROM example", /single read-only SELECT/],
		["SELECT $1", /bind parameters/],
		["SELECT :name", /bind parameters/],
		["SELECT 1; SELECT 2", /single statement/],
		["SELECT 1 OFFSET 1", /top-level LIMIT\/OFFSET/],
	])("rejects %j with status 400 before opening a socket", async (query, message) => {
		await expect(
			new PostgresConnector().query({
				query,
				config: { DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:1/dummy" },
				credentials: null,
			}),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(message),
		});
		expect(connect).not.toHaveBeenCalled();
	});

	test("allows an inner LIMIT through validation without connecting", async () => {
		// The existing TLS guard stops execution after SQL validation, before pool creation.
		await expect(
			new PostgresConnector().query({
				query: "SELECT * FROM (SELECT 1 LIMIT 1) q",
				config: {
					DATABASE_URL:
						"postgres://dummy:dummy@127.0.0.1:1/dummy?sslmode=verify-full",
				},
				credentials: null,
			}),
		).rejects.toThrow(/cannot verify server certificates/);
		expect(connect).not.toHaveBeenCalled();
	});
});
