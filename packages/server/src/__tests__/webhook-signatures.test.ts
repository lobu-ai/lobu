/**
 * Webhook signature verification — regression tests.
 *
 * Inbound chat-platform webhooks are authenticated by the Chat SDK adapter,
 * not the HTTP route. These tests pin that contract:
 *
 *  1. The Slack adapter (`@chat-adapter/slack`) rejects a forged
 *     `x-slack-signature` with HTTP 401 and accepts a correctly-signed
 *     payload — proving the HMAC-SHA256(`v0:{ts}:{rawBody}`) check is live.
 *  2. The Slack app-webhook provider (`POST /api/v1/app-webhooks/slack`)
 *     performs the edge `v0` signing + freshness verify (replay defense) and,
 *     only on success, delegates everything to
 *     `ChatInstanceManager.handleChatAppWebhook`, which fans out to the
 *     adapter described above. The bespoke `/slack/events` route was folded
 *     into this generic endpoint.
 */

import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createAppWebhookRoutes,
  createChatWebhookDelivery,
  createDeclaredAppWebhookProvider,
} from "../gateway/routes/public/app-webhooks.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

/** Slack's DECLARED webhook schema (mirror of the slack connector's block). */
const SLACK_WEBHOOK_SCHEMA: ConnectorWebhookSchema = {
  signatureHeader: "x-slack-signature",
  algorithm: "sha256",
  signaturePrefix: "v0=",
  signingBaseTemplate: "v0:{timestamp}:{body}",
  timestampHeader: "x-slack-request-timestamp",
  freshnessSeconds: 300,
  delivery: "app_installation",
  routingKeyPaths: ["team_id", "team.id", "event.team_id"],
};

function slackSignature(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("Slack adapter webhook signature verification", () => {
  const adapter = createSlackAdapter({
    signingSecret: SIGNING_SECRET,
    botToken: "xoxb-test",
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
  });

  it("rejects a payload with a forged signature (401)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const ts = nowTs();
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        // Wrong secret → signature won't match.
        "x-slack-signature": `v0=${createHmac("sha256", "not-the-secret")
          .update(`v0:${ts}:${body}`)
          .digest("hex")}`,
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
  });

  it("rejects a payload with no signature header (401)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": nowTs(),
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
  });

  it("rejects a stale-but-correctly-signed payload (replay, 401)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 60); // 1h old
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": slackSignature(body, ts),
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
  });

  it("accepts a correctly-signed url_verification challenge", async () => {
    const challenge = "test-challenge-123";
    const body = JSON.stringify({ type: "url_verification", challenge });
    const ts = nowTs();
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": slackSignature(body, ts),
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe(challenge);
  });
});

describe("slack app-webhook provider route", () => {
  // The Slack provider runs only the edge verify through the generic router,
  // then delegates; verify+secret resolution are pure (no DB), and the
  // delegate handler is stubbed, so this needs no Postgres.
  function makeRouter(handleChatAppWebhook: (req: Request) => Promise<Response>) {
    return createAppWebhookRoutes({
      installationStore: {} as never,
      providers: [
        createDeclaredAppWebhookProvider({
          provider: "slack",
          appId: "slack-app",
          webhookSchema: SLACK_WEBHOOK_SCHEMA,
          handleDelivery: createChatWebhookDelivery({ handleChatAppWebhook }),
        }),
      ],
      resolveAppWebhookSecret: async () => SIGNING_SECRET,
    });
  }

  function delivery(body: string, ts: string, signature?: string): Request {
    return new Request("http://gateway.test/api/v1/app-webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": signature ?? slackSignature(body, ts),
      },
      body,
    });
  }

  it("rejects a stale-but-signed delivery 401 at the edge before delegating", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const router = makeRouter(handler);
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);

    const res = await router.fetch(delivery("{}", staleTs));

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a forged signature 401 before delegating", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const warn = vi.fn();
    const router = createAppWebhookRoutes({
      installationStore: {} as never,
      providers: [
        createDeclaredAppWebhookProvider({
          provider: "slack",
          appId: "slack-app",
          webhookSchema: SLACK_WEBHOOK_SCHEMA,
          handleDelivery: createChatWebhookDelivery({ handleChatAppWebhook: handler }),
        }),
      ],
      resolveAppWebhookSecret: async () => SIGNING_SECRET,
      logger: { warn } as never,
    });

    const res = await router.fetch(delivery("{}", nowTs(), "v0=forged"));

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { provider: "slack" },
      "[app-webhook] signature verification failed — rejecting delivery",
    );
  });

  it("delegates a fresh, valid delivery to handleSlackAppWebhook", async () => {
    const handler = vi.fn(async () => new Response("forwarded", { status: 200 }));
    const router = makeRouter(handler);
    const body = JSON.stringify({ type: "event_callback" });

    const res = await router.fetch(delivery(body, nowTs()));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("forwarded");
  });

  it("surfaces a 500 when delegation throws", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const router = makeRouter(handler);

    const res = await router.fetch(delivery("{}", nowTs()));

    expect(res.status).toBe(500);
  });
});
