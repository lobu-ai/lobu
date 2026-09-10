import { afterEach, expect, test } from "bun:test";
import type { ProviderCredentialContext } from "../../../embedded.js";
import { ChatGPTOAuthModule } from "../chatgpt-oauth-module.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic`;

class TestModule extends ChatGPTOAuthModule {
  credential: string | null = token;
  seenContext?: ProviderCredentialContext;
  constructor() { super({} as never); }
  protected override async getCredential(_agentId: string, context?: ProviderCredentialContext): Promise<string | null> {
    this.seenContext = context;
    return this.credential;
  }
}

test("reads the exact account-scoped Codex model's runtime capabilities", async () => {
  let request: RequestInit | undefined;
  let url = "";
  globalThis.fetch = (async (input, init) => {
    url = String(input); request = init;
    return Response.json({ models: [
      { slug: "different-model", context_window: 1000 },
      { slug: "synthetic-new-model", context_window: 272000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "medium" }] },
    ] });
  }) as typeof fetch;
  const module = new TestModule();
  const context = { organizationId: "synthetic-org", userId: "synthetic-user" };
  expect(await module.getModelMetadata("synthetic-agent", "synthetic-new-model", context)).toEqual({ contextWindow: 272000, reasoning: true, input: ["text", "image"] });
  expect(module.seenContext).toEqual(context);
  expect(new URL(url).pathname).toBe("/backend-api/codex/models");
  expect(new URL(url).searchParams.get("client_version")).toBeTruthy();
  expect(new Headers(request?.headers).get("ChatGPT-Account-Id")).toBe("synthetic-account");
  expect(new Headers(request?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  expect(request?.redirect).toBe("error");
  expect(request?.signal).toBeDefined();
});

test.each([null, "not-a-jwt"])("does not fetch without account-scoped credentials: %s", async credential => {
  const module = new TestModule(); module.credential = credential;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("Must not fetch"); }) as typeof fetch;
  expect(await module.getModelMetadata("synthetic-agent", "synthetic-model", {})).toBeUndefined();
  expect(calls).toBe(0);
});

// A catalog that cannot be read, or reads back as junk, must leave the caller
// on its registry defaults — including an EMPTY reasoning list, which says
// nothing rather than "this model cannot reason".
test.each([
  ["network", undefined],
  ["status", undefined],
  ["json", undefined],
  ["missing", undefined],
  ["malformed", {}],
  ["no-reasoning-levels", {}],
] as const)("contains %s catalog failures without asserting capabilities", async (mode, expected) => {
  globalThis.fetch = (async () => {
    if (mode === "network") throw new Error("Synthetic transport failure");
    if (mode === "status") return new Response("Unavailable", { status: 503 });
    if (mode === "json") return new Response("not JSON");
    if (mode === "missing") return Response.json({ models: [] });
    if (mode === "no-reasoning-levels") return Response.json({ models: [{ slug: "synthetic-model", supported_reasoning_levels: [] }] });
    return Response.json({ models: [{ slug: "synthetic-model", context_window: -1, supported_reasoning_levels: ["invalid"], input_modalities: [null] }] });
  }) as typeof fetch;
  expect(await new TestModule().getModelMetadata("synthetic-agent", "synthetic-model", {})).toEqual(expected);
});
