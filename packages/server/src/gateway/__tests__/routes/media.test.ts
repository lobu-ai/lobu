import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createAudioRoutes } from "../../routes/internal/audio.js";
import { createImageRoutes } from "../../routes/internal/images.js";

describe("internal media routes", () => {
  let originalKey: string | undefined;
  let workerToken: string;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    workerToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      channelId: "chan-1",
      teamId: "team-1",
      platform: "telegram",
      chatAccess: "member",
      actorUserId: "user-1",
      agentId: "hr-assistant",
    });
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalKey;
    }
    mock.restore();
  });

  test("returns generated image bytes and provider headers", async () => {
    const imageBuffer = Buffer.from("fake-image");
    const imageService = {
      generate: mock(() =>
        Promise.resolve({
          imageBuffer,
          mimeType: "image/png",
          provider: "openai",
        })
      ),
      getConfig: mock(() => Promise.resolve({ provider: "openai" })),
      getProviderInfo: mock(() => [{ provider: "openai", name: "OpenAI" }]),
    };

    const router = createImageRoutes(imageService as any);
    const res = await router.request("/internal/images/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        prompt: "A cat astronaut",
        size: "1024x1024",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Image-Provider")).toBe("openai");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-image");
    expect(imageService.generate).toHaveBeenCalledTimes(1);
  });

  test("returns synthesized audio bytes and provider headers", async () => {
    const audioBuffer = Buffer.from("fake-audio");
    const transcriptionService = {
      synthesize: mock(() =>
        Promise.resolve({
          audioBuffer,
          mimeType: "audio/ogg",
          provider: "openai",
        })
      ),
      getConfig: mock(() => Promise.resolve({ provider: "openai" })),
      getProviderInfo: mock(() => [{ provider: "openai", name: "OpenAI" }]),
    };

    const router = createAudioRoutes(transcriptionService as any);
    const res = await router.request("/internal/audio/synthesize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        text: "Hello from Lobu",
        voice: "alloy",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
    expect(res.headers.get("X-Audio-Provider")).toBe("openai");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-audio");
    expect(transcriptionService.synthesize).toHaveBeenCalledTimes(1);
  });

  test("reports unavailable capabilities when no image or audio provider is configured", async () => {
    const imageService = {
      getConfig: mock(() => Promise.resolve(null)),
      getProviderInfo: mock(() => [{ provider: "openai", name: "OpenAI" }]),
    };
    const transcriptionService = {
      getConfig: mock(() => Promise.resolve(null)),
      getProviderInfo: mock(() => [
        { provider: "openai", name: "OpenAI" },
        { provider: "gemini", name: "Google Gemini" },
      ]),
    };

    const imageRouter = createImageRoutes(imageService as any);
    const audioRouter = createAudioRoutes(transcriptionService as any);

    const [imageRes, audioRes] = await Promise.all([
      imageRouter.request("/internal/images/capabilities", {
        headers: { Authorization: `Bearer ${workerToken}` },
      }),
      audioRouter.request("/internal/audio/capabilities", {
        headers: { Authorization: `Bearer ${workerToken}` },
      }),
    ]);

    expect(await imageRes.json()).toEqual({
      available: false,
      features: { generation: false },
      providers: [{ provider: "openai", name: "OpenAI" }],
    });
    expect(await audioRes.json()).toEqual({
      available: false,
      features: { transcription: false, synthesis: false },
      providers: [
        { provider: "openai", name: "OpenAI" },
        { provider: "gemini", name: "Google Gemini" },
      ],
    });
  });
});
