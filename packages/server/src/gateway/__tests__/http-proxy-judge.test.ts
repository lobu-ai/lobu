import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type * as http from "node:http";
import * as net from "node:net";
import type { AgentInlineGuardrail } from "@lobu/core";
import { generateWorkerTokenPair } from "@lobu/core";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { GrantStore } from "../permissions/grant-store.js";
import { PolicyStore } from "../permissions/policy-store.js";
import { EgressJudge } from "../proxy/egress-judge/judge.js";
import type { JudgeClient, JudgeVerdict } from "../proxy/egress-judge/types.js";
import { withFreePortRetry } from "../../__tests__/setup/free-port.js";
import {
  __testOnly,
  setProxyEgressJudge,
  setProxyGrantStore,
  setProxyPolicyStore,
  startHttpProxy,
  stopHttpProxy,
} from "../proxy/http-proxy.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

let proxyPort: number;
let proxyServer: http.Server;

/**
 * Swappable fake judge — tests replace `impl` between cases so they can
 * simulate allow/deny/timeout without restarting the proxy. `impl` sees the
 * composed prompt, which carries the guardrail's policy text, so a case can
 * give two judges on one host different verdicts.
 */
class FakeJudgeClient implements JudgeClient {
  calls = 0;
  impl: (args: { userPrompt: string }) => Promise<JudgeVerdict> = async () => ({
    verdict: "deny",
    reason: "default",
  });
  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    this.calls++;
    return this.impl(args);
  }
}

const fakeClient = new FakeJudgeClient();

// `example.com` is used for the allow-path HTTP tests because its real server
// closes the socket after responding — tests that use hosts with keep-alive
// (api.github.com, etc.) hang the raw socket reader.
const BASE_GUARDRAILS: AgentInlineGuardrail[] = [
  {
    name: "default",
    enabled: true,
    stage: "egress",
    policy: "allow only reads from trusted sources",
    domains: ["example.com"],
  },
  {
    name: "strict",
    enabled: true,
    stage: "egress",
    policy: "deny all requests — always",
    domains: [".slack.com"],
  },
];

/**
 * Save the agent's guardrails through the real settings store — the same
 * write the config route and `manage_agents` make — so the proxy's view of the
 * policy is exactly what a save leaves in Postgres.
 */
async function saveGuardrails(
  guardrailsInline: AgentInlineGuardrail[],
  organizationId = "org-a"
): Promise<void> {
  await orgContext.run({ organizationId }, () =>
    createPostgresAgentConfigStore().updateSettings("agent-a", {
      guardrailsInline,
    })
  );
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
  await resetTestDatabase();
  // Empty allowlist = deny-all globally so requests fall through to the
  // per-agent judged-domain rules.
  process.env.WORKER_ALLOWED_DOMAINS = "";

  // Clear module-level state left behind by any sibling test file so
  // the global config gets re-read with the new env.
  __testOnly.reset();

  await seedAgentRow("agent-a", { organizationId: "org-a" });
  await saveGuardrails(BASE_GUARDRAILS);

  setProxyPolicyStore(new PolicyStore());
  setProxyEgressJudge(
    new EgressJudge({ client: fakeClient, resolveOrgDefaultModel: async () => "judge-test-model" })
  );

  // Ask the OS for a free port and retry on collision instead of gambling on a
  // random high port — concurrent test load otherwise races to EADDRINUSE (#976).
  proxyServer = await withFreePortRetry(async (port) => {
    const server = await startHttpProxy(port, "127.0.0.1");
    proxyPort = port;
    return server;
  });
}, 60_000);

afterAll(async () => {
  await stopHttpProxy(proxyServer);
  delete process.env.WORKER_ALLOWED_DOMAINS;
  __testOnly.reset();
});

function makeBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function createValidToken(deploymentName: string): string {
  return generateWorkerTokenPair("test-user", "test-conv", deploymentName, {
    channelId: "test-channel",
    platform: "test",
    agentId: "agent-a",
    organizationId: "org-a",
  }).egressProxyToken;
}

function rawProxyRequest(
  targetUrl: string,
  proxyAuth: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      const u = new URL(targetUrl);
      const req =
        `GET ${targetUrl} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Proxy-Authorization: ${proxyAuth}\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(req);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      const statusLine = data.substring(0, data.indexOf("\r\n"));
      const match = statusLine.match(/HTTP\/\d\.\d (\d+)/);
      const statusCode = match ? parseInt(match[1]!, 10) : 0;
      const headerEnd = data.indexOf("\r\n\r\n");
      const body = headerEnd !== -1 ? data.substring(headerEnd + 4) : "";
      resolve({ statusCode, body });
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

function connectRequest(
  host: string,
  port: number,
  proxyAuth: string
): Promise<{ statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      const req =
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Proxy-Authorization: ${proxyAuth}\r\n\r\n`;
      socket.write(req);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      const lineEnd = data.indexOf("\r\n");
      if (lineEnd !== -1) {
        socket.destroy();
        resolve({ statusLine: data.substring(0, lineEnd) });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

describe("HTTP Proxy — egress judge integration", () => {
  const deploymentName = "judge-test-worker";
  const auth = () =>
    makeBasicAuth(deploymentName, createValidToken(deploymentName));

  test("denies requests to domains with no judged rule (deny-all fallthrough)", async () => {
    fakeClient.calls = 0;
    const res = await rawProxyRequest("http://unknown.example.com/", auth());
    expect(res.statusCode).toBe(403);
    expect(fakeClient.calls).toBe(0);
  });

  test("consults the judge and forwards when the verdict is allow", async () => {
    fakeClient.calls = 0;
    fakeClient.impl = async () => ({
      verdict: "allow",
      reason: "within policy",
    });
    const res = await rawProxyRequest("http://example.com/", auth());
    // The judge ran once. What happens after depends on the sandbox's
    // ability to reach example.com — in a CI box with no network or
    // resolver routing to a private IP, the proxy may return 502/403 from
    // the target-resolution layer. Those are downstream of the judge and
    // aren't what we're testing here. If the judge itself had denied we'd
    // see the exact deny reason in the body, so assert that too.
    expect(fakeClient.calls).toBe(1);
    expect(res.body).not.toContain("within policy"); // would be a judge-deny 403
  });

  test("consults the judge and blocks with judge reason when the verdict is deny", async () => {
    fakeClient.calls = 0;
    fakeClient.impl = async () => ({
      verdict: "deny",
      reason: "unknown-path",
    });
    const res = await rawProxyRequest("http://example.com/secret", auth());
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("unknown-path");
    expect(fakeClient.calls).toBe(1);
  });

  test("second identical request uses the verdict cache (no extra judge call)", async () => {
    fakeClient.calls = 0;
    fakeClient.impl = async () => ({
      verdict: "deny",
      reason: "cached-deny",
    });
    // Deny + 403 path closes fast, so repeated requests are reliable without
    // depending on the upstream response.
    await rawProxyRequest("http://example.com/cached-path", auth());
    await rawProxyRequest("http://example.com/cached-path", auth());
    expect(fakeClient.calls).toBe(1);
  });

  test("matches a wildcard rule and uses the named judge policy (CONNECT)", async () => {
    fakeClient.calls = 0;
    fakeClient.impl = async () => ({
      verdict: "deny",
      reason: "strict blocks everything",
    });
    const res = await connectRequest("api.slack.com", 443, auth());
    expect(res.statusLine).toContain("403");
    expect(fakeClient.calls).toBe(1);
  });

  test("judge failure fails closed with a 403", async () => {
    fakeClient.calls = 0;
    fakeClient.impl = async () => {
      throw new Error("upstream broken");
    };
    const res = await rawProxyRequest("http://example.com/probe", auth());
    expect(res.statusCode).toBe(403);
  });

  test("an explicit deny grant blocks before the judge is consulted", async () => {
    // A per-agent deny grant is authoritative: even a judged domain with an
    // allow-everything judge must never be reached.
    const denyAllGrants = {
      isDenied: async () => true,
      hasGrant: async () => false,
    } as unknown as GrantStore;
    setProxyGrantStore(denyAllGrants);
    try {
      fakeClient.calls = 0;
      fakeClient.impl = async () => ({
        verdict: "allow",
        reason: "judge-would-allow",
      });
      const res = await rawProxyRequest(
        "http://example.com/deny-grant-path",
        auth()
      );
      expect(res.statusCode).toBe(403);
      expect(fakeClient.calls).toBe(0);
    } finally {
      setProxyGrantStore(null as unknown as GrantStore);
    }
  });

  test("every judge covering the host runs, and a shorter wildcard's deny wins", async () => {
    // An exact rule used to shadow every covering wildcard: only the longest
    // match was asked, so the exact rule's ALLOW let traffic through that the
    // broader rule's judge would have refused.
    await saveGuardrails([
      ...BASE_GUARDRAILS,
      {
        name: "broad",
        enabled: true,
        stage: "egress",
        policy: "BROAD: refuse everything under acme",
        domains: [".acme.test"],
      },
      {
        name: "narrow",
        enabled: true,
        stage: "egress",
        policy: "NARROW: the api host is fine",
        domains: ["api.acme.test"],
      },
    ]);
    try {
      fakeClient.calls = 0;
      fakeClient.impl = async ({ userPrompt }) =>
        userPrompt.includes("BROAD:")
          ? { verdict: "deny", reason: "broad-judge-refused" }
          : { verdict: "allow", reason: "narrow-judge-allowed" };
      const res = await rawProxyRequest(
        "http://api.acme.test/accumulate",
        auth()
      );
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("broad-judge-refused");
      expect(fakeClient.calls).toBe(2);
    } finally {
      await saveGuardrails(BASE_GUARDRAILS);
    }
  });

  test("a policy saved after the proxy warmed up is enforced on the next request", async () => {
    // The proxy's PolicyStore already loaded this agent above. A save made
    // anywhere (another replica, the config route) must reach it without a
    // dispatch, a deploy, or a restart.
    fakeClient.calls = 0;
    fakeClient.impl = async () => ({ verdict: "deny", reason: "late-judge" });
    const before = await rawProxyRequest("http://late.example.org/a", auth());
    expect(before.statusCode).toBe(403);
    expect(fakeClient.calls).toBe(0);

    await saveGuardrails([
      ...BASE_GUARDRAILS,
      {
        name: "late",
        enabled: true,
        stage: "egress",
        policy: "added after warm-up",
        domains: ["late.example.org"],
      },
    ]);
    try {
      const after = await rawProxyRequest("http://late.example.org/b", auth());
      expect(after.statusCode).toBe(403);
      expect(after.body).toContain("late-judge");
      expect(fakeClient.calls).toBe(1);
    } finally {
      await saveGuardrails(BASE_GUARDRAILS);
    }

    // ...and removing it is just as immediate: no judge, deny-all fallthrough.
    fakeClient.calls = 0;
    const removed = await rawProxyRequest("http://late.example.org/c", auth());
    expect(removed.statusCode).toBe(403);
    expect(fakeClient.calls).toBe(0);
  });
});

describe("PolicyStore — Postgres is the source every replica reads", () => {
  test("a fresh process sees a just-saved policy, scoped to its organization", async () => {
    await saveGuardrails([
      ...BASE_GUARDRAILS,
      {
        name: "fresh",
        enabled: true,
        stage: "egress",
        policy: "fresh replica policy",
        model: "openai/gpt-4o-mini",
        domains: ["*.fresh.test"],
      },
    ]);
    try {
      // A second replica: a brand-new store that never saw a dispatch.
      const replica = new PolicyStore();
      const rules = await replica.resolve("org-a", "agent-a", "API.fresh.test");
      expect(rules.map((r) => r.judgeName)).toEqual(["fresh"]);
      expect(rules[0]?.policy).toBe("fresh replica policy");
      expect(rules[0]?.judgeModel).toBe("openai/gpt-4o-mini");
      // The same agent id in another org owns none of it.
      await seedAgentRow("agent-a", { organizationId: "org-b" });
      expect(await replica.resolve("org-b", "agent-a", "api.fresh.test")).toEqual(
        []
      );
    } finally {
      await saveGuardrails(BASE_GUARDRAILS);
    }
  });
});
