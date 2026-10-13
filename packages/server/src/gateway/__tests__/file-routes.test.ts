import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import {
  ArtifactStorageError,
  MAX_ARTIFACT_BYTES,
  runArtifactBinding,
} from "../files/artifact-store.js";
import type { PlatformRegistry } from "../platform.js";
import type { IFileHandler } from "../platform/file-handler.js";
import { createFileRoutes } from "../routes/internal/files.js";
import { createPublicFileRoutes } from "../routes/public/files.js";
import {
  type ArtifactTestEnv,
  createArtifactTestEnv,
  TEST_GATEWAY_URL,
} from "./setup.js";

describe("file routes", () => {
  let env: ArtifactTestEnv;

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  /** Build an in-memory app wired to the given (optional) platform handler. */
  function buildApp(handler?: IFileHandler) {
    const app = new Hono();
    const platformRegistry = {
      get: () => ({ getFileHandler: () => handler }),
    } as unknown as PlatformRegistry;
    app.route(
      "/internal/files",
      createFileRoutes(platformRegistry, env.artifactStore, TEST_GATEWAY_URL)
    );
    app.route("", createPublicFileRoutes(env.artifactStore));
    return app;
  }

  async function uploadProof(app: Hono, filename: string, contents: string) {
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
    });
    const form = new FormData();
    form.set("file", new File([contents], filename, { type: "text/plain" }));
    form.set("filename", filename);
    return app.request("/internal/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Channel-Id": "channel-1",
        "X-Conversation-Id": "conv-1",
      },
      body: form,
    });
  }

  // Both upload paths — "no platform handler" and "platform handler throws"
  // — must transparently fall back to a signed artifact URL. They are the
  // same contract triggered two different ways.
  const FALLBACK_CASES: Array<{
    name: string;
    handler?: IFileHandler;
    expectAttempts: number;
  }> = [
    { name: "no platform file handler exists", expectAttempts: 0 },
    {
      name: "platform upload fails",
      expectAttempts: 1,
      handler: {
        uploadFile: async () => {
          throw new Error("telegram upload failed");
        },
      },
    },
  ];

  test.each(
    FALLBACK_CASES
  )("falls back to a signed artifact URL when $name", async ({
    handler,
    expectAttempts,
  }) => {
    let attempts = 0;
    const wrapped: IFileHandler | undefined = handler && {
      uploadFile: async (...args) => {
        attempts += 1;
        return handler.uploadFile(...args);
      },
    };

    const app = buildApp(wrapped);

    const filename = expectAttempts === 0 ? "proof.txt" : "fallback.txt";
    const contents =
      expectAttempts === 0 ? "hello artifact" : "fallback artifact";
    const uploadResponse = await uploadProof(app, filename, contents);

    expect(attempts).toBe(expectAttempts);
    expect(uploadResponse.status).toBe(200);
    const uploadBody = (await uploadResponse.json()) as {
      success: boolean;
      fileId: string;
      permalink: string;
      name: string;
      size: number;
      delivery: string;
      artifactId?: string;
    };

    expect(uploadBody.success).toBe(true);
    expect(uploadBody.delivery).toBe("artifact-url");
    expect(uploadBody.name).toBe(filename);
    expect(uploadBody.permalink).toContain("/api/v1/files/");
    expect(uploadBody.artifactId).toBe(uploadBody.fileId);

    // The signed permalink the worker would receive is fetchable end-to-end.
    const downloadUrl = new URL(uploadBody.permalink);
    const downloadResponse = await app.request(
      `${downloadUrl.pathname}${downloadUrl.search}`
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toContain(
      "text/plain"
    );
    expect(downloadResponse.headers.get("content-disposition")).toContain(
      `filename="${filename}"`
    );
    expect(await downloadResponse.text()).toBe(contents);
  });

  // SECURITY regression: the upload route read the destination channel from the
  // X-Channel-Id / X-Conversation-Id request headers, never comparing them to
  // the verified worker token. A worker could override them to deliver
  // attachments to ANY channel the connection's bot can reach. The route must
  // use the token-bound channel/conversation and ignore the headers.
  test("upload routes to the TOKEN-bound channel, not attacker-supplied headers", async () => {
    let seen: { channelId?: string; threadTs?: string } | undefined;
    const handler: IFileHandler = {
      uploadFile: async (_stream, opts) => {
        seen = { channelId: opts.channelId, threadTs: opts.threadTs };
        return {
          fileId: "f1",
          permalink: "https://example.test/f1",
          name: opts.filename ?? "f",
          size: 1,
          delivery: "platform-upload" as const,
        };
      },
    };
    const app = buildApp(handler);

    // Token scopes the worker to channel-1 / conv-1.
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
    });
    const form = new FormData();
    form.set("file", new File(["x"], "p.txt", { type: "text/plain" }));
    form.set("filename", "p.txt");

    // Attacker-supplied headers point at a different channel/conversation.
    const res = await app.request("/internal/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Channel-Id": "victim-channel",
        "X-Conversation-Id": "victim-conv",
      },
      body: form,
    });

    expect(res.status).toBe(200);
    // The file handler must have been invoked with the token-bound channel,
    // NOT the attacker's header values.
    expect(seen?.channelId).toBe("channel-1");
    expect(seen?.threadTs).toBe("conv-1");
    expect(seen?.channelId).not.toBe("victim-channel");
    expect(seen?.threadTs).not.toBe("victim-conv");
  });

  test.each([
    { path: "/internal/files/upload", field: "file" },
    { path: "/internal/files/upload-batch", field: "files" },
  ])("rejects an oversized $path request before parsing multipart data", async ({
    path,
    field,
  }) => {
    const app = buildApp();
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
    });
    const form = new FormData();
    form.set(field, new File(["small"], "oversized.bin"));

    const response = await app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Length": String(MAX_ARTIFACT_BYTES + 1024 * 1024 + 1),
      },
      body: form,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "File exceeds the artifact storage limit",
    });
  });

  test("stops an unbounded multipart stream even without Content-Length", async () => {
    const app = buildApp();
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
    });
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 0) {
          controller.enqueue(
            new TextEncoder().encode(
              '--artifact-boundary\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n\r\n',
            ),
          );
        } else if (emitted <= 200) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(
            new TextEncoder().encode("\r\n--artifact-boundary--\r\n"),
          );
          controller.close();
        }
        emitted += 1;
      },
    });
    const request = new Request("http://localhost/internal/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "multipart/form-data; boundary=artifact-boundary",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(emitted).toBeLessThan(60);
  });

  test("rejects a decoded single file over the storage limit", async () => {
    const app = buildApp();
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
    });
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(MAX_ARTIFACT_BYTES + 1)], "oversized.bin"),
    );

    const response = await app.request("/internal/files/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    expect(response.status).toBe(413);
  });

  test("rejects a batch whose aggregate decoded size exceeds the limit", async () => {
    const app = buildApp();
    const token = generateWorkerToken("user-1", "conv-1", "worker-1", {
      channelId: "channel-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
    });
    const form = new FormData();
    const halfLimit = Math.floor(MAX_ARTIFACT_BYTES / 2);
    form.append("files", new File([new Uint8Array(halfLimit + 1)], "a.bin"));
    form.append("files", new File([new Uint8Array(halfLimit + 1)], "b.bin"));

    const response = await app.request("/internal/files/upload-batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Batch exceeds the artifact storage limit",
    });
  });

  test("refuses a bound download URL pointed at another resource's artifact", async () => {
    // Event attachment URLs are re-minted on every read without touching the
    // store, so the binding travels inside the token and this route is where
    // it is checked. Without that check the grafted id downloads fine.
    const app = buildApp();
    const { artifactId } = await env.artifactStore.publish({
      buffer: Buffer.from("someone else's bytes"),
      filename: "victim.txt",
      contentType: "text/plain",
      publicGatewayUrl: TEST_GATEWAY_URL,
      binding: runArtifactBinding(1),
    });

    const grafted = env.artifactStore.buildDownloadUrl(
      TEST_GATEWAY_URL,
      artifactId,
      undefined,
      runArtifactBinding(2)
    );
    const denied = await app.request(new URL(grafted).pathname + new URL(grafted).search);
    expect(denied.status).toBe(404);

    const legitimate = env.artifactStore.buildDownloadUrl(
      TEST_GATEWAY_URL,
      artifactId,
      undefined,
      runArtifactBinding(1)
    );
    const allowed = await app.request(
      new URL(legitimate).pathname + new URL(legitimate).search
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("someone else's bytes");
  });

  test("returns a generic 503 when artifact storage is unavailable", async () => {
    const app = new Hono();
    app.route(
      "",
      createPublicFileRoutes({
        validateDownloadToken: () => ({ valid: true }),
        read: async () => {
          throw new ArtifactStorageError("read", new Error("private path"));
        },
      } as unknown as ArtifactTestEnv["artifactStore"]),
    );

    const response = await app.request(
      "/api/v1/files/00000000-0000-4000-8000-000000000000?token=valid",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "File storage temporarily unavailable",
    });
  });
});
