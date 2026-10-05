/** Real Lobu isolate/session, synthetic provider: this checks isolation, not model quality. */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { agentGuestBundle } from "@lobu/connector-worker/agent-turn";
import type { AgentTurnOutput } from "@lobu/connector-worker/agent-turn";
import type { ExecutorJob } from "@lobu/connector-worker/executor/interface";
import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  buildEvaluationCases,
  citesMigration,
  correctsNumber,
} from "../scripts/eval.ts";

const cases = buildEvaluationCases(
  [
    {
      event: "Billing migration wrote false cancellations",
      type: "data_incident",
      date: "2026-03-12",
      source: "https://linear.app/kelder/issue/DATA-142",
      affected_metrics: ["churn_rate"],
      expected_effect: "Subtract 500 migration artifacts.",
      adjustment: {
        op: "subtract_reason",
        cancel_reason: "billing_migration_artifact",
      },
    },
  ],
  { raw: 550, adjusted: 50 }
);
const PLACEHOLDER = "lobu_secret_00000000-0000-4000-8000-000000000000";
const hits: Array<{
  url: string;
  body: Record<string, unknown>;
  authorization?: string;
}> = [];
let server: Server;
let providerUrl: string;
let bundle: string;

beforeAll(async () => {
  bundle = await agentGuestBundle();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      hits.push({
        url: req.url ?? "",
        body,
        authorization: req.headers.authorization,
      });
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(500).end("Unexpected retrieval request");
        return;
      }
      // A scripted provider lets the test inspect the real wire context. Its
      // canned replies are NOT evidence that a live model uses context well.
      const hasContext = JSON.stringify(body.messages).includes("DATA-142");
      const answer = hasContext
        ? "DATA-142 explains the migration artifacts. Corrected March cancellations: 50."
        : "The warehouse reports 550 cancellations; no cause is established.";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "synthetic-context-eval",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic-context-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: answer },
              finish_reason: "stop",
            },
          ],
        })}\n\ndata: [DONE]\n\n`
      );
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}, 120_000);

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runIsolatedCase(userMessage: string): Promise<AgentTurnOutput> {
  const job: ExecutorJob = {
    mode: "agent_turn",
    turn: {
      provider: {
        api: "openai-completions",
        provider: "openai",
        modelId: "synthetic-context-model",
        baseUrl: providerUrl,
      },
      systemPrompt:
        "Answer using the supplied evidence. State when the cause is unknown.",
      sessionJsonl: "",
      userMessage,
      // No tools, memory, files, or prior session enter either arm. This is
      // owned by the fixture, without a production agent configuration knob.
    },
    config: {},
    credentials: { provider: "openai", accessToken: PLACEHOLDER },
    sessionState: null,
    env: {},
  };
  const result = await new IsolateExecutor({
    timeoutMs: 30_000,
    allowedDomains: ["127.0.0.1"],
  }).execute(bundle, job, {});
  if (result.mode !== "agent_turn")
    throw new Error(`Unexpected result: ${result.mode}`);
  return result.turn;
}

test("both arms use fresh tool-free Lobu sessions and the baseline cannot retrieve context", async () => {
  const withContext = await runIsolatedCase(cases.withContext);
  // Run baseline second so accidental session reuse leaks the first answer.
  const baseline = await runIsolatedCase(cases.baseline);

  expect(hits).toHaveLength(2);
  for (const [index, output] of [withContext, baseline].entries()) {
    const hit = hits[index]!;
    expect(hit.url).toBe("/v1/chat/completions");
    expect(hit.authorization).toBe(`Bearer ${PLACEHOLDER}`);
    expect(hit.body.tools ?? []).toEqual([]);
    expect(output.toolsUsed).toEqual([]);
    expect(output.stopReason).toBe("stop");
    const messages = (hit.body.messages as Array<{ role: string }>).filter(
      (message) => message.role !== "system"
    );
    const prompt = index === 0 ? cases.withContext : cases.baseline;
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: prompt }] },
    ]);

    const entries = output.sessionJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[0]).toMatchObject({ type: "session", version: 3 });
    const transcript = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    expect(transcript.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(transcript[0].content).toEqual([{ type: "text", text: prompt }]);
    expect(transcript[1].content).toContainEqual({
      type: "text",
      text: output.text,
    });
  }
  expect(JSON.stringify(hits[0]?.body)).toContain("DATA-142");
  expect(citesMigration(withContext.text)).toBe(true);
  expect(correctsNumber(withContext.text)).toBe(true);
  for (const value of [JSON.stringify(hits[1]?.body), baseline.sessionJsonl]) {
    expect(value).not.toMatch(
      /DATA-142|billing_migration_artifact|Subtract 500/
    );
  }
  expect(correctsNumber(JSON.stringify(hits[1]?.body.messages))).toBe(false);
  expect(citesMigration(baseline.text)).toBe(false);
  expect(correctsNumber(baseline.text)).toBe(false);
}, 120_000);
