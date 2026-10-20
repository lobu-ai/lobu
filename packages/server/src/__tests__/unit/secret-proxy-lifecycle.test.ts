/**
 * Secret-proxy lifecycle & rate-limiting contract.
 *
 *  - placeholder mappings past their TTL are not resolved (orphan GC)
 *  - repeated bad placeholders from one source get throttled after the
 *    threshold (compromised-worker probe / log-spam guard)
 *  - a valid placeholder always resolves and is swapped into the auth header
 *  - a placeholder bound to agent A used on agent B's URL is still 403
 *    (cross-agent credential theft — unchanged semantics, pinned here)
 */

import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import type { SecretStore } from "../../gateway/secrets/index.js";
import {
  __resetPlaceholderCacheForTests,
  generatePlaceholder,
  SecretProxy,
  storeSecretMapping,
} from "../../gateway/proxy/secret-proxy.js";

const PLACEHOLDER_PREFIX = "lobu_secret_";

function makeSecretStore(value: string): SecretStore {
  return {
    async get() {
      return value;
    },
  } as unknown as SecretStore;
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  __resetPlaceholderCacheForTests();
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPlaceholderCacheForTests();
});

function makeProxy(secret = "real-secret"): SecretProxy {
  return new SecretProxy(
    { defaultUpstreamUrl: "https://upstream.example.com" },
    makeSecretStore(secret)
  );
}

async function callProxy(
  proxy: SecretProxy,
  path: string,
  bearer: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return proxy.getApp().request(`http://proxy.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, ...headers },
    body: "{}",
  });
}

describe("secret-proxy placeholder TTL", () => {
  it("does not resolve a mapping past its TTL", async () => {
    const uuid = crypto.randomUUID();
    // Negative TTL → already expired.
    storeSecretMapping(
      uuid,
      {
        agentId: "agent-a",
        envVarName: "MY_TOKEN",
        secretRef: "builtin:deployments/d/agent-a/MY_TOKEN",
        deploymentName: "d",
      },
      -1
    );
    const proxy = makeProxy("real-secret");
    await callProxy(proxy, "/v1/thing", `${PLACEHOLDER_PREFIX}${uuid}`);
    expect(captured).toHaveLength(1);
    // Expired mapping → fail closed → empty auth forwarded.
    expect(captured[0]!.headers.authorization).toBe("Bearer ");
  });

  it("resolves a live mapping and swaps the real secret into the auth header", async () => {
    const placeholder = generatePlaceholder(
      "agent-a",
      "MY_TOKEN",
      "builtin:deployments/d/agent-a/MY_TOKEN",
      "d"
    );
    const proxy = makeProxy("real-secret");
    await callProxy(proxy, "/v1/thing", placeholder);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers.authorization).toBe("Bearer real-secret");
  });
});

describe("secret-proxy failed-resolution throttle", () => {
  // Production runs behind Cloudflare and Traefik: the visitor is the second
  // X-Forwarded-For entry from the right, after any client-supplied prefix.
  const prevTrustedProxy = process.env.TRUSTED_PROXY;
  beforeAll(() => {
    process.env.TRUSTED_PROXY = "2";
  });
  afterAll(() => {
    if (prevTrustedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = prevTrustedProxy;
  });
  const via = (client: string, forged?: string) => ({
    "x-forwarded-for": [forged, client, "172.69.0.1"]
      .filter(Boolean)
      .join(", "),
  });

  it("throttles a source after repeated bad placeholders, even for a later valid one", async () => {
    const proxy = makeProxy("real-secret");
    const source = "203.0.113.7";

    // 20 bad lookups: each fails closed but is still attempted.
    for (let i = 0; i < 20; i++) {
      await callProxy(
        proxy,
        "/v1/thing",
        `${PLACEHOLDER_PREFIX}${crypto.randomUUID()}`,
        via(source)
      );
    }
    // Now register a genuinely valid placeholder...
    const placeholder = generatePlaceholder(
      "agent-a",
      "MY_TOKEN",
      "builtin:deployments/d/agent-a/MY_TOKEN",
      "d"
    );
    // ...and call from the throttled source: still fails closed (empty auth).
    await callProxy(proxy, "/v1/thing", placeholder, via(source));
    expect(captured[captured.length - 1]!.headers.authorization).toBe(
      "Bearer "
    );

    // A different source with the same valid placeholder still works.
    await callProxy(proxy, "/v1/thing", placeholder, via("198.51.100.2"));
    expect(captured[captured.length - 1]!.headers.authorization).toBe(
      "Bearer real-secret"
    );
  });

  it("does not throttle a source doing many valid lookups", async () => {
    const proxy = makeProxy("real-secret");
    const placeholder = generatePlaceholder(
      "agent-a",
      "MY_TOKEN",
      "builtin:deployments/d/agent-a/MY_TOKEN",
      "d"
    );
    for (let i = 0; i < 50; i++) {
      await callProxy(proxy, "/v1/thing", placeholder, via("203.0.113.99"));
    }
    expect(captured[captured.length - 1]!.headers.authorization).toBe(
      "Bearer real-secret"
    );
  });
  it("a forged X-Forwarded-For prefix can't open a fresh bucket", async () => {
    const proxy = makeProxy("real-secret");
    for (let i = 0; i < 20; i++) {
      await callProxy(
        proxy,
        "/v1/thing",
        `${PLACEHOLDER_PREFIX}${crypto.randomUUID()}`,
        via("203.0.113.8", `10.0.0.${i}`)
      );
    }
    const placeholder = generatePlaceholder(
      "agent-a",
      "MY_TOKEN",
      "builtin:deployments/d/agent-a/MY_TOKEN",
      "d"
    );
    await callProxy(
      proxy,
      "/v1/thing",
      placeholder,
      via("203.0.113.8", "10.0.0.250")
    );
    expect(captured[captured.length - 1]!.headers.authorization).toBe(
      "Bearer "
    );
  });
});

describe("secret-proxy throttle keys on the signed worker identity", () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prevKey;
  });

  it("a worker can't dodge the throttle by rotating x-forwarded-for when it carries a signed token", async () => {
    const proxy = makeProxy("real-secret");
    const tokenX = generateWorkerToken("u", "c", "deploy-x", {
      channelId: "ch",
      agentId: "agent-x",
    });

    // 20 bad lookups from the SAME signed identity but a DIFFERENT forged
    // x-forwarded-for each time. If the throttle keyed on the header these
    // would land in 20 distinct buckets and never trip.
    for (let i = 0; i < 20; i++) {
      await callProxy(
        proxy,
        "/v1/thing",
        `${PLACEHOLDER_PREFIX}${crypto.randomUUID()}`,
        { "x-lobu-worker-token": tokenX, "x-forwarded-for": `10.0.0.${i}` }
      );
    }

    // A valid placeholder from the same identity is still throttled.
    const placeholder = generatePlaceholder(
      "agent-a",
      "MY_TOKEN",
      "builtin:deployments/d/agent-a/MY_TOKEN",
      "d"
    );
    await callProxy(proxy, "/v1/thing", placeholder, {
      "x-lobu-worker-token": tokenX,
      "x-forwarded-for": "10.0.0.250",
    });
    expect(captured[captured.length - 1]!.headers.authorization).toBe(
      "Bearer "
    );

    // A DIFFERENT signed identity is an independent bucket → resolves.
    const tokenY = generateWorkerToken("u", "c", "deploy-y", {
      channelId: "ch",
      agentId: "agent-y",
    });
    await callProxy(proxy, "/v1/thing", placeholder, {
      "x-lobu-worker-token": tokenY,
    });
    expect(captured[captured.length - 1]!.headers.authorization).toBe(
      "Bearer real-secret"
    );
  });
});

describe("secret-proxy cross-agent binding (unchanged)", () => {
  it("rejects a placeholder bound to agent A used on agent B's URL with 403", async () => {
    const proxy = new SecretProxy(
      {
        defaultUpstreamUrl: "https://upstream.example.com",
        providerUpstreams: [
          { slug: "anthropic", upstreamBaseUrl: "https://api.anthropic.com" },
        ],
      },
      makeSecretStore("real-secret")
    );
    const placeholder = generatePlaceholder(
      "agent-a",
      "ANTHROPIC_API_KEY",
      "builtin:deployments/d/agent-a/ANTHROPIC_API_KEY",
      "d"
    );
    const res = await callProxy(
      proxy,
      "/api/proxy/anthropic/a/agent-b/v1/messages",
      placeholder
    );
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("allows a placeholder used on its own agent's URL", async () => {
    const proxy = new SecretProxy(
      {
        defaultUpstreamUrl: "https://upstream.example.com",
        providerUpstreams: [
          { slug: "anthropic", upstreamBaseUrl: "https://api.anthropic.com" },
        ],
      },
      makeSecretStore("real-secret")
    );
    const placeholder = generatePlaceholder(
      "agent-a",
      "ANTHROPIC_API_KEY",
      "builtin:deployments/d/agent-a/ANTHROPIC_API_KEY",
      "d"
    );
    const res = await callProxy(
      proxy,
      "/api/proxy/anthropic/a/agent-a/v1/messages",
      placeholder
    );
    expect(res.status).toBe(200);
  });
});
