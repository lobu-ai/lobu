import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWorkerToken } from "@lobu/core";
import { AgentProgressProcessor } from "../../../../agent-worker/src/runtime/processor.js";
import { runAISession } from "../../../../agent-worker/src/runtime/session-runner.js";
import { invalidateSessionContextCache } from "../../../../agent-worker/src/runtime/session-context.js";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { ChatGPTOAuthModule } from "../auth/chatgpt/chatgpt-oauth-module.js";
import type { BaseProviderModule } from "../auth/base-provider-module.js";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";

const ORG = "org-credential-test";
const USER = "user-credential-test";
const AGENT = "agent-credential-test";
const ACCOUNT = "acct_credential_test";
const STORED_CREDENTIAL = "synthetic-stored-oauth-credential";

function makeManager() {
  return new AuthProfilesManager({
    ephemeralProfiles: { get: () => undefined } as never,
    declaredAgents: { get: () => undefined } as never,
    userAuthProfiles: {
      list: async (userId: string, agentId: string) =>
        userId === USER && agentId === `__org_oauth__:${ORG}`
          ? [{
              id: "profile-credential-test", provider: "chatgpt", model: "*",
              authType: "oauth", credential: STORED_CREDENTIAL,
              metadata: { accountId: ACCOUNT, expiresAt: Date.now() + 3_600_000 },
              createdAt: 0,
            }]
          : [],
    } as never,
    secretStore: { get: async () => undefined } as never,
    agentOwnerResolver: async () => USER,
    agentOrgResolver: async () => ORG,
  });
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["ENCRYPTION_KEY", "DISPATCHER_URL", "WORKER_TOKEN"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  invalidateSessionContextCache();
});

describe("ChatGPT subscription credentials", () => {
  test("org-bucket account reaches the placeholder without exposing its credential", async () => {
    const module: BaseProviderModule = new ChatGPTOAuthModule(makeManager());
    const placeholder = await module.buildCredentialPlaceholder(AGENT, {
      organizationId: ORG, userId: USER,
    });
    expect(placeholder).not.toBe(STORED_CREDENTIAL);
    expect(placeholder.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(placeholder.split(".")[1]!, "base64url").toString()))
      .toEqual({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
  });

  test("another user cannot borrow the agent owner's subscription", async () => {
    const module: BaseProviderModule = new ChatGPTOAuthModule(makeManager());
    expect(await module.buildCredentialPlaceholder(AGENT, {
      organizationId: ORG, userId: "unlinked-user",
    })).toBe("lobu-proxy");
    expect(await module.buildCredentialPlaceholder(AGENT)).toBe("lobu-proxy");
  });

  test("model listing retains the requesting user", async () => {
    const module = new ChatGPTOAuthModule(makeManager());
    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return Response.json({ models: [{ slug: "test-model", title: "Test model" }] });
    }) as typeof fetch;
    try {
      expect(await module.getModelOptions(AGENT, USER)).toEqual([
        { value: "openai-codex/test-model", label: "Test model" },
      ]);
      expect(authorization).toBe(`Bearer ${STORED_CREDENTIAL}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const defaultProvider of ["chatgpt", "deepseek"]) {
    for (const reverse of [false, true]) {
      test(`real worker uses ChatGPT with ${defaultProvider} default; reverse=${reverse}`, async () => {
        process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
        const manager = makeManager();
        const chatgpt = new ChatGPTOAuthModule(manager);
        const openai = new ApiKeyProviderModule({
          providerId: "openai", providerDisplayName: "OpenAI", providerIconUrl: "",
          envVarName: "OPENAI_API_KEY", upstreamBaseUrl: "https://openai.example.invalid",
          sdkCompat: "openai", authProfilesManager: manager,
        });
        const deepseek = new ApiKeyProviderModule({
          providerId: "deepseek", providerDisplayName: "DeepSeek", providerIconUrl: "",
          envVarName: "DEEPSEEK_API_KEY", upstreamBaseUrl: "https://deepseek.example.invalid",
          sdkCompat: "openai", authProfilesManager: manager,
        });
        const modules = [chatgpt, openai, deepseek];
        if (reverse) modules.reverse();
        // Availability is fixture-owned; account lookup and placeholder generation
        // below use the real provider modules and org-bucket profile manager.
        for (const module of modules) module.hasSystemKey = () => true;
        const model = defaultProvider === "chatgpt" ? "chatgpt/gpt-5.5" : "deepseek/default-model";
        const gateway = new WorkerGateway(
          { send: async () => undefined } as never,
          "https://gateway.example.invalid",
          { getWorkerConfig: async () => ({ mcpServers: {} }) } as never,
          { getSessionContext: async () => ({
              agentLayers: { identityMd: "Synthetic test agent", soulMd: "", userMd: "", unconfiguredNotice: "" },
              platformInstructions: "", networkInstructions: "", skillsInstructions: "", mcpStatus: [],
            }) } as never,
          undefined,
          {
            getInstalledModules: async () => modules,
            resolveDispatchModel: async () => ({ model }),
            findProviderForModel: async (ref: string) => modules.find((m) => m.providerId === ref.split("/")[0]),
          } as never,
          { getSettings: async () => ({ models: [model] }) } as never,
        );
        const conversationId = `conversation-${defaultProvider}-${reverse}`;
        const workerToken = generateWorkerToken(USER, conversationId, "worker-test", {
          channelId: "channel-test", agentId: AGENT, organizationId: ORG,
        });
        let upstreamRequests = 0;
        let receivedAccount: string | null = null;
        let receivedModel: unknown;
        let providerConfig: Record<string, unknown> | undefined;
        const server = Bun.serve({
          hostname: "127.0.0.1", port: 0,
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/worker/session-context") {
              url.pathname = "/session-context";
              const response = await gateway.getApp().request(new Request(url, request));
              const body = await response.clone().json();
              providerConfig = body.providerConfig;
              return response;
            }
            if (url.pathname.endsWith("/codex/responses")) {
              // The production adapter probes WebSocket before falling back to SSE.
              if (request.method !== "POST") return new Response(null, { status: 426 });
              upstreamRequests++;
              receivedAccount = request.headers.get("chatgpt-account-id");
              receivedModel = (await request.json()).model;
              const item = { id: "msg-test", type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "credential-test-ok", annotations: [] }] };
              const events = [
                { type: "response.created", response: { id: "resp-test", status: "in_progress" } },
                { type: "response.output_item.added", item: { ...item, content: [], status: "in_progress" } },
                { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
                { type: "response.output_text.delta", delta: "credential-test-ok" },
                { type: "response.output_item.done", item },
                { type: "response.completed", response: { id: "resp-test", status: "completed", output: [item],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
              ];
              return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                headers: { "Content-Type": "text/event-stream" },
              });
            }
            return new Response("Unexpected test request", { status: 404 });
          },
        });
        const workspaceDir = await mkdtemp(join(tmpdir(), "lobu-credential-test-"));
        process.env.DISPATCHER_URL = `http://127.0.0.1:${server.port}`;
        process.env.WORKER_TOKEN = workerToken;
        const processor = new AgentProgressProcessor();
        try {
          const result = await runAISession({
            userPrompt: "Reply credential-test-ok. Do not use tools.", customInstructions: "",
            agentOptions: JSON.stringify({ model: "chatgpt/gpt-5.5", memoryFlush: { enabled: false } }),
            sessionKey: conversationId, channelId: "channel-test", conversationId, platform: "api",
            platformMetadata: {}, organizationId: ORG, actorId: USER, credentialSubject: USER,
            agentId: AGENT, runId: 1, messageId: "message-test", workspaceDir, progressProcessor: processor,
            onProgress: async () => {}, onSessionFilePathResolved: () => {}, onSteerReady: () => {},
            onCancelReady: () => {}, onModelResolved: () => {}, loadImageAttachments: async () => [],
            maybeRunPreCompactionMemoryFlush: async () => {},
          });
          expect(result.error).toBeUndefined();
          expect(result.success).toBe(true);
          expect(upstreamRequests).toBe(1);
          expect(receivedAccount).toBe(ACCOUNT);
          expect(receivedModel).toBe("gpt-5.5");
          expect(processor.getOutputSnapshot()).toContain("credential-test-ok");
          expect(JSON.stringify(providerConfig)).not.toContain(STORED_CREDENTIAL);
          const placeholders = providerConfig?.credentialPlaceholders as Record<string, string>;
          expect(placeholders.openai).toBe(workerToken);
          expect(placeholders.deepseek).toBe(workerToken);
          expect(placeholders.chatgpt).not.toBe(workerToken);
        } finally {
          server.stop(true);
          gateway.shutdown();
          await rm(workspaceDir, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }
});
