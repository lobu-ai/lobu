import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createInteractionRoutes } from "../../routes/internal/interactions.js";

describe("interaction routes", () => {
  let originalKey: string | undefined;
  let workerToken: string;
  let mockInteractionService: any;
  let router: ReturnType<typeof createInteractionRoutes>;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    workerToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      messageId: "synthetic-request",
      channelId: "chan-1",
      teamId: "team-1",
    });

    mockInteractionService = {
      postQuestion: mock(() => Promise.resolve({ id: "interaction-123" })),
      postLinkButton: mock(() => Promise.resolve({ id: "link-123" })),
    };

    router = createInteractionRoutes(mockInteractionService);
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  describe("POST /internal/interactions/create", () => {
    test("returns 401 without auth header", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "test?", options: [] }),
      });
      expect(res.status).toBe(401);
    });

    test("returns 401 with invalid token", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token",
        },
        body: JSON.stringify({ question: "test?", options: [] }),
      });
      expect(res.status).toBe(401);
    });

    test("posts question and returns id", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          question: "Which option?",
          options: ["A", "B"],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("interaction-123");
      expect(body.status).toBe("posted");
      expect(mockInteractionService.postQuestion).toHaveBeenCalledTimes(1);
      expect(mockInteractionService.postQuestion.mock.calls[0].at(-1)).toBe("synthetic-request");
    });

    test("posts link button and returns id", async () => {
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          interactionType: "link_button",
          url: "https://example.com/device",
          label: "Connect GitHub",
          linkType: "oauth",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("link-123");
      expect(body.status).toBe("posted");
      expect(mockInteractionService.postLinkButton).toHaveBeenCalledTimes(1);
      expect(mockInteractionService.postLinkButton.mock.calls[0].at(-1)).toBe("synthetic-request");
    });

    test("returns 500 on service error", async () => {
      mockInteractionService.postQuestion = mock(() =>
        Promise.reject(new Error("service down"))
      );
      const res = await router.request("/internal/interactions/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({ question: "test?", options: [] }),
      });
      expect(res.status).toBe(500);
    });
  });
});
