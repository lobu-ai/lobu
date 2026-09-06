/**
 * The daemon arm for an agent turn.
 *
 * The run is ALREADY CLAIMED by the time this arm sees it, so the property
 * under test everywhere here is the same one: every exit reports to
 * `/complete-agent-turn`. An arm that returned an error locally instead would
 * leave the turn `running` until the stale-run reaper writes it off minutes
 * later — the failure looks like a hang rather than a failure.
 */
import { describe, expect, test } from "bun:test";
import {
  type PollResponse,
  TURN_DELTA_MAX_CHARS,
} from "@lobu/core/contracts/worker/protocol";
import { executeAgentTurnRun } from "../daemon/agent-turn.js";
import { DEFAULT_CONFIG, type ExecutorConfig } from "../daemon/executor.js";
import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from "../executor/interface.js";
import type { CompleteAgentTurnRequest } from "../daemon/client.js";

const WORKER_ID = "fleet-test-worker";

/**
 * The heartbeat interval a fleet worker actually runs with. Read from the
 * shipped default rather than restated, because the streaming regression this
 * pins was invisible precisely to tests that overrode it.
 */
const PRODUCTION_HEARTBEAT_MS = DEFAULT_CONFIG.heartbeatIntervalMs;

interface Reported {
  calls: CompleteAgentTurnRequest[];
}

/** One heartbeat the arm sent, and what it carried. */
interface HeartbeatCall {
  turnDelta?: { text: string; sequence: number };
  toolEvents?: Array<{ tool_call_id: string; name: string; is_error: boolean; output: string }>;
}

/**
 * How the fake gateway answers a delta batch.
 *
 * The arm retires a batch only on an ack naming ITS sequence, so this is the
 * knob every streaming test turns: `ack` is the healthy gateway, `silent` is
 * one that published nothing it will admit to, `throw` is one that is down.
 */
type DeltaAck = "ack" | "silent" | "throw";

/**
 * The narrow slice of `ExecutorClient` this arm touches. Typed through
 * `unknown` rather than stubbing the whole client: what matters is which
 * endpoint gets called with what, not the transport.
 */
function fakeClient(
  reported: Reported,
  beats?: HeartbeatCall[],
  ackMode: DeltaAck | ((beat: number) => DeltaAck) = "ack"
) {
  let beatCount = 0;
  return {
    id: WORKER_ID,
    heartbeat: async (
      _runId: number,
      _progress?: unknown,
      _agentSession?: unknown,
      turnDelta?: { text: string; sequence: number },
      toolEvents?: Array<{ tool_call_id: string; name: string; is_error: boolean; output: string }>
    ) => {
      beats?.push({ turnDelta, toolEvents });
      const mode = typeof ackMode === "function" ? ackMode(beatCount) : ackMode;
      beatCount += 1;
      if (mode === "throw") throw new Error("gateway unreachable");
      if (mode === "silent" || !turnDelta) return { continue: true };
      return {
        continue: true,
        turn_delta_ack: { sequence: turnDelta.sequence, published: true },
      };
    },
    completeAgentTurn: async (req: CompleteAgentTurnRequest) => {
      reported.calls.push(req);
      return { ok: true as const, status: "completed" as const };
    },
  };
}

/** Everything the client would have appended, in beat order. */
function reconstruct(beats: HeartbeatCall[]): string {
  return beats.map((beat) => beat.turnDelta?.text ?? "").join("");
}

function turnJob(overrides: Record<string, unknown> = {}): PollResponse {
  return {
    run_id: 4242,
    run_type: "agent_turn",
    credentials: { provider: "anthropic", accessToken: "lobu_secret_placeholder" },
    payload: {
      turn: {
        agent_id: "agent-under-test",
        conversation_id: "conv-1",
        message_id: "msg-1",
        message_text: "hello",
        system_prompt: "be brief",
        messages: [],
        provider: {
          api: "anthropic-messages",
          provider: "anthropic",
          model_id: "claude-test",
          base_url: "https://gateway.test.invalid/api/proxy/anthropic",
        },
        allowed_hosts: ["gateway.test.invalid"],
        shadow: true,
      },
    },
    ...overrides,
  } as unknown as PollResponse;
}

function cfgWith(executor: SyncExecutor | undefined): ExecutorConfig {
  return {
    batchSize: 10,
    // Long enough that no heartbeat fires inside a test.
    heartbeatIntervalMs: 60_000,
    generateEmbeddings: false,
    timeoutMs: 30_000,
    ...(executor ? { executor } : {}),
  };
}

function executorReturning(result: ExecutorResult): SyncExecutor {
  return {
    execute: async (_code: string, _job: ExecutorJob, _hooks?: ExecutionHooks) => result,
  };
}

describe("executeAgentTurnRun", () => {
  test("reports the transcript the guest produced", async () => {
    const reported: Reported = { calls: [] };
    const transcript = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const executor = executorReturning({
      mode: "agent_turn",
      turn: {
        text: "hi",
        stopReason: "stop",
        usage: { input: 3, output: 1 },
        messages: transcript,
      },
    });

    const outcome = await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob(),
      {},
      cfgWith(executor)
    );

    expect(outcome.error).toBeUndefined();
    expect(reported.calls).toHaveLength(1);
    expect(reported.calls[0]).toMatchObject({
      run_id: 4242,
      worker_id: WORKER_ID,
      status: "completed",
      text: "hi",
      stop_reason: "stop",
      exit_reason: "ok",
      transcript,
    });
  });

  test("hands the guest the job the gateway described, and only its allowed hosts", async () => {
    const reported: Reported = { calls: [] };
    let seen: ExecutorJob | undefined;
    const executor: SyncExecutor = {
      execute: async (_code, job) => {
        seen = job;
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    await executeAgentTurnRun(fakeClient(reported) as never, turnJob(), {}, cfgWith(executor));

    expect(seen?.mode).toBe("agent_turn");
    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    expect(seen.turn.provider).toEqual({
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-test",
      baseUrl: "https://gateway.test.invalid/api/proxy/anthropic",
    });
    expect(seen.turn.systemPrompt).toBe("be brief");
    expect(seen.turn.userMessage).toBe("hello");
    // A turn without tools reaches the guest without a manifest, not with an
    // empty one: the guest builds its tool list off the field's presence.
    expect(seen.turn.tools).toBeUndefined();
    // The provider key never appears on the turn: it rides `credentials`, and
    // the host swaps a vault placeholder over it before the guest sees it.
    expect(seen.turn.provider.apiKey).toBeUndefined();
    expect(seen.credentials?.accessToken).toBe("lobu_secret_placeholder");
  });

  test("hands the guest the tool manifest in the guest's own shape", async () => {
    const reported: Reported = { calls: [] };
    let seen: ExecutorJob | undefined;
    const executor: SyncExecutor = {
      execute: async (_code, job) => {
        seen = job;
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };
    const job = turnJob();
    (job.payload as { turn: Record<string, unknown> }).turn.tools = {
      gateway_url: "https://gateway.test.invalid/lobu",
      definitions: [
        {
          mcp_id: "lobu-memory",
          name: "query_sdk",
          description: "Read data",
          input_schema: { type: "object", properties: { code: { type: "string" } } },
        },
      ],
      builtin: ["bash", "read"],
      bash_policy: { allow_all: false, allow_prefixes: ["git "], deny_prefixes: ["rm "] },
    };

    await executeAgentTurnRun(fakeClient(reported) as never, job, {}, cfgWith(executor));

    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    expect(seen.turn.tools).toEqual({
      gatewayUrl: "https://gateway.test.invalid/lobu",
      definitions: [
        {
          mcpId: "lobu-memory",
          name: "query_sdk",
          description: "Read data",
          inputSchema: { type: "object", properties: { code: { type: "string" } } },
        },
      ],
      builtin: ["bash", "read"],
      bashPolicy: { allowAll: false, allowPrefixes: ["git "], denyPrefixes: ["rm "] },
    });
  });

  test("hands the guest the turn's attachments, and the model's own modalities, in the guest's shape", async () => {
  /**
   * The media tools and the memory hooks cross the same wire the gateway tools
   * do: names only for the tools, and two ids for the hooks. What is pinned
   * here is the MAPPING — snake_case envelope in, camelCase guest input out —
   * and the rule that the conversation travels with EITHER tool family, not
   * just the gateway one.
   */
  test("maps the media tools and the memory hooks onto the guest input", async () => {
    const reported: Reported = { calls: [] };
    let seen: ExecutorJob | undefined;
    const executor: SyncExecutor = {
      execute: async (_code, job) => {
        seen = job;
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };
    const job = turnJob();
    const turn = (job.payload as { turn: Record<string, unknown> }).turn;
    turn.message_images = [{ mime_type: "image/png", data: "aGVsbG8=" }];
    turn.message_files = [{ name: "report.pdf", mime_type: "application/pdf", size: 2048 }];
    (turn.provider as Record<string, unknown>).input = ["text", "image"];
    turn.tools = {
      gateway_url: "https://gateway.test.invalid/lobu",
      definitions: [],
      builtin: ["bash"],
      media: ["upload_file", "generate_image", "generate_audio"],
      conversation: { channel_id: "C1", conversation_id: "conv-1", platform: "slack" },
    };
    turn.memory = { mcp_id: "lobu", agent_id: "agent-under-test" };

    await executeAgentTurnRun(fakeClient(reported) as never, job, {}, cfgWith(executor));

    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    expect(seen.turn.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
    expect(seen.turn.files).toEqual([{ name: "report.pdf", mimeType: "application/pdf", size: 2048 }]);
    expect(seen.turn.provider.input).toEqual(["text", "image"]);
  });

  test("leaves attachments and modalities off the job when the envelope carries none", async () => {
    expect(seen.turn.tools).toEqual({
      gatewayUrl: "https://gateway.test.invalid/lobu",
      definitions: [],
      builtin: ["bash"],
      media: ["upload_file", "generate_image", "generate_audio"],
      // Carried even though this turn has no GATEWAY tools: the media tools
      // address a conversation too, and the guest must never infer routing.
      conversation: { channelId: "C1", conversationId: "conv-1", platform: "slack" },
    });
    expect(seen.turn.memory).toEqual({ mcpId: "lobu", agentId: "agent-under-test" });
  });

  test("drops the media names when the envelope carries no conversation to post into", async () => {
    const reported: Reported = { calls: [] };
    let seen: ExecutorJob | undefined;
    const executor: SyncExecutor = {
      execute: async (_code, job) => {
        seen = job;
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    await executeAgentTurnRun(fakeClient(reported) as never, turnJob(), {}, cfgWith(executor));

    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    // Absent, not empty: the guest's own default for `input` is text-only, and
    // an empty images array would read as "resolved to nothing" rather than
    // "there were none".
    expect("images" in seen.turn).toBe(false);
    expect("files" in seen.turn).toBe(false);
    expect("input" in seen.turn.provider).toBe(false);
    const job = turnJob();
    (job.payload as { turn: Record<string, unknown> }).turn.tools = {
      gateway_url: "https://gateway.test.invalid/lobu",
      definitions: [],
      media: ["upload_file"],
    };

    await executeAgentTurnRun(fakeClient(reported) as never, job, {}, cfgWith(executor));

    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    expect(seen.turn.tools).toEqual({
      gatewayUrl: "https://gateway.test.invalid/lobu",
      definitions: [],
    });
  });

  test("a turn with no memory field reaches the guest without one", async () => {
    const reported: Reported = { calls: [] };
    let seen: ExecutorJob | undefined;
    const executor: SyncExecutor = {
      execute: async (_code, job) => {
        seen = job;
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };
    await executeAgentTurnRun(fakeClient(reported) as never, turnJob(), {}, cfgWith(executor));
    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    expect("memory" in seen.turn).toBe(false);
  });

  test("reports a guest failure instead of returning it, because the run is claimed", async () => {
    const reported: Reported = { calls: [] };
    const executor: SyncExecutor = {
      execute: async () => {
        throw new Error("the isolate ran out of memory");
      },
    };

    const outcome = await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob(),
      {},
      cfgWith(executor)
    );

    expect(outcome.error).toBe("the isolate ran out of memory");
    expect(reported.calls).toEqual([
      {
        run_id: 4242,
        worker_id: WORKER_ID,
        status: "failed",
        error: "the isolate ran out of memory",
        exit_reason: "error_message",
      },
    ]);
  });

  test("reports a turn that arrived without its provider credential", async () => {
    const reported: Reported = { calls: [] };
    const outcome = await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob({ credentials: null }),
      {},
      cfgWith(executorReturning({ mode: "webhook_unregister" }))
    );

    expect(outcome.error).toBe("agent turn run arrived without its provider credential");
    expect(reported.calls).toHaveLength(1);
    expect(reported.calls[0]?.status).toBe("failed");
  });

  test("reports a payload that is not a turn", async () => {
    const reported: Reported = { calls: [] };
    const outcome = await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob({ payload: { chat: {} } }),
      {},
      cfgWith(executorReturning({ mode: "webhook_unregister" }))
    );

    expect(outcome.error).toBe("agent turn run received a non-turn payload envelope");
    expect(reported.calls).toHaveLength(1);
    expect(reported.calls[0]?.status).toBe("failed");
  });

  test("reports a result of the wrong mode rather than completing the turn", async () => {
    const reported: Reported = { calls: [] };
    const outcome = await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob(),
      {},
      cfgWith(executorReturning({ mode: "action", output: {} }))
    );

    expect(outcome.error).toBe("agent turn produced a action result");
    expect(reported.calls[0]?.status).toBe("failed");
  });

  test("beats while the turn runs so the stale-run reaper leaves it alone", async () => {
    const reported: Reported = { calls: [] };
    const beats: number[] = [];
    const client = {
      ...fakeClient(reported),
      heartbeat: async (runId: number) => {
        beats.push(runId);
      },
    };
    let release: (() => void) | undefined;
    const executor: SyncExecutor = {
      execute: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    const running = executeAgentTurnRun(client as never, turnJob(), {}, {
      ...cfgWith(executor),
      heartbeatIntervalMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.every((id) => id === 4242)).toBe(true);

    release?.();
    await running;
    // The interval is cleared on the way out, so a finished turn stops beating
    // and a crashed worker's row really does go stale.
    const settled = beats.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(beats.length).toBe(settled);
  });
});

describe("executeAgentTurnRun streaming", () => {
  /**
   * The guest streams; the arm has to get that text out of the worker while
   * the turn is still open, or the user watches a blank screen for the length
   * of the turn. It rides the heartbeat the arm already sends.
   */
  test("beats the reply INCREMENTALLY, so appending reconstructs it exactly", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    // The executor drives the guest's events and the clock: it emits, waits
    // for a beat, emits again, then finishes.
    const executor: SyncExecutor = {
      execute: async (_code, _job, hooks) => {
        const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
        hooks?.onTurnEvent?.({ type: "text_delta", delta: "the isolate" });
        await settle();
        hooks?.onTurnEvent?.({ type: "text_delta", delta: " lane answered" });
        await settle();
        // No new text: this beat must carry no delta rather than republish.
        await settle();
        return {
          mode: "agent_turn",
          turn: {
            text: "the isolate lane answered",
            stopReason: "stop",
            usage: null,
            messages: [],
          },
        };
      },
    };

    await executeAgentTurnRun(
      fakeClient(reported, beats) as never,
      turnJob(),
      {},
      { ...cfgWith(executor), heartbeatIntervalMs: 10 }
    );

    const sent = beats.filter((beat) => beat.turnDelta).map((beat) => beat.turnDelta);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    // INCREMENTAL, which is what every renderer of a delta does with it: the
    // API renderer broadcasts the span and the SPA appends. A cumulative
    // snapshot down the same path renders as the reply repeated back to
    // itself, so the property under test is that appending reconstructs the
    // reply EXACTLY — no repeated span, no hole.
    expect(reconstruct(beats)).toBe("the isolate lane answered");
    expect(sent[0]?.text).toBe("the isolate");
    // Monotonic, so the server can fence out a reordered or retried beat.
    const sequences = sent.map((delta) => delta?.sequence ?? 0);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    // And the turn still reports normally.
    expect(reported.calls[0]).toMatchObject({ status: "completed", text: "the isolate lane answered" });
  });

  test("sends no delta for a turn that streams nothing", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    const executor: SyncExecutor = {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          mode: "agent_turn",
          turn: { text: "", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    await executeAgentTurnRun(
      fakeClient(reported, beats) as never,
      turnJob(),
      {},
      { ...cfgWith(executor), heartbeatIntervalMs: 10 }
    );

    // Beats still happen — liveness is their real job — but they carry nothing.
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.every((beat) => beat.turnDelta === undefined)).toBe(true);
  });

  /**
   * The regression that made this feature worse than not streaming: the delta
   * timer WAS the liveness timer, so at the shipped production default the
   * first token landed up to 30s late and the reply arrived in 30s clumps.
   *
   * Asserted against the PRODUCTION default rather than an overridden one,
   * because an overridden interval is exactly what hid it.
   */
  test("streams on its own cadence under the production heartbeat default", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    const executor: SyncExecutor = {
      execute: async (_code, _job, hooks) => {
        hooks?.onTurnEvent?.({ type: "text_delta", delta: "first" });
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        hooks?.onTurnEvent?.({ type: "text_delta", delta: " second" });
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return {
          mode: "agent_turn",
          turn: { text: "first second", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    const started = Date.now();
    await executeAgentTurnRun(
      fakeClient(reported, beats) as never,
      turnJob(),
      {},
      // PRODUCTION_HEARTBEAT_MS, as `DEFAULT_CONFIG` ships it and as the fleet
      // entrypoint (embedded-connector-worker.ts) leaves it: no override.
      { ...cfgWith(executor), heartbeatIntervalMs: PRODUCTION_HEARTBEAT_MS }
    );
    const elapsed = Date.now() - started;

    const sent = beats.filter((beat) => beat.turnDelta);
    // Both spans reached the client DURING a turn far shorter than one
    // liveness beat. Under the old shared timer nothing would have been sent
    // at all: the first beat was still 27s away when the turn ended.
    expect(elapsed).toBeLessThan(PRODUCTION_HEARTBEAT_MS);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(reconstruct(beats)).toBe("first second");
  });

  /**
   * A reply longer than one batch. The old code kept the TAIL of a cumulative
   * accumulator, so past the cap the beginning of the answer the user had
   * already read was replaced by a headless tail.
   */
  test("reconstructs a reply longer than the batch cap, head first and whole", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    // Distinguishable per chunk, so a lost or reordered span is visible in the
    // reconstruction rather than hiding inside a run of identical characters.
    const chunks = Array.from({ length: 40 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)).repeat(1_000)
    );
    const whole = chunks.join("");
    expect(whole.length).toBeGreaterThan(TURN_DELTA_MAX_CHARS);

    const executor: SyncExecutor = {
      execute: async (_code, _job, hooks) => {
        for (const chunk of chunks) {
          hooks?.onTurnEvent?.({ type: "text_delta", delta: chunk });
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          mode: "agent_turn",
          turn: { text: whole, stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    await executeAgentTurnRun(
      fakeClient(reported, beats) as never,
      turnJob(),
      {},
      { ...cfgWith(executor), heartbeatIntervalMs: 10 }
    );

    const sent = beats.filter((beat) => beat.turnDelta).map((beat) => beat.turnDelta);
    // More than one batch, and no batch over the cap.
    expect(sent.length).toBeGreaterThan(1);
    for (const delta of sent) {
      expect((delta?.text ?? "").length).toBeLessThanOrEqual(TURN_DELTA_MAX_CHARS);
    }
    // The cap holds text BACK, it never discards it: what the client appends
    // is the reply from its first character, in order, complete.
    expect(reconstruct(beats)).toBe(whole);
  });

  /**
   * The cursor is ack-gated. A beat whose publish failed must re-send the SAME
   * span under the SAME sequence — a new sequence for the same text would be a
   * second span the server's fence has no reason to refuse, and dropping it
   * would leave a hole the client never repairs mid-turn.
   */
  test("re-sends an unacknowledged batch under its own sequence, exactly once", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    const executor: SyncExecutor = {
      execute: async (_code, _job, hooks) => {
        hooks?.onTurnEvent?.({ type: "text_delta", delta: "alpha" });
        await new Promise((resolve) => setTimeout(resolve, 120));
        hooks?.onTurnEvent?.({ type: "text_delta", delta: "beta" });
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          mode: "agent_turn",
          turn: { text: "alphabeta", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    // The first two beats fail outright, then the gateway recovers: the
    // ambiguous case (the request threw, so the worker cannot know whether the
    // row landed) resolves to a retry, and the server's sequence fence is what
    // makes that retry a no-op rather than a duplicate.
    await executeAgentTurnRun(
      fakeClient(reported, beats, (beat) => (beat < 2 ? "throw" : "ack")) as never,
      turnJob(),
      {},
      { ...cfgWith(executor), heartbeatIntervalMs: 10 }
    );

    const sent = beats.filter((beat) => beat.turnDelta).map((beat) => beat.turnDelta as { text: string; sequence: number });
    // "alpha" was sent more than once — that is the retry — and every send of
    // it carried the same sequence, so the server fences all but the first.
    const alphas = sent.filter((delta) => delta.text === "alpha");
    expect(alphas.length).toBeGreaterThan(1);
    expect(new Set(alphas.map((delta) => delta.sequence)).size).toBe(1);
    // A sequence is never reused for DIFFERENT text: that would make the fence
    // drop real text as a duplicate.
    const bySequence = new Map<number, Set<string>>();
    for (const delta of sent) {
      const texts = bySequence.get(delta.sequence) ?? new Set<string>();
      texts.add(delta.text);
      bySequence.set(delta.sequence, texts);
    }
    for (const texts of bySequence.values()) expect(texts.size).toBe(1);
    // What the server ACCEPTS (first win per sequence) reconstructs the reply
    // exactly: no duplicated span, no missing one.
    const accepted = new Map<number, string>();
    for (const delta of sent) {
      if (!accepted.has(delta.sequence)) accepted.set(delta.sequence, delta.text);
    }
    const rebuilt = [...accepted.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("");
    expect(rebuilt).toBe("alphabeta");
  });

  /**
   * A gateway that answers without an ack (older build, or a publish that
   * threw inside the route) must not have its text retired: no ack, no
   * progress, and the turn still completes with the authoritative reply.
   */
  test("keeps text queued when the gateway acknowledges nothing", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    const executor: SyncExecutor = {
      execute: async (_code, _job, hooks) => {
        hooks?.onTurnEvent?.({ type: "text_delta", delta: "unacked" });
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          mode: "agent_turn",
          turn: { text: "unacked", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    await executeAgentTurnRun(
      fakeClient(reported, beats, "silent") as never,
      turnJob(),
      {},
      { ...cfgWith(executor), heartbeatIntervalMs: 10 }
    );

    const sent = beats.filter((beat) => beat.turnDelta).map((beat) => beat.turnDelta as { text: string; sequence: number });
    // Re-sent rather than advanced past: every attempt is the same span under
    // the same sequence.
    expect(sent.length).toBeGreaterThan(1);
    expect(new Set(sent.map((delta) => delta.text))).toEqual(new Set(["unacked"]));
    expect(new Set(sent.map((delta) => delta.sequence)).size).toBe(1);
    // And the turn still finishes: the terminal reply is authoritative and
    // never waits on the cosmetic path.
    expect(reported.calls[0]).toMatchObject({ status: "completed", text: "unacked" });
  });

  /**
   * Tool visibility. `tool_call_end` used to be discarded, so nothing would
   * have failed if tool events stopped arriving entirely.
   */
  test("carries a finished tool call on the beat", async () => {
    const reported: Reported = { calls: [] };
    const beats: HeartbeatCall[] = [];
    const executor: SyncExecutor = {
      execute: async (_code, _job, hooks) => {
        hooks?.onTurnEvent?.({
          type: "tool_call_start",
          toolCallId: "call-1",
          name: "search_memory",
          args: {},
        });
        hooks?.onTurnEvent?.({
          type: "tool_call_end",
          toolCallId: "call-1",
          name: "search_memory",
          isError: false,
          output: "3 results",
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          mode: "agent_turn",
          turn: { text: "done", stopReason: "stop", usage: null, messages: [] },
        };
      },
    };

    await executeAgentTurnRun(
      fakeClient(reported, beats) as never,
      turnJob(),
      {},
      { ...cfgWith(executor), heartbeatIntervalMs: 10 }
    );

    const traces = beats.flatMap((beat) => beat.toolEvents ?? []);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      tool_call_id: "call-1",
      name: "search_memory",
      is_error: false,
      output: "3 results",
    });
  });

  /**
   * The in-band reply. An agent that posts into the conversation it is
   * answering has already given the user the answer; the terminal reply would
   * be that same answer a second time, which is what `repliedInBand`
   * suppresses at the renderer.
   */
  test("reports an in-band reply so the terminal delivery can be suppressed", async () => {
    const reported: Reported = { calls: [] };
    const executor = executorReturning({
      mode: "agent_turn",
      turn: {
        text: "I posted it above.",
        stopReason: "stop",
        usage: null,
        messages: [],
        repliedInBand: true,
      },
    });

    await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob(),
      {},
      cfgWith(executor)
    );

    expect(reported.calls[0]).toMatchObject({
      status: "completed",
      replied_in_band: true,
    });
  });

  test("omits the in-band flag for an ordinary turn", async () => {
    const reported: Reported = { calls: [] };
    const executor = executorReturning({
      mode: "agent_turn",
      turn: { text: "hi", stopReason: "stop", usage: null, messages: [] },
    });

    await executeAgentTurnRun(
      fakeClient(reported) as never,
      turnJob(),
      {},
      cfgWith(executor)
    );

    // Absent, not false: the server suppresses only on a positive signal.
    expect(reported.calls[0]?.replied_in_band).toBeUndefined();
  });
});
