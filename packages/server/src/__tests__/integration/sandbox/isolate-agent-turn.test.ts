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
			const body = Buffer.concat(chunks).toString("utf8");
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
