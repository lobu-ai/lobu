import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Socket } from "node:net";
import type { FeedReadContext, SyncContext } from "@lobu/connector-sdk";
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
		["SELECT $$literal LIMIT$$ LIMIT 1", /top-level LIMIT/],
		["SELECT 'it''s literal'; SELECT 2", /single statement/],
		["SELECT 1 /* outer /* inner */ $1 */ + $1", /bind parameters/],
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

	test.each([
		"SELECT * FROM (SELECT 1 LIMIT 1) q",
		"SELECT 'tool_invocation:query_sdk' AS value",
		"SELECT '$1; :name LIMIT 1' AS value",
		"SELECT $$text; :name $1 LIMIT 1$$ AS value",
		"SELECT $tag$text; :name $1 LIMIT 1$tag$ AS value",
		'SELECT 1 AS "colon:name; $1 LIMIT"',
		"/* outer /* nested */ :name; $1 LIMIT */ SELECT 1",
		"-- :name; $1 LIMIT\nSELECT 1",
		String.raw`SELECT E'escaped\\\'; :name $1 LIMIT' AS value`,
	])("allows an inner LIMIT, literals and comments in %j without connecting", async (query) => {
		// The existing TLS guard stops execution after SQL validation, before pool creation.
		const result = new PostgresConnector().query({
			query,
			config: {
				DATABASE_URL:
					"postgres://dummy:dummy@127.0.0.1:1/dummy?sslmode=verify-full",
			},
			credentials: null,
		});
		await expect(result).rejects.toThrow(/cannot verify server certificates/);
		await expect(result).rejects.not.toHaveProperty("status");
		expect(connect).not.toHaveBeenCalled();
	});

	test("keeps a missing DATABASE_URL error without a status", async () => {
		const result = new PostgresConnector().query({
			query: "SELECT 1",
			config: {},
			credentials: null,
		});
		await expect(result).rejects.toThrow("DATABASE_URL is required");
		await expect(result).rejects.not.toHaveProperty("status");
		expect(connect).not.toHaveBeenCalled();
	});

	test("sync rejects invalid stored SQL with status 400 before opening a socket", async () => {
		const ctx: SyncContext = {
			feedKey: "query",
			config: {
				DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:1/dummy",
				query: "SELECT 1 AS id LIMIT 1",
				primary_key: "id",
				cursor_column: "id",
			},
			checkpoint: null,
			credentials: null,
			entityIds: [],
			commit: async () => {},
		};
		await expect(new PostgresConnector().sync(ctx)).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/top-level LIMIT\/OFFSET/),
		});
		expect(connect).not.toHaveBeenCalled();
	});

	test("read rejects invalid stored SQL with status 400 before opening a socket", async () => {
		const ctx: FeedReadContext = {
			feedKey: "query",
			config: {
				DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:1/dummy",
				query: "SELECT 1 AS id LIMIT 1",
				primary_key: "id",
				cursor_column: "id",
			},
			credentials: null,
		};
		await expect(new PostgresConnector().read(ctx)).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/top-level LIMIT\/OFFSET/),
		});
		expect(connect).not.toHaveBeenCalled();
	});
});
