import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import * as dbClient from "../../db/client.js";
import {
  attachFreshRunJobToken,
  recordAgentRunInput,
} from "../orchestration/agent-run-input.js";

// Same lazy-ENCRYPTION_KEY convention as worker-token-mint-parity.test.ts.
process.env.ENCRYPTION_KEY ??=
  "0000000000000000000000000000000000000000000000000000000000000000";

// Fake the DB at the `getDb` seam with `spyOn` (restored in afterAll), never
// `mock.module`: this suite shares a process with every other gateway suite and
// bun's `mock.module` is process-global and CANNOT be undone by
// `mock.restore()`. A whole-module stub of `../../db/client.js` here leaks a
// query function that returns [] into every co-running DB-backed suite
// (agent-history-routes, connector-tooling-enqueue, instruction-service, …),
// where seeds silently no-op and assertions fail far from the cause.
const getDbSpy = spyOn(dbClient, "getDb");
afterAll(() => {
  getDbSpy.mockRestore();
});

/**
 * A per-run token is minted once, but its claim set is rebuilt BY HAND on three
 * further paths: `durableClaims` (persisting to `agent_run_input.token_claims`),
 * `attachFreshRunJobToken` (the durable-replay remint), and the
 * `/worker/token/refresh` route. Every claim on `WorkerTokenData` is optional,
 * so a mapper that forgets one still typechecks — the claim is simply gone the
 * moment a run replays or a long turn rotates its token.
 *
 * This has now happened twice. `nixPackages` was the first: losing it on replay
 * left an authenticated `gh` that was never installed. The capture pair was the
 * second, and worse — a dropped `executionMode` reads as live, so an eval
 * replay stops recording and starts performing real side effects against the
 * org it is scoring.
 *
 * Hence the whole-fixture projection below rather than another hand-picked list
 * of expectations.
 */
describe("durable replay preserves every signed claim", () => {
  const claims = {
    userId: "u1",
    conversationId: "c1",
    deploymentName: "dep-1",
    channelId: "ch1",
    teamId: "t1",
    agentId: "a1",
    organizationId: "org1",
    connectionId: "conn1",
    platform: "slack",
    source: "chat",
    runId: 7,
    messageId: "m1",
    adminTools: ["manage_agents"],
    actorUserId: "auth-user-1",
    runtimeProviderId: "vercel",
    sandboxId: "sb1",
    allowedDomains: ["api.github.com"],
    deniedDomains: ["evil.example.com"],
    nixPackages: ["gh"],
    // The capture pair. Dropping it on either hop turns an eval replay back
    // into a LIVE run: absent `executionMode` reads as live, so the replay
    // performs for real everything it was supposed to only record. Both are
    // present because `verifyWorkerToken` rejects one without the other.
    executionMode: "capture" as const,
    automationRunId: 874626,
  };

  /**
   * Assert against the WHOLE fixture rather than a hand-picked few. Both this
   * suite and the mint's own round-trip test previously listed claims by hand
   * and silently fell behind the interface — `nixPackages` was added for that
   * reason, and the capture pair was missed the same way afterwards. Comparing
   * a projection off the fixture's own keys means a claim can never be added
   * to the fixture and left unasserted; keeping the fixture exhaustive is then
   * the only discipline required.
   */
  const project = (actual: Record<string, unknown> | undefined) =>
    Object.fromEntries(
      Object.keys(claims).map((k) => [k, actual?.[k]]),
    );

  test("the PERSISTED claim set carries every claim, not just the remint", async () => {
    // `durableClaims` is a hand-written mapper feeding
    // agent_run_input.token_claims. A claim the mint signs but that mapper
    // omits is lost at the DATABASE boundary, before attachFreshRunJobToken
    // ever sees it — so capture what recordAgentRunInput actually writes.
    const bound: Array<Record<string, unknown>> = [];
    const sql = Object.assign(
      async () => {
        return [];
      },
      {
        json: (value: Record<string, unknown>) => {
          bound.push(value);
          return value;
        },
      },
    );
    getDbSpy.mockImplementation(
      () => sql as unknown as ReturnType<typeof dbClient.getDb>,
    );

    const runJobToken = generateWorkerToken(
      claims.userId,
      claims.conversationId,
      claims.deploymentName,
      claims as never,
    );
    await recordAgentRunInput(
      {
        ...claims,
        runJobToken,
      } as never,
      claims.deploymentName,
    );

    // recordAgentRunInput binds the stored payload first, then the claim set.
    const persisted = bound[1];
    expect(project(persisted)).toEqual(claims);
  });

  test("attachFreshRunJobToken carries every claim across a replay remint", () => {
    const replayed = attachFreshRunJobToken({
      payload: { runId: 7, messageId: "m1" } as never,
      tokenClaims: claims as never,
    });

    const decoded = verifyWorkerToken(replayed.runJobToken as string);

    // Every claim the fixture carries must survive the remint — the egress
    // grants, the package list, the admin pair, and the capture pair alike.
    expect(project(decoded as unknown as Record<string, unknown>)).toEqual(
      claims,
    );
  });
});
