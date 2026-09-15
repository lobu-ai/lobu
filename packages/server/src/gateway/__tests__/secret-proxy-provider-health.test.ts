/**
 * End-to-end proof for the proxy-side provider-health contract: the secret
 * proxy marks an org's `inference_providers` row from the upstream HTTP
 * status (429/402 → quota, 401/403 → auth), clears it on the next 2xx, and
 * treats every other status as "no health signal" — never as healthy.
 *
 * The removed gateway suite (worker-response-liveness, "inference-provider
 * health" describe) covered this contract end-to-end for the retired
 * terminal-row mechanism; this is its proxy-side successor. The upstream is
 * a mocked fetch, but the health writes hit a real embedded Postgres, and
 * the org comes from the agent-org resolver (an independent source, like the
 * signed token in prod) — so a request cannot touch another tenant's row.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import * as providerSecrets from "../../lobu/stores/provider-secrets.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { generateDeploymentName } from "../orchestration/deployment-identity.js";
import { armTurnTimeout } from "../orchestration/turn-liveness.js";
import type { SecretStore } from "../secrets/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

// The org-row credential path keeps the request free of SecretStore/profile
// dependencies (same mock as secret-proxy-org-upstream.test.ts); the health
// mark/clear store functions stay REAL so they write the embedded DB.
const resolveInferenceProviderConfigSpy = spyOn(
  providerSecrets,
  "resolveInferenceProviderConfig"
).mockImplementation(async () => ({
  baseUrl: "https://myzai.example.com/v1",
  apiKey: "org-zai-key",
  custom: true,
}));

// Import AFTER the mock so secret-proxy's transitive imports pick up the stub.
const { SecretProxy } = await import("../proxy/secret-proxy.js");
const { stopDbForGatewayTests } = await import("./helpers/db-setup.js");

afterAll(async () => {
  resolveInferenceProviderConfigSpy.mockRestore();
  await stopDbForGatewayTests();
});

/** Insert a live provider row for an org the way the settings UI would. */
async function seedProvider(
  organizationId: string,
  slug: string,
  status = "active"
): Promise<void> {
  await getDb()`
    INSERT INTO inference_providers
      (organization_id, slug, kind, api_key_ref, capabilities, status)
    VALUES (${organizationId}, ${slug}, 'openai',
            ${`secret://${organizationId}/${slug}`}, '{}'::jsonb, ${status})
  `;
}

async function providerHealth(
  organizationId: string,
  slug: string
): Promise<{ status: string; error_message: string | null }> {
  const rows = await getDb()<
    { status: string; error_message: string | null }[]
  >`
    SELECT status, error_message FROM inference_providers
    WHERE organization_id = ${organizationId} AND slug = ${slug}
  `;
  if (!rows[0]) throw new Error(`provider ${organizationId}/${slug} not found`);
  return rows[0];
}

function makeProxy(callerOrgId: string): InstanceType<typeof SecretProxy> {
  const proxy = new SecretProxy(
    { defaultUpstreamUrl: "https://default.example.com" },
    { get: async () => null } satisfies SecretStore
  );
  proxy.registerUpstream(
    { slug: "zai", upstreamBaseUrl: "https://myzai.example.com/v1" },
    "zai"
  );
  proxy.setAuthProfilesManager({
    // Must not be consulted on the org-only path (fail-closed to the row key).
    getBestProfile: async () => {
      throw new Error("profile lookup must not run on org-only path");
    },
    ensureFreshCredential: async () => undefined,
  } as never);
  // Independent source of the caller's org — prod supplies it from the signed
  // worker token / DB lookup, never from the request body.
  proxy.setAgentOrgResolver(async () => callerOrgId);
  return proxy;
}

/** Drive one proxied chat-completions request through the Hono app. */
async function driveProxiedTurn(proxy: InstanceType<typeof SecretProxy>) {
  return proxy
    .getApp()
    .request("/api/proxy/zai/a/agent-1/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer worker-token-test",
      },
      body: JSON.stringify({ model: "zai/glm-5.2", prompt: "hi" }),
    });
}

/** Swap globalThis.fetch for one upstream response; returns a restorer. */
function mockUpstream(status: number, headers: Record<string, string> = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("secret proxy — inference-provider health writeback", () => {
  // --- Turn-liveness wiring -------------------------------------------------
  // A terminal provider answer must ALSO stop the wedged turn from renewing its
  // own liveness deadline. This half is easy to ship INERT: it only runs when
  // the request carries a SIGNED worker token, and the other tests in this file
  // authenticate with an unsigned placeholder bearer, so they would pass
  // whether or not the wiring exists. These drive a real signed token.
  //
  // Every helper below builds its side the way PRODUCTION builds it, and that
  // is load-bearing rather than tidiness. The two sides come from two different
  // generators — the marker is armed under `generateDeploymentName(identity)`
  // by `MessageConsumer`, while the turn credential is signed under
  // `agent-turn:<messageId>` by `mintTurnToken` — so a test that invents one
  // name and uses it on both sides asserts a linkage production does not have.
  // These tests did exactly that, and passed while the feature was inert.

  const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";

  /** One turn's routing identity, in the shape both generators consume. */
  const TURN = {
    organizationId: "org-1",
    agentId: "agent-1",
    userId: "user-1",
    platform: "api",
    channelId: "chan",
    conversationId: "conv-1",
  };
  const MESSAGE_ID = "m-1";

  /** The name `MessageConsumer` arms this turn's marker under. */
  function markerDeployment(): string {
    return generateDeploymentName(TURN);
  }

  /** The credential `mintTurnToken` signs for this turn. */
  function signedTurnCredential() {
    return generateWorkerToken(
      TURN.userId,
      TURN.conversationId,
      `agent-turn:${MESSAGE_ID}`,
      {
        channelId: TURN.channelId,
        agentId: TURN.agentId,
        organizationId: TURN.organizationId,
        platform: TURN.platform,
        responseThreadId: "api:chan:thread-1",
        runId: 1,
        messageId: MESSAGE_ID,
      }
    );
  }

  async function armMarker(): Promise<void> {
    // `runs` has an FK to `organization`; the marker row needs a real org.
    await getDb()`
      INSERT INTO public.organization (id, name, slug)
      VALUES ('org-1', 'org-1', 'org-1')
      ON CONFLICT (id) DO NOTHING
    `;
    const queue = new RunsQueue();
    await queue.start();
    try {
      await armTurnTimeout(queue, {
        deploymentName: markerDeployment(),
        messageId: MESSAGE_ID,
        platform: TURN.platform,
        channelId: TURN.channelId,
        conversationId: TURN.conversationId,
        userId: TURN.userId,
        organizationId: TURN.organizationId,
      });
    } finally {
      await queue.stop();
    }
  }

  /** Read a marker field back by the deployment name it is addressable under. */
  async function markerField(
    deploymentName: string,
    field: "providerFailed" | "providerFailedCode"
  ): Promise<string | null> {
    const rows = (await getDb()`
      SELECT action_input->>${field} AS value
      FROM public.runs
      WHERE queue_name = ${TURN_TIMEOUT_QUEUE}
        AND action_input->>'deploymentName' = ${deploymentName}
    `) as Array<{ value: string | null }>;
    return rows[0]?.value ?? null;
  }

  /** Same as driveProxiedTurn, but authenticating with the real turn credential. */
  async function driveSignedTurn(proxy: InstanceType<typeof SecretProxy>) {
    return proxy
      .getApp()
      .request("/api/proxy/zai/a/agent-1/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${signedTurnCredential()}`,
        },
        body: JSON.stringify({ model: "zai/glm-5.2", prompt: "hi" }),
      });
  }

  test("TL1: a 429 flags the turn's marker so its heartbeat stops extending", async () => {
    await seedProvider("org-1", "zai");
    await armMarker();
    expect(await markerField(markerDeployment(), "providerFailed")).toBeNull();

    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429, { "retry-after": "60" });
    try {
      expect((await driveSignedTurn(proxy)).status).toBe(429);
    } finally {
      restore();
    }
    expect(await markerField(markerDeployment(), "providerFailed")).toBe("true");
    // The typed code is what the sweep relays to the client instead of its own
    // generic verdict, so an unflagged CODE is a silent downgrade even when the
    // boolean lands.
    expect(await markerField(markerDeployment(), "providerFailedCode")).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
  });

  test("TL2: a subsequent 2xx clears the flag so an SDK retry that recovers is not swept", async () => {
    await seedProvider("org-1", "zai");
    await armMarker();

    const proxy = makeProxy("org-1");
    let restore = mockUpstream(429, { "retry-after": "1" });
    try {
      await driveSignedTurn(proxy);
    } finally {
      restore();
    }
    expect(await markerField(markerDeployment(), "providerFailed")).toBe("true");

    restore = mockUpstream(200);
    try {
      expect((await driveSignedTurn(proxy)).status).toBe(200);
    } finally {
      restore();
    }
    expect(await markerField(markerDeployment(), "providerFailed")).toBeNull();
  });

  test("TL3: the marker is NOT addressable under the token's own deployment claim", async () => {
    // The regression guard for the defect above, stated as the invariant rather
    // than as "don't edit that line": a turn credential's `deploymentName`
    // claim scopes the CREDENTIAL, and is a different namespace from the
    // conversation deployment a marker lives under. Anything that resolves a
    // marker from a token must derive the name, never read the claim — reading
    // it matches zero rows, which is indistinguishable from a finished turn.
    await seedProvider("org-1", "zai");
    await armMarker();

    const claimedDeployment = `agent-turn:${MESSAGE_ID}`;
    expect(claimedDeployment).not.toBe(markerDeployment());

    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429, { "retry-after": "60" });
    try {
      expect((await driveSignedTurn(proxy)).status).toBe(429);
    } finally {
      restore();
    }
    // The flag landed on the real marker, and nothing was created under the
    // claim — a lookup keyed on the claim would still find nothing.
    expect(await markerField(markerDeployment(), "providerFailed")).toBe("true");
    expect(await markerField(claimedDeployment, "providerFailed")).toBeNull();
  });

  test("an upstream quota rejection (429) marks the provider row error", async () => {
    await seedProvider("org-1", "zai");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429, { "retry-after": "60" });
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(429);
      expect(await providerHealth("org-1", "zai")).toEqual({
        status: "error",
        error_message: "HTTP 429 (retry-after: 60) — PROVIDER_QUOTA_EXHAUSTED",
      });
    } finally {
      restore();
    }
  });

  test("a rejected credential (401) marks it too, without a horizon", async () => {
    await seedProvider("org-1", "zai");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(401);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(401);
      expect(await providerHealth("org-1", "zai")).toEqual({
        status: "error",
        error_message: "HTTP 401 — PROVIDER_AUTH",
      });
    } finally {
      restore();
    }
  });

  test("the next successful (2xx) completion clears the error", async () => {
    await seedProvider("org-1", "zai", "error");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(200);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(200);
      expect(await providerHealth("org-1", "zai")).toEqual({
        status: "active",
        error_message: null,
      });
    } finally {
      restore();
    }
  });

  test("a caller-fault status (400) carries no health signal — it does NOT clear", async () => {
    // "No signal" is distinct from "healthy": a bad-request 400 from the same
    // provider must neither mark nor resurrect-clear the row.
    await seedProvider("org-1", "zai", "error");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(400);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(400);
      expect((await providerHealth("org-1", "zai")).status).toBe("error");
    } finally {
      restore();
    }
  });

  test("the health write is org-scoped: another tenant's same-slug row is untouched", async () => {
    await seedProvider("org-1", "zai");
    await seedProvider("org-2", "zai");
    // Caller identity resolves to org-1 only.
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(429);
      expect((await providerHealth("org-1", "zai")).status).toBe("error");
      expect(await providerHealth("org-2", "zai")).toEqual({
        status: "active",
        error_message: null,
      });
    } finally {
      restore();
    }
  });
});
