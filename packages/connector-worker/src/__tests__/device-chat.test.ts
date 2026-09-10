import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CompleteDeviceChatRequest,
  PollResponse,
} from "@lobu/core/contracts/worker/protocol";
import { monitorDeviceAgentRun } from "../daemon/automation.js";
import { executeDeviceChatRun } from "../daemon/device-chat.js";
import { type ExecutorClient, WorkerHttpError } from "../daemon/client.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "lobu-device-chat-"));
const fakePi = path.join(tmp, "pi");
const argsLog = path.join(tmp, "args.log");

beforeAll(() => {
  writeFileSync(
    fakePi,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$DEVICE_CHAT_ARGS"\nprintf "Reply from the selected device\\n"\n',
  );
  chmodSync(fakePi, 0o755);
  process.env.DEVICE_CHAT_ARGS = argsLog;
});

afterAll(() => {
  delete process.env.DEVICE_CHAT_ARGS;
  rmSync(tmp, { recursive: true, force: true });
});

function job(): PollResponse {
  return {
    run_id: 91,
    run_type: "chat_message",
    organization_id: "org-1",
    payload: {
      chat: {
        agent_kind: "pi",
        execution_config: { model: "test-local-model", effort: "xhigh" },
        message: "Summarize Atlas",
        history: [{ role: "assistant", content: "Atlas is active." }],
        agent: { id: "agent-1", name: "Researcher" },
      },
      context: {
        device: { worker_id: "device-1" },
        user: { user_id: "user-1" },
        agent_session: {
          conversation_id: "conv-1",
          mcp_url: "https://lobu.test/mcp/acme",
          token: "run-token",
          expires_at: Date.now() + 60_000,
        },
      },
    },
  };
}

describe("device chat executor", () => {
  test("reports a claimed malformed envelope through chat completion", async () => {
    const reports: CompleteDeviceChatRequest[] = [];
    const client = {
      id: "device-1",
      completeDeviceChat: async (
        _runId: number,
        body: CompleteDeviceChatRequest,
      ) => {
        reports.push(body);
        return { ok: true as const, status: "failed" as const };
      },
    } as unknown as ExecutorClient;

    const result = await executeDeviceChatRun(
      client,
      {
        run_id: 90,
        run_type: "chat_message",
        payload: { automation: {} },
      } as unknown as PollResponse,
      {},
    );

    expect(result.error).toContain("non-chat payload envelope");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      worker_id: "device-1",
      exit_reason: "error_message",
    });
  });

  test("uses the shared supervised CLI runner and reports its reply", async () => {
    const reports: CompleteDeviceChatRequest[] = [];
    const client = {
      id: "device-1",
      heartbeat: async () => {},
      completeDeviceChat: async (
        _runId: number,
        body: CompleteDeviceChatRequest,
      ) => {
        reports.push(body);
        return { ok: true as const, status: "completed" as const };
      },
    } as unknown as ExecutorClient;

    const result = await executeDeviceChatRun(client, job(), {
      binaryOverrides: { pi: fakePi },
      heartbeatIntervalMs: 60_000,
      timeoutMs: 10_000,
      requireRunScopedSession: true,
    });

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.worker_id).toBe("device-1");
    expect(reports[0]?.output).toBe("Reply from the selected device");
    expect(reports[0]?.exit_reason).toBe("ok");
    const args = readFileSync(argsLog, "utf8");
    expect(args).toContain("--thinking\nxhigh");
    expect(args).toContain("test-local-model");
    expect(args).toContain("Summarize Atlas");
    expect(args).toContain("Assistant: Atlas is active.");
  });

  test("shares Automation cancellation on terminal heartbeat and shutdown", async () => {
    const terminalClient = {
      heartbeat: async () => {
        throw new WorkerHttpError(409, "/api/workers/heartbeat", "settled");
      },
    } as unknown as ExecutorClient;
    const terminal = monitorDeviceAgentRun(
      terminalClient,
      92,
      {
        heartbeatIntervalMs: 1,
      },
      "Device chat",
    );
    const deadline = Date.now() + 1_000;
    while (!terminal.abortController.signal.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(terminal.abortController.signal.aborted).toBe(true);
    terminal.stop();

    const shutdown = new AbortController();
    const shutdownMonitor = monitorDeviceAgentRun(
      { heartbeat: async () => {} } as unknown as ExecutorClient,
      93,
      { heartbeatIntervalMs: 60_000, shutdownSignal: shutdown.signal },
      "Device chat",
    );
    shutdown.abort();
    expect(shutdownMonitor.abortController.signal.aborted).toBe(true);
    expect(shutdownMonitor.shutdownRequested()).toBe(true);
    shutdownMonitor.stop();
  });
});
