import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

type Captured = { url: string; body?: unknown; init?: RequestInit };
type HttpStub = {
	post: (url: string, body?: unknown) => Promise<unknown>;
	get: (url: string) => Promise<unknown>;
	request: (url: string, init?: RequestInit) => Promise<Response>;
};

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let PeakaConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildCsv: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let assertReadOnlySql: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let assertPeakaFlowUrl: any;

beforeAll(async () => {
	const mod = await import("../peaka");
	PeakaConnector = mod.default;
	buildCsv = mod.buildCsv;
	assertReadOnlySql = mod.assertReadOnlySql;
	assertPeakaFlowUrl = mod.assertPeakaFlowUrl;
});

const config = {
	PEAKA_API_KEY: "pk_test_key",
	PEAKA_PROJECT_ID: "LePnbVBt",
};

function stubHttp(handlers: Partial<HttpStub> = {}) {
	const captured: Captured[] = [];
	const http = {
		post: async (url: string, body?: unknown) => {
			captured.push({ url, body });
			return handlers.post ? handlers.post(url, body) : {};
		},
		get: async (url: string) => {
			captured.push({ url });
			return handlers.get ? handlers.get(url) : {};
		},
		request: async (url: string, init?: RequestInit) => {
			captured.push({ url, init });
			return handlers.request
				? handlers.request(url, init)
				: new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		},
	};
	return { captured, http };
}

async function invoke(
	actionKey: string,
	input: Record<string, unknown>,
	handlers: Partial<HttpStub> = {},
	connectionConfig: Record<string, unknown> = config,
) {
	const connector = new PeakaConnector();
	const { captured, http } = stubHttp(handlers);
	// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
	(connector as any).http = () => http;
	// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
	const result = await connector.execute({
		actionKey,
		input,
		config: connectionConfig,
		credentials: null,
	});
	return { result, captured, connector };
}

describe("Peaka read-only SQL guard", () => {
	test("accepts SELECT/WITH and rejects DML or multi-statement SQL", () => {
		expect(assertReadOnlySql("SELECT 1")).toBe("SELECT 1");
		expect(assertReadOnlySql("-- comment\nWITH x AS (SELECT 1) SELECT * FROM x;")).toContain(
			"WITH x",
		);
		expect(() => assertReadOnlySql("UPDATE t SET x = 1")).toThrow(/read-only/);
		expect(() => assertReadOnlySql("SELECT 1; DELETE FROM t")).toThrow(/one statement/);
	});
});

describe("Peaka CSV writer", () => {
	test("quotes separators, quotes and newlines without changing the transcript", () => {
		const csv = buildCsv(
			["call_id", "raw_transcript"],
			{ call_id: "42", raw_transcript: 'Agent: "Hi", ok\r\nline2' },
		);
		expect(csv).toBe('call_id,raw_transcript\n42,"Agent: ""Hi"", ok\r\nline2"\n');
	});
});

describe("Peaka actions", () => {
	test("query reads through the configured project and returns SIMPLE rows", async () => {
		const { result, captured } = await invoke(
			"query",
			{ sql: "SELECT id, duration FROM servicetitan.telecom.calls WHERE id = 2070470" },
			{
				post: async () => ({
					columns: [{ columnName: "id" }, { columnName: "duration" }],
					data: [{ id: "2070470", duration: "00:00:57" }],
				}),
			},
		);

		expect(result.success).toBe(true);
		expect(result.output.rows).toEqual([{ id: "2070470", duration: "00:00:57" }]);
		expect(captured[0]?.url).toBe(
			"https://partner.peaka.studio/api/v1/data/projects/LePnbVBt/queries/execute?format=SIMPLE",
		);
		expect(captured[0]?.body).toEqual({
			statement: "SELECT id, duration FROM servicetitan.telecom.calls WHERE id = 2070470",
		});
	});

	test("an action cannot override the connection's project scope", async () => {
		const { captured } = await invoke(
			"query",
			{ sql: "SELECT 1", project_id: "someone-else" },
			{ post: async () => ({ data: [] }) },
		);
		expect(captured[0]?.url).toContain("/projects/LePnbVBt/");
		expect(captured[0]?.url).not.toContain("someone-else");
	});

	test("rejects a write statement before any network call", async () => {
		const { result, captured } = await invoke("query", { sql: "DELETE FROM calls" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/read-only/);
		expect(captured).toHaveLength(0);
	});

	test("add_record imports one CSV row with explicit column mappings", async () => {
		const { result, captured } = await invoke(
			"add_record",
			{
				table: "call_transcripts",
				record: {
					tenant_id: "1517372843",
					call_id: "2070470",
					raw_transcript: 'Customer: "the tap leaks"\nPlease send someone.',
				},
			},
			{
				request: async () =>
					new Response(JSON.stringify({ status: "COMPLETED", result: { processed: 1 } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			},
		);

		expect(result.success).toBe(true);
		expect(result.output.action).toBe("added");
		const url = captured[0]?.url ?? "";
		expect(url).toContain("/table/call_transcripts/import");
		const form = captured[0]?.init?.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		const request = JSON.parse(String(form.get("request")));
		expect(request.containsHeader).toBe(true);
		expect(request.mappings.map((mapping: { name: string }) => mapping.name)).toEqual([
			"tenant_id",
			"call_id",
			"raw_transcript",
		]);
		const file = form.get("file") as File;
		const csv = await file.text();
		expect(csv).toContain('"Customer: ""the tap leaks""');
		expect(csv).toContain("Please send someone.");
		expect(csv.endsWith('"\n')).toBe(true);
	});

	test("upsert_record is a no-op when the keyed row already matches", async () => {
		const row = { idempotency_key: "k1", call_id: "2070470", raw_transcript: "hello" };
		const { result, captured } = await invoke(
			"upsert_record",
			{ table: "call_transcripts", record: row },
			{ post: async () => ({ data: [row] }) },
		);

		expect(result.success).toBe(true);
		expect(result.output.action).toBe("noop");
		expect(captured).toHaveLength(1);
		expect(String(captured[0]?.body && JSON.stringify(captured[0].body))).toContain("idempotency_key");
	});

	test("upsert_record fails closed without a flow because Peaka has no unique constraint", async () => {
		const row = { idempotency_key: "k2", call_id: "2070470", raw_transcript: "hello" };
		const { result, captured } = await invoke(
			"upsert_record",
			{ table: "call_transcripts", record: row },
			{ post: async () => ({ data: [] }) },
		);

		expect(result.success).toBe(false);
		expect(result.output.code).toBe("peaka_upsert_requires_flow");
		expect(result.error).toMatch(/unique constraints/);
		expect(captured).toHaveLength(1);
	});

	test("upsert_record calls the flow and verifies the read-back", async () => {
		const row = { idempotency_key: "k2", call_id: "2070470", raw_transcript: "hello" };
		let reads = 0;
		const flowRequests: Array<{ url: string; body?: unknown }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			flowRequests.push({ url: String(url), body: init?.body });
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const { result, captured } = await invoke(
				"upsert_record",
				{ table: "call_transcripts", record: row },
				{
					post: async () => {
						reads += 1;
						return { data: reads === 1 ? [] : [row] };
					},
				},
				{
					...config,
					PEAKA_UPSERT_FLOW_URL: "https://lobu-6qun.api.peaka.studio/upsert",
				},
			);

			expect(result.success).toBe(true);
			expect(result.output.action).toBe("inserted");
			expect(captured).toHaveLength(2);
			expect(flowRequests).toHaveLength(1);
			expect(JSON.parse(String(flowRequests[0]?.body))).toMatchObject({
				action: "insert",
				table: "call_transcripts",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("upsert_record rejects a flow whose write does not read back", async () => {
		const existing = { idempotency_key: "k3", raw_transcript: "old" };
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		try {
			const { result } = await invoke(
				"upsert_record",
				{ table: "call_transcripts", record: { ...existing, raw_transcript: "new" } },
				{ post: async () => ({ data: [existing] }) },
				{
					...config,
					PEAKA_UPSERT_FLOW_URL: "https://lobu-6qun.api.peaka.studio/upsert",
				},
			);

			expect(result.success).toBe(false);
			expect(result.output.code).toBe("peaka_readback_failed");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("upsert_record reports the flow requirement instead of appending a duplicate", async () => {
		const existing = { idempotency_key: "k3", raw_transcript: "old" };
		const { result, captured } = await invoke(
			"upsert_record",
			{ table: "call_transcripts", record: { ...existing, raw_transcript: "new" } },
			{ post: async () => ({ data: [existing] }) },
		);

		expect(result.success).toBe(false);
		expect(result.output.code).toBe("peaka_upsert_requires_flow");
		expect(result.error).toMatch(/PEAKA_UPSERT_FLOW_URL/);
		expect(captured).toHaveLength(1);
	});

	test("query applies sort, offset and limit while reporting the full match count", async () => {
		const connector = new PeakaConnector();
		const { http } = stubHttp({
			post: async () => ({
				columns: [{ columnName: "id" }],
				data: [{ id: "1" }, { id: "2" }, { id: "3" }],
			}),
		});
		// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
		(connector as any).http = () => http;

		const result = await connector.query({
			query: "SELECT id FROM x",
			config,
			limit: 1,
			offset: 1,
			sort: { column: "id", order: "desc" },
		});
		expect(result.rows).toEqual([{ id: "2" }]);
		expect(result.total).toBe(3);
	});

	test("upsert_record rejects an ambiguous duplicate key instead of treating the first row as canonical", async () => {
		const row = { idempotency_key: "dup", raw_transcript: "x" };
		const { result } = await invoke(
			"upsert_record",
			{ table: "call_transcripts", record: row },
			{ post: async () => ({ data: [row, { ...row, raw_transcript: "other" }] }) },
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/multiple rows/);
	});

	test("invoke_flow posts to the configured Peaka host with the configured token", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), init });
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const connector = new PeakaConnector();
			const result = await connector.execute({
				actionKey: "invoke_flow",
				input: { payload: { call_id: "2070470" } },
				config: {
					...config,
					PEAKA_UPSERT_FLOW_URL: "https://lobu-6qun.api.peaka.studio/lobu-e2e-transcript",
					PEAKA_FLOW_TOKEN: "flow-token",
				},
				credentials: null,
			});
			expect(result.success).toBe(true);
			expect(requests[0]?.url).toBe(
				"https://lobu-6qun.api.peaka.studio/lobu-e2e-transcript",
			);
			expect((requests[0]?.init?.headers as Record<string, string>).authorization).toBe(
				"Bearer flow-token",
			);
			expect(requests[0]?.init?.body).toBe(JSON.stringify({ call_id: "2070470" }));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("refuses a non-Peaka flow host", () => {
		expect(() => assertPeakaFlowUrl("https://evil.example/collect")).toThrow(/non-Peaka/);
		expect(assertPeakaFlowUrl("https://x.api.peaka.studio/hook")).toBe(
			"https://x.api.peaka.studio/hook",
		);
	});
});

describe("Peaka calls feed", () => {
	test("emits rows, advances the checkpoint, and does not re-emit unchanged rows", async () => {
		const rows = [
			{
				id: "2070470",
				createdon: "2026-10-31T11:04:14Z",
				duration: "00:00:57",
				status: "Completed",
				recordingurl: "/telecom/v2/tenant/1517372843/calls/2070470/recording",
			},
		];
		const connector = new PeakaConnector();
		const { http } = stubHttp({ post: async () => ({ data: rows }) });
		// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
		(connector as any).http = () => http;

		const committed: Array<{ events: unknown[]; checkpoint: unknown }> = [];
		const ctx = {
			feedKey: "calls",
			config: {
				...config,
				query: "SELECT id, createdon, duration, status, recordingurl FROM servicetitan.telecom.calls",
			},
			checkpoint: null,
			commit: async (events: unknown[], checkpoint: unknown) => {
				committed.push({ events, checkpoint });
			},
		};
		const first = await connector.sync(ctx);
		expect(first.status).toBe("complete");
		expect(committed[0]?.events).toHaveLength(1);
		expect((committed[0]?.events[0] as Record<string, unknown>).origin_id).toBe(
			"peaka-call:LePnbVBt:calls:2070470",
		);
		expect(committed[0]?.checkpoint).toMatchObject({
			last_timestamp: "2026-10-31T11:04:14.000Z",
		});

		const second = await connector.sync({
			...ctx,
			checkpoint: committed[0]?.checkpoint,
		});
		expect(second.status).toBe("complete");
		expect(committed[1]?.events).toHaveLength(0);
	});

	test("pages by timestamp and id instead of slicing the query result", async () => {
		const rows = [
			{ id: "1", createdon: "2026-11-01T10:00:00Z", status: "a" },
			{ id: "2", createdon: "2026-11-01T11:00:00Z", status: "b" },
			{ id: "3", createdon: "2026-11-01T12:00:00Z", status: "c" },
		];
		const connector = new PeakaConnector();
		const { http } = stubHttp({ post: async () => ({ data: rows }) });
		// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
		(connector as any).http = () => http;

		const committed: Array<{ events: Array<Record<string, unknown>>; checkpoint: unknown }> = [];
		const base = {
			feedKey: "calls",
			config: {
				...config,
				query: "SELECT id, createdon, status FROM servicetitan.telecom.calls",
				max_rows: 2,
			},
			commit: async (events: unknown[], checkpoint: unknown) => {
				committed.push({ events: events as Array<Record<string, unknown>>, checkpoint });
			},
		};

		const first = await connector.sync({ ...base, checkpoint: null });
		expect(first.status).toBe("more");
		expect(committed[0]?.events.map((event) => event.metadata)).toMatchObject([
			{ call_id: "1" },
			{ call_id: "2" },
		]);
		expect(committed[0]?.checkpoint).toMatchObject({
			last_timestamp: "2026-11-01T11:00:00.000Z",
			last_id: "2",
		});

		const second = await connector.sync({ ...base, checkpoint: committed[0]?.checkpoint });
		expect(second.status).toBe("complete");
		expect(committed[1]?.events.map((event) => event.metadata)).toMatchObject([{ call_id: "3" }]);

		const third = await connector.sync({ ...base, checkpoint: committed[1]?.checkpoint });
		expect(third.status).toBe("complete");
		expect(committed[2]?.events).toHaveLength(0);
	});

	test("pages adjacent 64-bit ids without collapsing them through Number", async () => {
		const rows = [
			{ id: "9007199254740992", createdon: "2026-11-01T10:00:00Z", status: "a" },
			{ id: "9007199254740993", createdon: "2026-11-01T10:00:00Z", status: "b" },
		];
		const connector = new PeakaConnector();
		const { http } = stubHttp({ post: async () => ({ data: rows }) });
		// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
		(connector as any).http = () => http;

		const committed: Array<{ events: Array<Record<string, unknown>>; checkpoint: unknown }> = [];
		const base = {
			feedId: 42,
			feedKey: "calls",
			config: {
				...config,
				query: "SELECT id, createdon, status FROM servicetitan.telecom.calls",
				max_rows: 1,
			},
			commit: async (events: unknown[], checkpoint: unknown) => {
				committed.push({ events: events as Array<Record<string, unknown>>, checkpoint });
			},
		};

		await connector.sync({ ...base, checkpoint: null });
		const second = await connector.sync({ ...base, checkpoint: committed[0]?.checkpoint });
		expect(second.status).toBe("complete");
		expect(committed[1]?.events.map((event) => event.metadata)).toMatchObject([
			{ call_id: "9007199254740993" },
		]);
		expect(committed[1]?.events[0]?.origin_id).toBe(
			"peaka-call:LePnbVBt:42:9007199254740993",
		);
	});

	test("namespaces origin ids by feed instance", async () => {
		const connector = new PeakaConnector();
		const { http } = stubHttp({
			post: async () => ({
				data: [{ id: "7", createdon: "2026-11-01T10:00:00Z", status: "a" }],
			}),
		});
		// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
		(connector as any).http = () => http;

		const origins: string[] = [];
		const run = async (feedId: number) => {
			const committed: Array<Array<Record<string, unknown>>> = [];
			const ctx = {
				feedId,
				feedKey: "calls",
				config: {
					...config,
					query: "SELECT id, createdon, status FROM servicetitan.telecom.calls",
				},
				checkpoint: null,
				commit: async (events: unknown[]) => {
					committed.push(events as Array<Record<string, unknown>>);
				},
			};
			await connector.sync(ctx);
			origins.push(String(committed[0]?.[0]?.origin_id));
		};
		await run(1);
		await run(2);
		expect(origins).toEqual([
			"peaka-call:LePnbVBt:1:7",
			"peaka-call:LePnbVBt:2:7",
		]);
	});

	test("emits a changed row when the activity timestamp advances", async () => {
		const connector = new PeakaConnector();
		let rows = [{ id: "7", createdon: "2026-11-01T10:00:00Z", status: "Ringing" }];
		const { http } = stubHttp({ post: async () => ({ data: rows }) });
		// biome-ignore lint/suspicious/noExplicitAny: private seam replaced for the unit test
		(connector as any).http = () => http;

		const committed: Array<{ events: Array<Record<string, unknown>>; checkpoint: unknown }> = [];
		const base = {
			feedKey: "calls",
			config: {
				...config,
				query: "SELECT id, createdon, status FROM servicetitan.telecom.calls",
			},
			commit: async (events: unknown[], checkpoint: unknown) => {
				committed.push({ events: events as Array<Record<string, unknown>>, checkpoint });
			},
		};

		await connector.sync({ ...base, checkpoint: null });
		rows = [{ id: "7", createdon: "2026-11-01T11:00:00Z", status: "Completed" }];
		const update = await connector.sync({ ...base, checkpoint: committed[0]?.checkpoint });

		expect(update.status).toBe("complete");
		expect(committed[1]?.events).toHaveLength(1);
		expect(committed[1]?.events[0]).toMatchObject({
			origin_id: "peaka-call:LePnbVBt:calls:7",
			metadata: { call_id: "7", status: "Completed" },
		});
	});
});

describe("Peaka webhook lifecycle", () => {
	test("returns a manual signed-delivery setup because Peaka has no subscription API", async () => {
		const connector = new PeakaConnector();
		const registration = await connector.registerWebhook({
			config,
			credentials: null,
			callbackUrl: "https://app.lobu.ai/lobu/api/v1/webhooks/42",
		});
		expect(registration.externalId).toContain("LePnbVBt");
		expect(registration.secret).toMatch(/^[a-f0-9]{64}$/);
		expect(registration.metadata?.mode).toBe("manual");
		expect(registration.metadata?.callback_url).toContain("/lobu/api/v1/webhooks/42");
		expect(String(registration.metadata?.setup)).toMatch(/x-peaka-signature/);
		await expect(
			connector.unregisterWebhook({
				config,
				credentials: null,
				callbackUrl: "https://app.lobu.ai/lobu/api/v1/webhooks/42",
			}),
		).resolves.toBeUndefined();
	});
});
