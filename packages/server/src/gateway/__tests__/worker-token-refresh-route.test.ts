/**
 * Integration tests for the worker-token refresh endpoint
 * (`POST /worker/token/refresh`) against a real Postgres (embedded PG18 in CI).
 *
 * The endpoint mints a fresh 2h worker token from a currently-valid one, gated
 * on PER-TURN liveness: a fresh token is issued ONLY while an in-flight
 * turn-timeout marker exists for the token's OWN turn — `(deploymentName,
 * messageId)`, the cross-pod-authoritative liveness signal in shared
 * `public.runs`. When THAT turn goes terminal the marker is gone and refresh is
 * DENIED — even if a later, unrelated turn on the same deployment is live. That
 * denial is the revocation property (a leaked token's chain ends with its turn).
 *
 * The liveness gate itself (across every terminalization path) is unit-tested
 * in turn-liveness.test.ts; this file is the end-to-end route surface: auth,
 * the runId/messageId-eligibility gate, the per-turn liveness gate, and the
 * minted-token claims.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  AgentErrorCode,
  generateWorkerToken,
  verifyWorkerToken,
} from "@lobu/core";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { generateDeploymentName } from "../orchestration/deployment-identity.js";
import {
  armTurnTimeout,
  commitTerminalReply,
  failTurnsForDeployment,
} from "../orchestration/turn-liveness.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

let queue: RunsQueue;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await resetTestDatabase();
  // The runs FK requires the organization to exist before arming a marker.
  await seedAgentRow("agent-1", { organizationId: "org-1" });
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  await queue.stop();
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

/** Construct a WorkerGateway with stub deps — the refresh route only touches
 *  the DB (liveness gate + revoked-token store) and the token codec, none of
 *  the session-context / MCP collaborators. */
function makeGateway(): WorkerGateway {
  return new WorkerGateway(
    queue as any,
    "https://gateway.example.com",
    { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
    {
      getSessionContext: async () => ({
        agentLayers: {
          identityMd: "",
          soulMd: "",
          userMd: "",
          unconfiguredNotice: "",
        },
        platformInstructions: "",
        networkInstructions: "",
        skillsInstructions: "",
        mcpStatus: [],
      }),
    } as any
  );
}

async function postRefresh(token: string) {
  const gateway = makeGateway();
  return await gateway.getApp().request("/token/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: "gateway.example.com",
    },
  });
}

/**
 * The turn's routing identity. Production derives BOTH names below from it, and
 * they are not the same string — a test that reuses one name on both sides
 * fabricates a linkage the gate does not have (this file did, and the gate was
 * denying every turn-credential refresh while these tests passed).
 */
const TURN = {
  organizationId: "org-1",
  agentId: "agent-1",
  userId: "user-1",
  platform: "api",
  channelId: "chan-1",
  conversationId: "conv-1",
};

/** What `MessageConsumer` arms the marker under. */
const DEPLOYMENT = generateDeploymentName(TURN);

/** What `mintTurnToken` scopes the CREDENTIAL to — a per-turn namespace. */
function credentialScope(messageId: string | undefined): string {
  return `agent-turn:${messageId ?? "none"}`;
}

function mintToken(opts: {
  runId?: number;
  messageId?: string;
  adminGrant?: boolean;
}): string {
  return generateWorkerToken("user-1", "conv-1", credentialScope(opts.messageId), {
    channelId: "chan-1",
    platform: "api",
    agentId: "agent-1",
    organizationId: "org-1",
    connectionId: "connection-1",
    responseThreadId: "slack:chan-1:thread-1",
    source: "automation-run",
    runId: opts.runId,
    messageId: opts.messageId,
    ...(opts.adminGrant
      ? {
          adminTools: ["manage_agents"],
          adminActorUserId: "auth-user-1",
        }
      : {}),
    allowedDomains: ["api.example.com"],
    deniedDomains: ["evil.example.com"],
    nixPackages: ["gh"],
    // Minted as a capture (eval replay) token so refresh is exercised on the
    // mode that has something to lose. Both halves are required: the verifier
    // rejects `capture` without a run id.
    executionMode: "capture",
    automationRunId: 874626,
  });
}

function armLiveTurn(messageId = "m1"): Promise<void> {
  return armTurnTimeout(queue, {
    messageId,
    channelId: "chan-1",
    conversationId: "conv-1",
    userId: "user-1",
    platform: "api",
    deploymentName: DEPLOYMENT,
    organizationId: "org-1",
  });
}

describe("POST /worker/token/refresh", () => {
  test("mints a fresh token while THIS turn is live", async () => {
    await armLiveTurn("m1");
    const original = mintToken({
      runId: 42,
      messageId: "m1",
      adminGrant: true,
    });

    const res = await postRefresh(original);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token).not.toBe(original);

    // Fresh token verifies and preserves the per-run routing claims. The
    // messageId MUST survive or the refreshed token couldn't itself be
    // refreshed again (its own turn-liveness gate would have nothing to match).
    const data = verifyWorkerToken(body.token);
    expect(data).not.toBeNull();
    expect(data!.runId).toBe(42);
    expect(data!.messageId).toBe("m1");
    expect(data!.connectionId).toBe("connection-1");
    expect(data!.responseThreadId).toBe("slack:chan-1:thread-1");
    expect(data!.source).toBe("automation-run");
    // The refreshed credential keeps its own per-turn scope; it is NOT the
    // marker's deployment name, and the gate derives that instead of reading this.
    expect(data!.deploymentName).toBe(credentialScope("m1"));
    expect(data!.organizationId).toBe("org-1");
    expect(data!.adminTools).toEqual(["manage_agents"]);
    expect(data!.adminActorUserId).toBe("auth-user-1");
    // Egress claims must BOTH survive refresh — dropping allowedDomains
    // breaks the sandbox network (deny-all), dropping deniedDomains
    // silently re-opens denied hosts on remote runtimes.
    expect(data!.allowedDomains).toEqual(["api.example.com"]);
    expect(data!.deniedDomains).toEqual(["evil.example.com"]);
    // The package claim rides with them: a turn that rotates its token would
    // otherwise stop provisioning the connector's CLI mid-run, leaving an
    // authenticated binary that is no longer installed.
    expect(data!.nixPackages).toEqual(["gh"]);
    // And the capture pair. This is the one whose loss is silent AND harmful:
    // a refreshed token without `executionMode` reads as live, so the rest of
    // the eval replay performs real side effects against the org it is
    // scoring instead of recording them.
    expect(data!.executionMode).toBe("capture");
    expect(data!.automationRunId).toBe(874626);
  });

  test("REVOCATION: denied (403) once this turn has no live marker", async () => {
    // No armed turn → the turn is not live → refresh must be refused.
    const original = mintToken({ runId: 42, messageId: "m1" });
    const res = await postRefresh(original);
    expect(res.status).toBe(403);
  });

  test("REVOCATION: a token that was refreshable becomes non-refreshable after the turn terminalizes", async () => {
    await armLiveTurn("m1");
    const original = mintToken({ runId: 42, messageId: "m1" });

    // First refresh succeeds while live.
    expect((await postRefresh(original)).status).toBe(200);

    // The worker dies / replies → marker discharged. Use the fast path to
    // simulate terminalization, then refresh must be denied.
    await failTurnsForDeployment(DEPLOYMENT, AgentErrorCode.WORKER_DIED);

    const res = await postRefresh(original);
    expect(res.status).toBe(403);
  });

  test("CROSS-TURN LEAK CLOSED: a COMPLETED turn's token is denied (403) even while a LATER turn on the same deployment is live", async () => {
    // Two turns on the SAME deployment. Turn 1 = m1, turn 2 = m2.
    await armLiveTurn("m1");
    await armLiveTurn("m2");
    const turn1Token = mintToken({ runId: 1, messageId: "m1" });

    // Turn 1's token can refresh while turn 1 is live.
    expect((await postRefresh(turn1Token)).status).toBe(200);

    // Turn 1 COMPLETES (its marker is deleted) while turn 2 (m2) is STILL live.
    await commitTerminalReply(
      DEPLOYMENT,
      ["m1"],
      { messageId: "m1", deploymentName: DEPLOYMENT },
      "org-1"
    );

    // The KEY security assertion: turn 1's still-valid token is now DENIED, even
    // though the deployment has a live turn (m2). A per-deployment gate would
    // have wrongly minted a fresh token here (privilege leak across runs).
    const res = await postRefresh(turn1Token);
    expect(res.status).toBe(403);

    // Turn 2's own token still refreshes (its turn is genuinely live).
    const turn2Token = mintToken({ runId: 2, messageId: "m2" });
    expect((await postRefresh(turn2Token)).status).toBe(200);
  });

  test("denied (403) for a token with no runId (legacy direct-enqueue, no marker to gate on)", async () => {
    await armLiveTurn("m1");
    const noRunId = mintToken({ messageId: "m1" }); // runId omitted
    const res = await postRefresh(noRunId);
    expect(res.status).toBe(403);
  });

  test("denied (403) for a token with no messageId (no per-turn marker to gate on)", async () => {
    await armLiveTurn("m1");
    const noMessageId = mintToken({ runId: 42 }); // messageId omitted
    const res = await postRefresh(noMessageId);
    expect(res.status).toBe(403);
  });

  test("rejected (401) for a malformed / unverifiable token", async () => {
    await armLiveTurn();
    const res = await postRefresh("not-a-real-token");
    expect(res.status).toBe(401);
  });

  test("SECURITY: an already-EXPIRED token cannot refresh even while the turn is live", async () => {
    // This bounds the leak window: refresh must travel with a still-valid
    // bearer. verifyWorkerToken (inside authenticateWorker) rejects an expired
    // token BEFORE the liveness gate, so an attacker who grabs an expired token
    // cannot resurrect it via refresh, live deployment or not.
    await armLiveTurn();
    const prevTtl = process.env.WORKER_TOKEN_TTL_MS;
    const prevSkew = process.env.WORKER_TOKEN_CLOCK_SKEW_MS;
    process.env.WORKER_TOKEN_TTL_MS = "1"; // 1ms TTL
    process.env.WORKER_TOKEN_CLOCK_SKEW_MS = "0";
    try {
      const expired = mintToken({ runId: 42, messageId: "m1" });
      // Past TTL + skew (1ms + 0ms).
      await new Promise((r) => setTimeout(r, 10));
      const res = await postRefresh(expired);
      expect(res.status).toBe(401);
    } finally {
      if (prevTtl === undefined) delete process.env.WORKER_TOKEN_TTL_MS;
      else process.env.WORKER_TOKEN_TTL_MS = prevTtl;
      if (prevSkew === undefined) delete process.env.WORKER_TOKEN_CLOCK_SKEW_MS;
      else process.env.WORKER_TOKEN_CLOCK_SKEW_MS = prevSkew;
    }
  });
});
