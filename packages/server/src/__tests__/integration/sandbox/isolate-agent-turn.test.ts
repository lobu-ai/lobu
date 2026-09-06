/**
 * Agent turn on the connector isolate lane, end to end.
 *
 * One conversation turn is one isolate job: `IsolateExecutor` runs Lobu's own
 * agent-session guest bundle exactly the way it runs a connector, so the turn
 * inherits the lane's egress dispatcher, wall clock, memory limit, log budget
 * and terminal-state machine rather than growing a second copy of any of them.
 *
 * What is pinned here:
 *  1. the guest bundle is isolate-eligible — no Node builtin survives the
 *     aliasing, which is the only cheap proof the artifact can load at all;
 *  2. a turn against a provider that streams Server-Sent Events produces the
 *     tokens ON THE HOST WHILE THE STREAM IS OPEN, not in one lump at the end
 *     (what the subprocess lane visibly does, and the reason PR 3 taught
 *     the lane to stream);
 *  3. the transcript comes back with the turn appended, so the next turn can
 *     resume from it;
 *  4. the guest reaches the gateway host it was given and NOTHING else — an
 *     agent turn runs deny-all, unlike a connector's open default;
 *  5. a tool call is one more request to the same gateway, over the same
 *     `fetch`, carrying the same one credential — and the transcript comes
 *     back with the call and its result in it;
 *  6. the workspace tools run inside the isolate against a filesystem the
 *     turn owns: a `bash` write is visible to `read`, and no request leaves
 *     the guest for either;
 *  7. the GATEWAY tools (`ask_user` and the rest of
 *     `@lobu/plugin-conversations`) run the plugin package's OWN code inside
 *     the guest — same route, same body, same one credential the MCP call
 *     uses — and `ask_user` ends the turn, as it does on the subprocess lane.
 *
 * Runs under Node (vitest); like the other lane suites it FAILS rather than
 * skips when `isolated-vm` cannot load.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { agentGuestBundle } from "@lobu/connector-worker/agent-turn";
import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput } from "@lobu/connector-worker/agent-turn";
import type { ExecutorJob } from "@lobu/connector-worker/executor/interface";
import { IsolateExecutor, type IsolateLogLevel } from "@lobu/connector-worker/executor/isolate";
import { assertIsolateEligible } from "@lobu/connector-worker/isolate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Requests the fake provider has answered. */
interface ProviderHit {
	method: string;
	url: string;
	authorization: string | null;
	apiKeyHeader: string | null;
	body: string;
}

let guestCode: string;
let server: Server;
let port: number;
let hits: ProviderHit[] = [];

/** The gateway's own placeholder for the agent's provider key. */
const GATEWAY_PLACEHOLDER = "lobu_secret_00000000-0000-4000-8000-000000000000";

/**
 * A 1x1 PNG, base64 — the shape the producer resolves an image attachment into
 * after reading it out of the artifact store. Small enough to assert on
 * verbatim in the request body the fake provider captured.
 */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Resolved by the test when the HOST has seen its first token. The fake
 * provider will not finish its response until then, so a lane that buffered the
 * body and only handed the tokens over at the end would deadlock here rather
 * than pass — which is the whole point of streaming the body.
 */
let sawFirstDelta: Promise<void> = Promise.resolve();
let markFirstDelta: () => void = () => undefined;

function armFirstDeltaGate(): void {
	sawFirstDelta = new Promise<void>((resolve) => {
		markFirstDelta = resolve;
	});
}

/** One SSE frame per write, so the guest has to pull the body more than once. */
async function writeAnthropicStream(res: Parameters<Parameters<typeof createServer>[0]>[1], pieces: string[]): Promise<void> {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	send("message_start", {
		type: "message_start",
		message: {
			id: "msg_isolate",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 11, output_tokens: 0 },
		},
	});
	send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	for (const piece of pieces) {
		send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
	}
	await sawFirstDelta;
	send("content_block_stop", { type: "content_block_stop", index: 0 });
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 7 },
	});
	send("message_stop", { type: "message_stop" });
	res.end();
}

/** An assistant turn that calls one tool and stops for its result. */
function writeAnthropicToolUse(
	res: Parameters<Parameters<typeof createServer>[0]>[1],
	call: { id: string; name: string; input: Record<string, unknown> },
): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	send("message_start", {
		type: "message_start",
		message: {
			id: "msg_tool",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 0 },
		},
	});
	send("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
	});
	send("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
	});
	send("content_block_stop", { type: "content_block_stop", index: 0 });
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 3 },
	});
	send("message_stop", { type: "message_stop" });
	res.end();
}

/**
 * The tool the fake gateway serves at its MCP route, and what it answers. The
 * route is the same one the real gateway's MCP proxy mounts.
 */
const TOOL_ROUTE = "/lobu/mcp/lobu-memory/tools/query_sdk";
let toolReply: { status: number; body: unknown } = {
	status: 200,
	body: { content: [{ type: "text", text: "3 entities" }] },
};

/** What the fake gateway answers on its `/internal/...` routes. */
let internalReply: { status: number; body: unknown } = { status: 200, body: { id: "int_1" } };

/**
 * The memory MCP server the `lobu-memory` plugin's hooks call. `search_memory`
 * before the model runs, `save_memory` after it answers — the same two tools,
 * on the same MCP route, that the subprocess lane invokes through
 * `@lobu/plugin-mcp`.
 */
const MEMORY_MCP_ID = "lobu";
let memoryReplies: Record<string, { status: number; body: unknown }> = {};
/** Every memory tool call the guest made, in order, with its parsed body. */
let memoryCalls: Array<{ tool: string; body: Record<string, unknown> }> = [];

/** The multipart uploads the fake gateway received, already parsed. */
interface UploadHit {
	filename: string;
	fileName: string;
	fileType: string;
	fileBytes: Buffer;
	comment: string | null;
	voiceHeader: string | null;
	authorization: string | null;
	channelId: string | null;
	conversationId: string | null;
}
let uploads: UploadHit[] = [];
let uploadReply: { status: number; body: unknown } = {
	status: 200,
	body: { fileId: "file_iso", name: "report.csv", permalink: "https://files.test/iso" },
};

/**
 * Parse a multipart body the way the real `/internal/files/upload` route does
 * — `Request.formData()`, i.e. the platform parser, not a regex over the raw
 * bytes. If the guest's `FormData` did not produce a well-formed body with a
 * real file part, this throws and the test fails, which is the point.
 */
async function readUpload(
	headers: Record<string, string | undefined>,
	raw: Buffer,
): Promise<{ filename: string; fileName: string; fileType: string; fileBytes: Buffer; comment: string | null }> {
	const contentType = headers["content-type"] ?? "";
	const form = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
	const file = form.get("file");
	if (!(file instanceof File)) throw new Error(`the upload's "file" part is not a file (got ${typeof file})`);
	const comment = form.get("comment");
	return {
		filename: String(form.get("filename")),
		fileName: file.name,
		fileType: file.type,
		fileBytes: Buffer.from(await file.arrayBuffer()),
		comment: comment === null ? null : String(comment),
	};
}

/**
 * The tool calls the fake model makes, in order, one per provider round; the
 * round after the last one answers with text. The MCP scenario is the default.
 */
let toolScript: Array<{ id: string; name: string; input: Record<string, unknown> }> = [
	{ id: "toolu_01", name: "query_sdk", input: { code: "entities.count()" } },
];

/** How many tool results the transcript already carries. */
function toolResultCount(messages: Array<{ role: string; content: unknown }>): number {
	let count = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) if ((block as { type?: string }).type === "tool_result") count += 1;
	}
	return count;
}

beforeAll(async () => {
	guestCode = await agentGuestBundle();
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks);
			const body = rawBody.toString("utf8");
			hits.push({
				method: req.method ?? "",
				url: req.url ?? "",
				authorization: (req.headers.authorization as string | undefined) ?? null,
				apiKeyHeader: (req.headers["x-api-key"] as string | undefined) ?? null,
				body,
			});
			if (req.url === TOOL_ROUTE) {
				res.writeHead(toolReply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(toolReply.body));
				return;
			}
			// The memory plugin's own two tools, on the MCP route.
			const memoryTool = /^\/lobu\/mcp\/([^/]+)\/tools\/(search_memory|save_memory)$/.exec(req.url ?? "");
			if (memoryTool) {
				const tool = memoryTool[2] as string;
				memoryCalls.push({ tool, body: JSON.parse(body || "{}") as Record<string, unknown> });
				const reply = memoryReplies[tool] ?? { status: 200, body: { content: [] } };
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(reply.body));
				return;
			}
			// The media plugin's file delivery. Parsed with the platform's own
			// multipart parser, exactly as the real route does.
			if (req.url === "/lobu/internal/files/upload") {
				void readUpload(req.headers as Record<string, string | undefined>, rawBody).then(
					(parsed) => {
						uploads.push({
							...parsed,
							voiceHeader: (req.headers["x-voice-message"] as string | undefined) ?? null,
							authorization: (req.headers.authorization as string | undefined) ?? null,
							channelId: (req.headers["x-channel-id"] as string | undefined) ?? null,
							conversationId: (req.headers["x-conversation-id"] as string | undefined) ?? null,
						});
						res.writeHead(uploadReply.status, { "content-type": "application/json" });
						res.end(JSON.stringify(uploadReply.body));
					},
					(error: Error) => {
						res.writeHead(400, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: `unparseable upload: ${error.message}` }));
					},
				);
				return;
			}
			// The generation endpoints answer BINARY, which is the whole reason
			// the upload path had to stop round-tripping bodies through UTF-8.
			if (req.url === "/lobu/internal/images/generate") {
				res.writeHead(200, { "content-type": "image/png", "x-image-provider": "openai" });
				res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
				return;
			}
			if (req.url === "/lobu/internal/audio/synthesize") {
				res.writeHead(200, { "content-type": "audio/mpeg", "x-audio-provider": "openai" });
				res.end(Buffer.from([0xff, 0xfb, 0x00, 0x1c]));
				return;
			}
			// The gateway's own internal routes, which the conversation plugin's
			// tools call directly rather than through the MCP proxy.
			if (req.url?.startsWith("/lobu/internal/")) {
				res.writeHead(internalReply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(internalReply.body));
				return;
			}
			// The fake model follows its script: one tool call per round until
			// every scripted call has its result in the transcript, then the answer.
			const request = JSON.parse(body) as { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> };
			const next = Array.isArray(request.tools) && request.tools.length > 0 ? toolScript[toolResultCount(request.messages)] : undefined;
			if (next) {
				writeAnthropicToolUse(res, next);
				return;
			}
			void writeAnthropicStream(res, ["Hello", " from", " the", " isolate"]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function turnJob(input: Partial<AgentTurnInput> = {}, baseUrl?: string): ExecutorJob {
	return {
		mode: "agent_turn",
		turn: {
			provider: {
				api: "anthropic-messages",
				provider: "anthropic",
				modelId: "claude-test",
				baseUrl: baseUrl ?? `http://127.0.0.1:${port}`,
				maxTokens: 64,
			},
			systemPrompt: "You are a test agent.",
			messages: [],
			userMessage: "hi",
			...input,
		},
		config: {},
		// What the gateway hands the subprocess lane today: its own placeholder,
		// resolved by the secret-proxy, never a real key. The host mints a vault
		// placeholder over it, so this exact string must still arrive upstream.
		credentials: { provider: "anthropic", accessToken: GATEWAY_PLACEHOLDER },
		sessionState: null,
		env: {},
	};
}

interface TurnRun {
	events: AgentTurnEvent[];
	logs: { level: IsolateLogLevel; line: string }[];
	output: AgentTurnOutput;
}

async function runTurn(job: ExecutorJob, allowedDomains: readonly string[] = ["127.0.0.1"]): Promise<TurnRun> {
	const events: AgentTurnEvent[] = [];
	const logs: { level: IsolateLogLevel; line: string }[] = [];
	const executor = new IsolateExecutor({
		timeoutMs: 60_000,
		allowedDomains,
		logSink: (level, line) => logs.push({ level, line }),
	});
	const result = await executor.execute(guestCode, job, {
		onTurnEvent: (event) => {
			events.push(event);
			if (event.type === "text_delta") markFirstDelta();
		},
	});
	if (result.mode !== "agent_turn") throw new Error(`expected an agent_turn result, got ${result.mode}`);
	return { events, logs, output: result.turn };
}

/** A turn the lane refused, with the run log that says why. */
async function failTurn(
	job: ExecutorJob,
	allowedDomains: readonly string[],
): Promise<{ error: Error; logs: { level: IsolateLogLevel; line: string }[] }> {
	const logs: { level: IsolateLogLevel; line: string }[] = [];
	const executor = new IsolateExecutor({
		timeoutMs: 60_000,
		allowedDomains,
		logSink: (level, line) => logs.push({ level, line }),
	});
	const error = await executor.execute(guestCode, job, {}).then(
		() => null,
		(caught: unknown) => caught as Error,
	);
	if (!error) throw new Error("expected the agent turn to fail");
	return { error, logs };
}

describe("agent turn on the isolate lane", () => {
	it("bundles the agent guest with no Node builtin left in it", () => {
		expect(guestCode.length).toBeGreaterThan(1_000_000);
		expect(() => assertIsolateEligible(guestCode)).not.toThrow();
	});

	it("streams a turn: deltas reach the host while the response is still open", async () => {
		hits = [];
		armFirstDeltaGate();
		const run = await runTurn(turnJob());

		expect(run.output.text).toBe("Hello from the isolate");
		expect(run.output.stopReason).toBe("stop");
		expect(run.output.usage).toEqual({ input: 11, output: 7 });

		const deltas = run.events.filter((e) => e.type === "text_delta");
		expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual(["Hello", " from", " the", " isolate"]);
		expect(run.events.at(-1)).toEqual({ type: "message_end" });

		// The response the deltas came from is the only request made, and the
		// guest never saw a real key: it sent the gateway's placeholder.
		expect(hits.length).toBe(1);
		expect(hits[0]?.url).toBe("/v1/messages");
		expect(hits[0]?.apiKeyHeader).toBe(GATEWAY_PLACEHOLDER);
		expect(JSON.parse(hits[0]?.body ?? "{}")).toMatchObject({ model: "claude-test", system: expect.anything() });
	}, 120_000);

	it("returns the transcript with the turn appended so the next turn resumes from it", async () => {
		hits = [];
		armFirstDeltaGate();
		const first = await runTurn(turnJob());
		armFirstDeltaGate();
		expect(first.output.messages.length).toBeGreaterThanOrEqual(2);
		expect(first.output.messages[0]).toMatchObject({ role: "user" });
		expect(first.output.messages.at(-1)).toMatchObject({ role: "assistant" });

		// pi prices every assistant entry off the model's four cost keys. A model
		// missing one puts NaN there, which JSON turns to null on the way to the
		// run row — so the entry must be finite before it is ever persisted.
		const priced = first.output.messages.at(-1) as {
			usage?: { cost?: Record<string, number> };
		};
		expect(Object.values(priced.usage?.cost ?? {}).every(Number.isFinite)).toBe(true);

		const second = await runTurn(turnJob({ messages: first.output.messages, userMessage: "and again" }));
		expect(second.output.messages.length).toBe(first.output.messages.length + 2);
		const sent = JSON.parse(hits.at(-1)?.body ?? "{}") as { messages: unknown[] };
		expect(sent.messages.length).toBe(3);
	}, 120_000);

	it("runs deny-all: a turn cannot reach a host outside its allowlist", async () => {
		hits = [];
		const { error, logs } = await failTurn(turnJob(), ["gateway.invalid"]);

		// The provider SDK reports every transport failure as one masked
		// message, so the refusal is only legible in the run log — which is
		// exactly where an operator looks, and why the lane logs it there.
		expect(error.message).toBe("Connection error.");
		expect(logs).toContainEqual({
			level: "warn",
			line: "egress denied: fetch to 127.0.0.1 is not permitted (this run may reach: gateway.invalid)",
		});
		expect(hits.length).toBe(0);
	}, 120_000);

	it("conceals the gateway's own credential from the guest and audits the spend", async () => {
		hits = [];
		armFirstDeltaGate();
		const run = await runTurn(turnJob());

		// Upstream got the gateway's placeholder, so the secret-proxy can still
		// resolve it...
		expect(hits[0]?.apiKeyHeader).toBe(GATEWAY_PLACEHOLDER);
		// ...but what the guest held was a different, per-run placeholder, and the
		// host recorded spending it. Same audit line a connector's OAuth token gets.
		const spends = run.logs.filter((l) => l.line.startsWith("credential "));
		expect(spends).toHaveLength(1);
		expect(spends[0]?.line).toMatch(/^credential [0-9a-f]{12} spent on 127\.0\.0\.1 in header x-api-key$/);
		expect(spends[0]?.line).not.toContain(GATEWAY_PLACEHOLDER.slice(-12));
	}, 120_000);

	function toolJob(overrides: Partial<AgentTurnInput> = {}): ExecutorJob {
		return turnJob({
			tools: {
				gatewayUrl: `http://127.0.0.1:${port}/lobu`,
				definitions: [
					{
						mcpId: "lobu-memory",
						name: "query_sdk",
						description: "Read workspace data",
						inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
					},
				],
			},
			...overrides,
		});
	}

	it("calls a tool through the gateway's MCP route with the same one credential, and resumes from the result", async () => {
		hits = [];
		toolScript = [{ id: "toolu_01", name: "query_sdk", input: { code: "entities.count()" } }];
		toolReply = { status: 200, body: { content: [{ type: "text", text: "3 entities" }] } };
		armFirstDeltaGate();
		const run = await runTurn(toolJob());

		expect(run.output.text).toBe("Hello from the isolate");
		expect(run.output.stopReason).toBe("stop");
		// Two provider calls around one tool call: usage is the turn's total.
		expect(run.output.usage).toEqual({ input: 16, output: 10 });

		expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual([
			"POST /v1/messages",
			"POST /lobu/mcp/lobu-memory/tools/query_sdk",
			"POST /v1/messages",
		]);
		// The model was offered the tool with the schema the gateway published...
		const offered = JSON.parse(hits[0]?.body ?? "{}") as { tools?: Array<{ name: string; input_schema: unknown }> };
		expect(offered.tools).toEqual([
			expect.objectContaining({
				name: "query_sdk",
				input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
			}),
		]);
		// ...the tool call carried the model's arguments and the SAME credential
		// the provider call did, resolved by the host into the bearer header...
		expect(hits[1]?.body).toBe(JSON.stringify({ code: "entities.count()" }));
		expect(hits[1]?.authorization).toBe(`Bearer ${GATEWAY_PLACEHOLDER}`);
		expect(hits[1]?.apiKeyHeader).toBeNull();
		// ...and the second provider call resumed from the tool result.
		const resumed = JSON.parse(hits[2]?.body ?? "{}") as { messages: Array<{ role: string; content: unknown }> };
		expect(resumed.messages.at(-1)).toMatchObject({
			role: "user",
			content: [expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_01", content: "3 entities" })],
		});

		// The host saw the call as it happened, in order, with its outcome.
		const toolEvents = run.events.filter((e) => e.type === "tool_call_start" || e.type === "tool_call_end");
		expect(toolEvents).toEqual([
			{ type: "tool_call_start", toolCallId: "toolu_01", name: "query_sdk", args: { code: "entities.count()" } },
			{ type: "tool_call_end", toolCallId: "toolu_01", name: "query_sdk", isError: false, output: "3 entities" },
		]);

		// The transcript the next turn resumes from carries the call and its result.
		const roles = run.output.messages.map((m) => (m as { role: string }).role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(run.output.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "toolu_01", toolName: "query_sdk", isError: false });

		// One credential, one host: the audit line is written once per
		// (placeholder, host), so the tool call adds no second line — the bearer
		// hit above is the evidence it was spent there too.
		const spends = run.logs.filter((l) => l.line.startsWith("credential ")).map((l) => l.line.replace(/^credential [0-9a-f]{12} /, ""));
		expect(spends).toEqual(["spent on 127.0.0.1 in header x-api-key"]);
	}, 120_000);

	it("hands a refused tool call to the model as an error result and lets the turn finish", async () => {
		hits = [];
		toolScript = [{ id: "toolu_01", name: "query_sdk", input: { code: "entities.count()" } }];
		// What the gateway answers when the agent's policy gates the tool behind
		// an approval: a 403 with the text the subprocess lane's plugin shows.
		toolReply = {
			status: 403,
			body: { content: [{ type: "text", text: "Tool call requires approval. The user has been asked to approve." }], isError: true },
		};
		armFirstDeltaGate();
		const run = await runTurn(toolJob());

		expect(run.output.text).toBe("Hello from the isolate");
		const end = run.events.find((e) => e.type === "tool_call_end") as { isError: boolean; output: string } | undefined;
		expect(end?.isError).toBe(true);
		expect(end?.output).toContain("Tool call requires approval");
		const resumed = JSON.parse(hits[2]?.body ?? "{}") as { messages: Array<{ content: unknown }> };
		expect(resumed.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ type: "tool_result", is_error: true })],
		});
	}, 120_000);

	it("runs the workspace tools inside the isolate: bash writes, read sees it, and nothing leaves the guest", async () => {
		hits = [];
		toolScript = [
			{ id: "toolu_b1", name: "bash", input: { command: "echo hello > notes.txt && wc -c notes.txt" } },
			{ id: "toolu_r1", name: "read", input: { file_path: "notes.txt" } },
			{ id: "toolu_f1", name: "find", input: { pattern: "*.txt" } },
		];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				tools: {
					gatewayUrl: `http://127.0.0.1:${port}/lobu`,
					definitions: [],
					builtin: ["bash", "read", "write", "ls", "find"],
					bashPolicy: { allowAll: false, allowPrefixes: [], denyPrefixes: ["rm "] },
				},
			}),
		);

		expect(run.output.text).toBe("Hello from the isolate");
		// Four provider rounds and not one other request: the tools never left the isolate.
		expect(hits.map((h) => h.url)).toEqual(["/v1/messages", "/v1/messages", "/v1/messages", "/v1/messages"]);
		const offered = JSON.parse(hits[0]?.body ?? "{}") as { tools?: Array<{ name: string }> };
		expect(offered.tools?.map((t) => t.name)).toEqual(["bash", "read", "write", "ls", "find"]);

		const ends = run.events.filter((e) => e.type === "tool_call_end") as Array<{ name: string; isError: boolean; output: string }>;
		expect(ends.map((e) => [e.name, e.isError, e.output])).toEqual([
			["bash", false, "6 notes.txt\n"],
			["read", false, "hello\n"],
			["find", false, "notes.txt"],
		]);
		const roles = run.output.messages.map((m) => (m as { role: string }).role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
	}, 120_000);

	/** A turn carrying the conversation plugin's tools, addressed at one conversation. */
	function gatewayToolJob(gateway: string[], overrides: Partial<AgentTurnInput> = {}): ExecutorJob {
		return turnJob({
			tools: {
				gatewayUrl: `http://127.0.0.1:${port}/lobu`,
				definitions: [],
				gateway: gateway as never,
				conversation: { channelId: "C_TEST", conversationId: "conv_test", platform: "slack" },
			},
			...overrides,
		});
	}

	it("runs the conversation plugin's own tools in the guest, on the same route and the same one credential", async () => {
		hits = [];
		internalReply = { status: 200, body: { success: true } };
		toolScript = [
			{
				id: "toolu_s1",
				name: "suggest_actions",
				input: { prompts: [{ title: "Next", message: "What should I do next?" }] },
			},
		];
		armFirstDeltaGate();
		const run = await runTurn(gatewayToolJob(["suggest_actions", "send_message"]));

		expect(run.output.text).toBe("Hello from the isolate");
		// The model was offered exactly the two the producer named, with the
		// descriptions the plugin package ships — not a copy written here. The
		// ORDER is the plugin's own declaration order, not the producer's
		// request order: the guest selects out of `createConversationTools`
		// rather than rebuilding the list, which is what keeps one tool set.
		const offered = JSON.parse(hits[0]?.body ?? "{}") as { tools?: Array<{ name: string; description: string }> };
		expect(offered.tools?.map((t) => t.name)).toEqual(["send_message", "suggest_actions"]);
		expect(offered.tools?.find((t) => t.name === "suggest_actions")?.description).toContain("chip");

		// The call went to the gateway's own internal route — the plugin's route,
		// not the MCP proxy's — under the same bearer the provider hop resolves.
		expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual([
			"POST /v1/messages",
			"POST /lobu/internal/suggestions/create",
			"POST /v1/messages",
		]);
		expect(hits[1]?.authorization).toBe(`Bearer ${GATEWAY_PLACEHOLDER}`);
		expect(JSON.parse(hits[1]?.body ?? "{}")).toEqual({
			prompts: [{ title: "Next", message: "What should I do next?" }],
		});

		// And the model got the plugin's own result prose back.
		const end = run.events.find((e) => e.type === "tool_call_end") as { isError: boolean; output: string } | undefined;
		expect(end?.isError).toBe(false);
		expect(end?.output).toContain("Posted 1 suggested action(s)");
	}, 120_000);

	it("reports an in-band reply, so the terminal delivery is not the same answer twice", async () => {
		hits = [];
		// The gateway's send route matched the target against this run's own
		// conversation, so it says the post landed IN BAND. On the subprocess lane
		// this is what sets `repliedInBand` and suppresses the terminal reply; the
		// isolate lane must reach the same place through the same plugin hook.
		internalReply = { status: 200, body: { messageId: "m_inband", deliveredInBand: true } };
		toolScript = [
			{ id: "toolu_ib1", name: "send_message", input: { target: "conv_test", text: "Here is the summary." } },
		];
		armFirstDeltaGate();
		const run = await runTurn(gatewayToolJob(["send_message"]));

		expect(hits[1]?.url).toBe("/lobu/internal/conversations/send");
		// The guest carries the plugin's own signal out on the turn result, which
		// is what the completion route stamps onto the terminal thread_response.
		expect(run.output.repliedInBand).toBe(true);
		// And the model is told not to repeat it, by the plugin's own prose.
		const end = run.events.find((e) => e.type === "tool_call_end") as { output: string } | undefined;
		expect(end?.output).toContain("This in-band post is your reply for the turn");
	}, 120_000);

	it("leaves an out-of-band send unmarked, so a normal reply is still delivered", async () => {
		hits = [];
		// A post into a DIFFERENT conversation: the user reading THIS thread has
		// not seen it, so the terminal reply must still arrive.
		internalReply = { status: 200, body: { messageId: "m_other", deliveredInBand: false } };
		toolScript = [
			{ id: "toolu_ib2", name: "send_message", input: { target: "some_other_thread", text: "FYI" } },
		];
		armFirstDeltaGate();
		const run = await runTurn(gatewayToolJob(["send_message"]));

		expect(run.output.text).toBe("Hello from the isolate");
		expect(run.output.repliedInBand).toBeUndefined();
	}, 120_000);

	it("ends the turn when the model asks the user a question", async () => {
		hits = [];
		internalReply = { status: 200, body: { id: "int_ask" } };
		// The model tries to keep working after asking. It must not get to.
		toolScript = [
			{ id: "toolu_a1", name: "ask_user", input: { question: "Which one?", options: ["A", "B"] } },
			{ id: "toolu_a2", name: "suggest_actions", input: { prompts: [{ title: "T", message: "M" }] } },
		];
		armFirstDeltaGate();
		const run = await runTurn(gatewayToolJob(["ask_user", "suggest_actions"]));

		expect(hits[1]?.url).toBe("/lobu/internal/interactions/create");
		expect(JSON.parse(hits[1]?.body ?? "{}")).toEqual({
			interactionType: "question",
			question: "Which one?",
			options: ["A", "B"],
		});

		// The second tool call was refused rather than run: no second internal hit.
		expect(hits.filter((h) => h.url.startsWith("/lobu/internal/")).length).toBe(1);
		const ends = run.events.filter((e) => e.type === "tool_call_end") as Array<{ name: string; isError: boolean; output: string }>;
		expect(ends[0]?.name).toBe("ask_user");
		expect(ends[0]?.output).toContain("Your turn is now ending");
		expect(ends[1]?.isError).toBe(true);
		expect(ends[1]?.output).toContain("already asked the user a question");
	}, 120_000);

	it("hands a failed gateway tool to the model as text and lets the turn finish", async () => {
		hits = [];
		internalReply = { status: 500, body: { error: "interaction service unavailable" } };
		toolScript = [{ id: "toolu_a3", name: "ask_user", input: { question: "Which one?", options: ["A"] } }];
		armFirstDeltaGate();
		const run = await runTurn(gatewayToolJob(["ask_user"]));

		expect(run.output.text).toBe("Hello from the isolate");
		// The plugin answers a failure as an ordinary text result, so the turn
		// continues and is NOT ended by an ask_user that never posted.
		const end = run.events.find((e) => e.type === "tool_call_end") as { isError: boolean; output: string } | undefined;
		expect(end?.output).toContain("interaction service unavailable");
	}, 120_000);

	it("puts an image attachment on the wire as the provider's own image block", async () => {
		hits = [];
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				userMessage: "what is in this?",
				provider: {
					api: "anthropic-messages",
					provider: "anthropic",
					modelId: "claude-test",
					baseUrl: `http://127.0.0.1:${port}`,
					maxTokens: 64,
					// pi-ai's own `Model.input`, resolved by the gateway from its
					// model registry. Without "image" pi downgrades the block.
					input: ["text", "image"],
				},
				images: [{ mimeType: "image/png", data: PNG_BASE64 }],
			}),
		);

		expect(run.output.text).toBe("Hello from the isolate");
		const sent = JSON.parse(hits.at(-1)?.body ?? "{}") as {
			messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
		};
		// `cache_control` is the adapter's own prompt-caching stamp on the last
		// block; the shape under test is the text-then-image pair.
		expect(sent.messages[0]?.content).toMatchObject([
			{ type: "text", text: "what is in this?" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
		]);
	}, 120_000);

	it("sends an attachment-only turn as a valid request: an image block and no empty text block", async () => {
		hits = [];
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				// What the composer produces when the user uploads and says nothing.
				userMessage: "",
				provider: {
					api: "anthropic-messages",
					provider: "anthropic",
					modelId: "claude-test",
					baseUrl: `http://127.0.0.1:${port}`,
					maxTokens: 64,
					input: ["text", "image"],
				},
				images: [{ mimeType: "image/png", data: PNG_BASE64 }],
			}),
		);

		expect(run.output.text).toBe("Hello from the isolate");
		const sent = JSON.parse(hits.at(-1)?.body ?? "{}") as {
			messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
		};
		const content = sent.messages[0]?.content ?? [];
		// pi-ai's Anthropic adapter supplies the placeholder an image-only user
		// turn needs. What must NOT be there is an EMPTY text block, which is
		// what `Agent.prompt(text, images)` would have produced and which the
		// provider rejects with a 400.
		expect(content.some((block) => block.type === "text" && block.text === "")).toBe(false);
		expect(content.filter((block) => block.type === "image")).toMatchObject([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
		]);
		// The whole user turn is the image, and that is a valid request: Lobu
		// invents no prose the user never wrote.
		expect(content.length).toBe(1);
	}, 120_000);

	it("sends no image to a model whose declared modalities do not include one", async () => {
		hits = [];
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				userMessage: "what is in this?",
				// The lane's default when the gateway resolved no modalities: text
				// only. `input` is deliberately omitted here rather than set to
				// ["text"], so the guest's own default is what is under test.
				images: [{ mimeType: "image/png", data: PNG_BASE64 }],
			}),
		);

		expect(run.output.text).toBe("Hello from the isolate");
		const sent = JSON.parse(hits.at(-1)?.body ?? "{}") as {
			messages: Array<{ role: string; content: unknown }>;
		};
		const body = hits.at(-1)?.body ?? "";
		// pi replaces the block with its own placeholder before the request is
		// built, so the bytes never leave the isolate.
		expect(body).not.toContain(PNG_BASE64);
		expect(JSON.stringify(sent.messages[0]?.content)).toContain("model does not support images");
	}, 120_000);

	it("names a non-image attachment for the model without sending anything it cannot open", async () => {
		hits = [];
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				userMessage: "summarize this",
				files: [{ name: "report.pdf", mimeType: "application/pdf", size: 2048 }],
			}),
		);

		expect(run.output.text).toBe("Hello from the isolate");
		const sent = JSON.parse(hits.at(-1)?.body ?? "{}") as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		// One text block: what the user said, then what they attached. No image
		// block and no bytes, because this lane cannot open a PDF and says so
		// rather than pretending the attachment was not there.
		expect(sent.messages[0]?.content).toMatchObject([
			{
				type: "text",
				text: "summarize this\n\nThe user attached 1 non-image file(s) that this turn cannot open:\n- report.pdf (application/pdf)",
			},
		]);
	}, 120_000);

	it("fails a turn that reached the guest with neither text nor a readable attachment", async () => {
		hits = [];
		toolScript = [];
		const { error } = await failTurn(turnJob({ userMessage: "" }), ["127.0.0.1"]);

		expect(error.message).toContain("neither text nor a readable attachment");
		// It never reached the provider, so no invalid request was ever made.
		expect(hits.length).toBe(0);
	// ---------------------------------------------------------------------
	// lobu-memory: the plugin's two hooks, on this lane
	// ---------------------------------------------------------------------

	/** A turn that recalls and captures, addressed at the fake memory server. */
	function memoryJob(overrides: Partial<AgentTurnInput> = {}): ExecutorJob {
		return turnJob({
			userMessage: "what did we decide about pricing?",
			tools: {
				gatewayUrl: `http://127.0.0.1:${port}/lobu`,
				definitions: [],
				conversation: { channelId: "C_TEST", conversationId: "conv_test", platform: "slack" },
			},
			memory: { mcpId: MEMORY_MCP_ID, agentId: "agent-under-test" },
			...overrides,
		});
	}

	it("recalls memory before the model runs and injects the plugin's own block", async () => {
		hits = [];
		memoryCalls = [];
		memoryReplies = {
			search_memory: { status: 200, body: { content: [{ type: "text", text: "We settled on usage-based pricing." }] } },
			save_memory: { status: 200, body: { content: [{ type: "text", text: "saved" }] } },
		};
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(memoryJob());

		expect(run.output.text).toBe("Hello from the isolate");

		// The recall went out on the MCP route, as `search_memory`, with the
		// plugin's own bounded arguments — not a query this test wrote.
		const recall = memoryCalls.find((c) => c.tool === "search_memory");
		expect(recall).toBeDefined();
		expect(recall?.body).toMatchObject({
			query: "what did we decide about pricing?",
			include_content: true,
			content_limit: 6,
			include_connections: false,
			limit: 3,
		});

		// And what it recalled reached the MODEL, inside the plugin's own
		// <lobu-memory> envelope, ahead of what the human said.
		const provider = hits.find((h) => h.url === "/v1/messages");
		const sent = JSON.parse(provider?.body ?? "{}") as { messages: Array<{ content: unknown }> };
		const firstUserText = JSON.stringify(sent.messages[0]?.content);
		expect(firstUserText).toContain("<lobu-memory>");
		expect(firstUserText).toContain("We settled on usage-based pricing.");
		expect(firstUserText).toContain("what did we decide about pricing?");
	}, 120_000);

	/**
	 * THE REGRESSION THIS LANE WOULD OTHERWISE HAVE. `agentEnd` starts the
	 * `save_memory` write and returns without awaiting it, which is correct on
	 * the subprocess lane (the worker process outlives the turn) and lossy here:
	 * the isolate is disposed the moment `runAgentTurn` resolves. If the capture
	 * were still fire-and-forget, this request would never arrive.
	 */
	it("captures the exchange and the write COMPLETES before the isolate is disposed", async () => {
		hits = [];
		memoryCalls = [];
		memoryReplies = {
			search_memory: { status: 200, body: { content: [{ type: "text", text: "prior context" }] } },
			save_memory: { status: 200, body: { content: [{ type: "text", text: "saved" }] } },
		};
		toolScript = [];
		armFirstDeltaGate();
		await runTurn(memoryJob());

		const save = memoryCalls.find((c) => c.tool === "save_memory");
		expect(save).toBeDefined();
		expect(save?.body).toMatchObject({ semantic_type: "observation", metadata: { agent_id: "agent-under-test" } });
		const content = String(save?.body.content);
		expect(content).toContain("User: what did we decide about pricing?");
		expect(content).toContain("Assistant: Hello from the isolate");
		// The recall block the hook injected must NOT be saved back: the plugin
		// strips its own envelope so memory does not eat its own output.
		expect(content).not.toContain("<lobu-memory>");
		expect(content).not.toContain("prior context");

		// Capture happens after the answer, so the save is the LAST memory call.
		expect(memoryCalls.map((c) => c.tool)).toEqual(["search_memory", "save_memory"]);
	}, 120_000);

	it("still answers when memory is down, and says so in the run log rather than failing the turn", async () => {
		hits = [];
		memoryCalls = [];
		memoryReplies = {
			search_memory: { status: 500, body: { error: "memory server unavailable" } },
			save_memory: { status: 500, body: { error: "memory server unavailable" } },
		};
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(memoryJob());

		// The user still got their answer — memory is best-effort on both lanes.
		expect(run.output.text).toBe("Hello from the isolate");
		// Both hooks ran and both failed; neither was swallowed silently.
		expect(memoryCalls.map((c) => c.tool)).toEqual(["search_memory", "save_memory"]);
		const lines = run.logs.map((l) => l.line).join("\n");
		expect(lines).toMatch(/memory (recall skipped|capture failed)/i);
		// No <lobu-memory> block reached the model, because nothing was recalled.
		const provider = hits.find((h) => h.url === "/v1/messages");
		expect(provider?.body).not.toContain("<lobu-memory>");
	}, 120_000);

	it("runs no memory hook at all for a turn that carries no memory", async () => {
		hits = [];
		memoryCalls = [];
		toolScript = [];
		armFirstDeltaGate();
		const run = await runTurn(turnJob());
		expect(run.output.text).toBe("Hello from the isolate");
		expect(memoryCalls).toEqual([]);
	}, 120_000);

	// ---------------------------------------------------------------------
	// lobu-media: the plugin's three tools, on this lane
	// ---------------------------------------------------------------------

	/** A turn carrying the media tools plus a workspace to produce files in. */
	function mediaJob(media: string[], builtin: string[] = ["bash", "write", "read", "ls"]): ExecutorJob {
		return turnJob({
			tools: {
				gatewayUrl: `http://127.0.0.1:${port}/lobu`,
				definitions: [],
				builtin: builtin as never,
				media: media as never,
				conversation: { channelId: "C_TEST", conversationId: "conv_test", platform: "slack" },
			},
		});
	}

	it("uploads a file the model wrote in ITS OWN in-memory workspace, as a real multipart file part", async () => {
		hits = [];
		uploads = [];
		uploadReply = {
			status: 200,
			body: { fileId: "file_iso", name: "report.csv", permalink: "https://files.test/iso" },
		};
		toolScript = [
			{ id: "toolu_w1", name: "bash", input: { command: "printf 'a,b\\n1,2\\n' > report.csv" } },
			{ id: "toolu_u1", name: "upload_file", input: { file_path: "report.csv", description: "The numbers" } },
		];
		armFirstDeltaGate();
		const run = await runTurn(mediaJob(["upload_file"]));

		expect(run.output.text).toBe("Hello from the isolate");
		// The model was offered the plugin's own tool, with the plugin's schema.
		const offered = JSON.parse(hits[0]?.body ?? "{}") as { tools?: Array<{ name: string }> };
		expect(offered.tools?.map((t) => t.name)).toContain("upload_file");

		// ONE upload, carrying the bytes `bash` wrote INSIDE the isolate — proof
		// the read port reads the turn's own filesystem, not the host's.
		expect(uploads.length).toBe(1);
		const upload = uploads[0] as UploadHit;
		expect(upload.fileName).toBe("report.csv");
		expect(upload.fileType).toBe("text/csv");
		expect(upload.fileBytes.toString("utf8")).toBe("a,b\n1,2\n");
		expect(upload.filename).toBe("report.csv");
		expect(upload.comment).toBe("The numbers");
		// Same one credential and the same conversation routing as every other
		// call this turn makes.
		expect(upload.authorization).toBe(`Bearer ${GATEWAY_PLACEHOLDER}`);
		expect(upload.channelId).toBe("C_TEST");
		expect(upload.conversationId).toBe("conv_test");

		// The model got the plugin's own success prose, and the host saw the
		// delivery as a turn event.
		const end = run.events.find((e) => e.type === "tool_call_end" && e.name === "upload_file") as
			| { isError: boolean; output: string }
			| undefined;
		expect(end?.isError).toBe(false);
		expect(end?.output).toContain("Successfully showed report.csv to the user");
		const uploaded = run.events.find((e) => e.type === "file_uploaded") as { data: Record<string, unknown> } | undefined;
		expect(uploaded?.data).toMatchObject({ tool: "upload_file", fileId: "file_iso", platform: "slack", size: 8 });
	}, 120_000);

	it("keeps upload_file inside the workspace and refuses what `read` would refuse", async () => {
		hits = [];
		uploads = [];
		toolScript = [
			{ id: "toolu_e1", name: "upload_file", input: { file_path: "../../etc/passwd" } },
			{ id: "toolu_e2", name: "upload_file", input: { file_path: "/etc/passwd" } },
			{ id: "toolu_e3", name: "upload_file", input: { file_path: "missing.txt" } },
			{ id: "toolu_e4", name: "bash", input: { command: ": > empty.txt" } },
			{ id: "toolu_e5", name: "upload_file", input: { file_path: "empty.txt" } },
		];
		armFirstDeltaGate();
		const run = await runTurn(mediaJob(["upload_file"]));

		// Not one of them reached the gateway.
		expect(uploads).toEqual([]);
		const ends = run.events.filter((e) => e.type === "tool_call_end") as Array<{ name: string; output: string }>;
		const outputs = ends.filter((e) => e.name === "upload_file").map((e) => e.output);
		expect(outputs[0]).toContain("Refusing to upload file outside workspace");
		// An absolute path outside /workspace is the same refusal, even though
		// just-bash's in-memory tree really does have an /etc.
		expect(outputs[1]).toContain("Refusing to upload file outside workspace");
		expect(outputs[2]).toContain("not found or is not a file");
		expect(outputs[3]).toContain("Cannot show empty file");
	}, 120_000);

	it("does not offer upload_file to a turn with no workspace to read from", async () => {
		hits = [];
		toolScript = [];
		armFirstDeltaGate();
		await runTurn(
			turnJob({
				tools: {
					gatewayUrl: `http://127.0.0.1:${port}/lobu`,
					definitions: [],
					media: ["upload_file", "generate_image"] as never,
					conversation: { channelId: "C_TEST", conversationId: "conv_test", platform: "slack" },
				},
			}),
		);
		const offered = JSON.parse(hits[0]?.body ?? "{}") as { tools?: Array<{ name: string }> };
		// `generate_image` needs no filesystem, so it stays; `upload_file` would
		// only ever fail, so it is not offered at all.
		expect(offered.tools?.map((t) => t.name)).toEqual(["generate_image"]);
	}, 120_000);

	it("generates media and sends the provider's bytes straight through, with no temp file", async () => {
		hits = [];
		uploads = [];
		uploadReply = { status: 200, body: { fileId: "file_img", name: "generated_image.png", permalink: "https://files.test/img" } };
		// The generation endpoints answer binary; `internalReply` covers the
		// capabilities preflight.
		internalReply = { status: 200, body: { available: true } };
		toolScript = [{ id: "toolu_g1", name: "generate_image", input: { prompt: "a fox" } }];
		armFirstDeltaGate();
		const run = await runTurn(mediaJob(["generate_image"]));

		expect(uploads.length).toBe(1);
		const upload = uploads[0] as UploadHit;
		expect(upload.fileName).toBe("generated_image.png");
		expect(upload.fileType).toBe("image/png");
		// The exact bytes the fake provider emitted, including the 0x00 and 0x89
		// that no UTF-8 round trip would survive.
		expect([...upload.fileBytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		expect(upload.comment).toBe("Generated content");
		const end = run.events.find((e) => e.type === "tool_call_end" && e.name === "generate_image") as
			| { isError: boolean; output: string }
			| undefined;
		expect(end?.isError).toBe(false);
		expect(end?.output).toContain("Image sent successfully");
	}, 120_000);

	/**
	 * A media upload is not exempt from the lane's deny-all egress policy. The
	 * turn's provider host stays reachable — so the model runs and the tool is
	 * actually called — while the upload is addressed at a DIFFERENT host that
	 * the allowlist does not carry. The refusal must come from the same egress
	 * module every other request on this lane goes through, be legible in the
	 * run log, and reach the model as a tool error rather than killing the turn.
	 */
	it("enforces the same egress policy on a media upload: the gateway host and nothing else", async () => {
		hits = [];
		uploads = [];
		toolScript = [
			{ id: "toolu_p1", name: "bash", input: { command: "echo hi > note.txt" } },
			{ id: "toolu_p2", name: "upload_file", input: { file_path: "note.txt" } },
		];
		armFirstDeltaGate();
		const job = turnJob({
			tools: {
				// A host the run's allowlist does not name. Everything else about
				// the turn is unchanged.
				gatewayUrl: "http://gateway.invalid/lobu",
				definitions: [],
				builtin: ["bash"] as never,
				media: ["upload_file"] as never,
				conversation: { channelId: "C_TEST", conversationId: "conv_test", platform: "slack" },
			},
		});
		const run = await runTurn(job, ["127.0.0.1"]);

		// The turn still finished: a refused upload is a failed TOOL, not a
		// failed run.
		expect(run.output.text).toBe("Hello from the isolate");
		// Nothing was delivered, and the refusal is named in the run log.
		expect(uploads).toEqual([]);
		expect(run.logs).toContainEqual({
			level: "warn",
			line: "egress denied: fetch to gateway.invalid is not permitted (this run may reach: 127.0.0.1)",
		});
		// And the model was told, in the plugin's own error wording.
		const end = run.events.find((e) => e.type === "tool_call_end" && e.name === "upload_file") as
			| { isError: boolean; output: string }
			| undefined;
		expect(end?.output).toContain("Error");
	}, 120_000);

	/**
	 * The memory hooks and the media upload are two more requests on the turn's
	 * ONE credential, and the same vault indirection covers them: the guest only
	 * ever holds a per-run placeholder, the host swaps in the gateway's, and no
	 * run log line prints either secret.
	 */
	it("carries the turn's one credential through the memory and media paths, and never logs it", async () => {
		hits = [];
		uploads = [];
		memoryCalls = [];
		memoryReplies = {
			search_memory: { status: 200, body: { content: [{ type: "text", text: "recalled" }] } },
			save_memory: { status: 200, body: { content: [{ type: "text", text: "saved" }] } },
		};
		uploadReply = { status: 200, body: { fileId: "f1", name: "note.txt", permalink: "p" } };
		toolScript = [
			{ id: "toolu_c1", name: "bash", input: { command: "echo hi > note.txt" } },
			{ id: "toolu_c2", name: "upload_file", input: { file_path: "note.txt" } },
		];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				tools: {
					gatewayUrl: `http://127.0.0.1:${port}/lobu`,
					definitions: [],
					builtin: ["bash"] as never,
					media: ["upload_file"] as never,
					conversation: { channelId: "C_TEST", conversationId: "conv_test", platform: "slack" },
				},
				memory: { mcpId: MEMORY_MCP_ID, agentId: "agent-under-test" },
			}),
		);

		// Every hop upstream authenticates with the gateway's placeholder — the
		// model call, both memory calls, and the upload.
		const memoryHits = hits.filter((h) => h.url.includes("/tools/search_memory") || h.url.includes("/tools/save_memory"));
		expect(memoryHits.length).toBe(2);
		for (const hit of memoryHits) expect(hit.authorization).toBe(`Bearer ${GATEWAY_PLACEHOLDER}`);
		expect(uploads[0]?.authorization).toBe(`Bearer ${GATEWAY_PLACEHOLDER}`);

		// And NOTHING the host logged contains either the gateway's credential
		// or the per-run placeholder the guest actually held.
		const logText = run.logs.map((l) => l.line).join("\n");
		expect(logText).not.toContain(GATEWAY_PLACEHOLDER);
		expect(logText).not.toMatch(/lobu_secret_[0-9a-f-]{36}/);
		// The one credential line that IS emitted is the redacted audit digest.
		for (const line of run.logs.filter((l) => l.line.startsWith("credential "))) {
			expect(line.line).toMatch(/^credential [0-9a-f]{12} spent on /);
		}
	}, 120_000);

	it("enforces the bash policy inside the guest and starts every turn from an empty workspace", async () => {
		hits = [];
		toolScript = [
			{ id: "toolu_b2", name: "bash", input: { command: "rm -rf /workspace" } },
			{ id: "toolu_l1", name: "ls", input: {} },
		];
		armFirstDeltaGate();
		const run = await runTurn(
			turnJob({
				tools: {
					gatewayUrl: `http://127.0.0.1:${port}/lobu`,
					definitions: [],
					builtin: ["bash", "ls"],
					bashPolicy: { allowAll: false, allowPrefixes: [], denyPrefixes: ["rm "] },
				},
			}),
		);
		const ends = run.events.filter((e) => e.type === "tool_call_end") as Array<{ name: string; isError: boolean; output: string }>;
		expect(ends[0]).toMatchObject({ name: "bash", isError: true });
		expect(ends[0]?.output).toContain("Bash command denied by policy");
		// The previous test wrote notes.txt; this turn's workspace never saw it.
		expect(ends[1]).toEqual({ type: "tool_call_end", toolCallId: "toolu_l1", name: "ls", isError: false, output: "(empty directory)" });
	}, 120_000);
});
