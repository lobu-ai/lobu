import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getRevokedTokenStore } from "../auth/revoked-token-store.js";
import type { InteractionService } from "../interactions.js";
import { createInteractionRoutes } from "../routes/internal/interactions.js";

const previousEncryptionKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.from("12345678901234567890123456789012").toString("base64");
});
afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});
afterEach(() => mock.restore());

describe("confined chat interactions", () => {
  test.each(["reply_only", "public_visitor"] as const)("%s can ask a question but cannot post an approval", async (chatAccess) => {
    spyOn(getRevokedTokenStore(), "isRevoked").mockResolvedValue(false);
    const postQuestion = mock(async () => ({ id: "question-test" }));
    const postDurableApprovalCard = mock(async () => ({ id: "approval-test" }));
    const app = createInteractionRoutes({ postQuestion, postDurableApprovalCard } as unknown as InteractionService);
    const token = generateWorkerToken("U0SENDER", "slack:C0TEST:own", "agent-turn:test", {
      organizationId: "org-confined-interactions", agentId: "agent-confined-interactions",
      platform: "slack", channelId: "C0TEST", connectionId: "slackinst-test", chatAccess,
    });
    const call = (body: Record<string, unknown>) => app.request("/internal/interactions/create", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await call({ question: "Continue?" })).status).toBe(200);
    expect(postQuestion).toHaveBeenCalledTimes(1);
    expect((await call({ interactionType: "tool_approval", runId: 42 })).status).toBe(403);
    expect(postDurableApprovalCard).not.toHaveBeenCalled();
  });
});
