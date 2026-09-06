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
import type { PollResponse } from "@lobu/core/contracts/worker/protocol";
import { executeAgentTurnRun } from "../daemon/agent-turn.js";
import type { ExecutorConfig } from "../daemon/executor.js";
import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from "../executor/interface.js";
import type { CompleteAgentTurnRequest } from "../daemon/client.js";

const WORKER_ID = "fleet-test-worker";

interface Reported {
  calls: CompleteAgentTurnRequest[];
}

/** One heartbeat the arm sent, and the turn delta it carried (if any). */
interface HeartbeatCall {
  turnDelta?: { text: string; sequence: number };
}

/**
 * The narrow slice of `ExecutorClient` this arm touches. Typed through
 * `unknown` rather than stubbing the whole client: what matters is which
 * endpoint gets called with what, not the transport.
 */
function fakeClient(reported: Reported, beats?: HeartbeatCall[]) {
  return {
    id: WORKER_ID,
    heartbeat: async (
      _runId: number,
      _progress?: unknown,
      _agentSession?: unknown,
      turnDelta?: { text: string; sequence: number }
    ) => {
      beats?.push({ turnDelta });
    },
    completeAgentTurn: async (req: CompleteAgentTurnRequest) => {
      reported.calls.push(req);
      return { ok: true as const, status: "completed" as const };
    },
  };
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

    await executeAgentTurnRun(fakeClient(reported) as never, job, {}, cfgWith(executor));

    if (seen?.mode !== "agent_turn") throw new Error("expected an agent_turn job");
    expect(seen.turn.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
    expect(seen.turn.files).toEqual([{ name: "report.pdf", mimeType: "application/pdf", size: 2048 }]);
    expect(seen.turn.provider.input).toEqual(["text", "image"]);
  });

  test("leaves attachments and modalities off the job when the envelope carries none", async () => {
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
  test("beats the reply so far, cumulatively, and only when it moved", async () => {
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
    // CUMULATIVE: the second restates the first rather than continuing it, so
    // a dropped beat cannot leave a hole in the reply the user reads.
    expect(sent[0]?.text).toBe("the isolate");
    expect(sent[sent.length - 1]?.text).toBe("the isolate lane answered");
    // Monotonic, so the server can drop a reordered or retried beat.
    const sequences = sent.map((delta) => delta?.sequence ?? 0);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    // The reply text is never republished once it stops moving: every beat
    // would otherwise write a thread_response row for no visible change.
    expect(sent.filter((delta) => delta?.text === "the isolate lane answered")).toHaveLength(1);
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
});
