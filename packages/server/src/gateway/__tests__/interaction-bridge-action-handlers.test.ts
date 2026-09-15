import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ToolUserError } from "../../utils/errors.js";
import { storePendingTool, type PendingToolInvocation } from "../auth/mcp/pending-tool-store.js";
import {
  interactionDeliveryId,
  registerActionHandlers,
} from "../connections/interaction-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

type ActionHandler = (event: any) => Promise<void>;

test("interaction delivery ids collapse exact retries but not later clicks", () => {
  const first = interactionDeliveryId({
    actionId: "suggestion:s_poll:0",
    messageId: "spaces/one/messages/card",
    user: { userId: "users/a" },
    raw: { chat: { eventTime: "2026-08-24T18:00:00Z", value: "A" } },
  });
  const retry = interactionDeliveryId({
    user: { userId: "users/a" },
    messageId: "spaces/one/messages/card",
    actionId: "suggestion:s_poll:0",
    raw: { chat: { value: "A", eventTime: "2026-08-24T18:00:00Z" } },
  });
  const laterClick = interactionDeliveryId({
    actionId: "suggestion:s_poll:0",
    messageId: "spaces/one/messages/card",
    user: { userId: "users/a" },
    raw: { chat: { eventTime: "2026-08-24T18:00:01Z", value: "A" } },
  });

  expect(first).toBe(retry);
  expect(first).toMatch(/^interaction-[a-f0-9]{64}$/);
  expect(laterClick).not.toBe(first);
});

interface Harness {
  handler: ActionHandler;
  grantStore: {
    grant: ReturnType<typeof mock>;
  };
  executeToolDirect: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  thread: { post: ReturnType<typeof mock> };
  editCard: ReturnType<typeof mock>;
}

function setup(
  options: {
    executeToolResult?:
      | { content: Array<{ type: string; text: string }>; isError: boolean }
      | Error;
    withExecute?: boolean;
    withGrantStore?: boolean;
    /**
     * Request ids already settled by an earlier click. `claimApprovalCard`
     * returns undefined for these, matching the real in-memory card registry
     * where a card can only be claimed once — which is what makes a webhook
     * retry silent rather than posting a duplicate "expired" notice.
     */
    claimedCards?: Set<string>;
  } = {}
): Harness {
  const {
    executeToolResult,
    withExecute = true,
    withGrantStore = true,
    claimedCards,
  } = options;

  let captured: ActionHandler | undefined;
  const chat = {
    onAction: mock((h: ActionHandler) => {
      captured = h;
    }),
  };
  const grantStore = {
    grant: mock(async () => undefined),
  };
  const executeToolDirect = mock(async () => {
    if (executeToolResult instanceof Error) throw executeToolResult;
    return (
      executeToolResult ?? {
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }
    );
  });
  const post = mock(async () => undefined);
  const thread = { post };

  const editCard = mock(async () => undefined);
  const claimApprovalCard = mock((requestId: string) => {
    if (claimedCards?.has(requestId)) return undefined;
    claimedCards?.add(requestId);
    return { edit: editCard };
  });

  registerActionHandlers(
    chat as any,
    { id: "conn-1", platform: "slack", organizationId: "org-1" } as PlatformConnection,
    withGrantStore ? (grantStore as any) : undefined,
    withExecute ? (executeToolDirect as any) : undefined,
    claimApprovalCard as any
  );

  if (!captured) throw new Error("onAction handler not registered");
  return {
    handler: (event: any) => captured!({
      user: { userId: "user-1", userName: "User One" },
      conversationId: undefined,
      ...event,
    }),
    grantStore,
    executeToolDirect,
    post,
    thread,
    editCard,
  };
}

const PENDING: PendingToolInvocation = {
  mcpId: "github",
  toolName: "create_issue",
  args: { title: "hi" },
  agentId: "agent-1",
  userId: "user-1",
	organizationId: "org-1",
};

async function seedPending(requestId: string): Promise<void> {
  await storePendingTool(requestId, PENDING, 24 * 60 * 60);
}

function editedCardJson(h: Harness): string {
	return JSON.stringify(h.editCard.mock.calls[0]?.[0]);
}

describe("registerActionHandlers — tool approval", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("approve with pending + executeToolDirect stores grant, runs tool, posts result, deletes pending", async () => {
    await seedPending("req-1");
    const h = setup({
      executeToolResult: {
        content: [{ type: "text", text: "issue #42" }],
        isError: false,
      },
    });
    const before = Date.now();
    await h.handler({
      actionId: "tool:req-1:1h",
      value: "1h",
      thread: h.thread,
    });

    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    const [agentId, pattern, expiresAt, denial] =
      h.grantStore.grant.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(pattern).toBe("/mcp/github/tools/create_issue");
    expect(denial).toBeUndefined();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 100);

    expect(h.executeToolDirect).toHaveBeenCalledTimes(1);
    expect(h.executeToolDirect.mock.calls[0]).toEqual([
      "agent-1",
      "user-1",
      "github",
      "create_issue",
      { title: "hi" },
			{ organizationId: "org-1" },
    ]);

    expect(h.post).toHaveBeenCalledWith("issue #42");
  });

  test("approve maps duration 'always' to null expiry", async () => {
    await seedPending("req-3");
    const h = setup();
    await h.handler({
      actionId: "tool:req-3:always",
      value: "always",
      thread: h.thread,
    });
    const [, , expiresAt] = h.grantStore.grant.mock.calls[0];
    expect(expiresAt).toBeNull();
  });

  test("approve edits the approval card to strip buttons and show decision summary", async () => {
    await seedPending("req-edit");
    const h = setup();
    await h.handler({
      actionId: "tool:req-edit:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.editCard).toHaveBeenCalledTimes(1);
		const edited = editedCardJson(h);
    expect(edited).toContain("github → create_issue");
		expect(edited).toContain("*Approved*");
		expect(edited).toContain("Tool access allowed for 1h.");
		expect(edited).not.toContain('"type":"button"');
  });

  test("approve with no pending but tracked card (late first click) edits card and posts an expired notice — no grant, no execute", async () => {
    const h = setup();
    await h.handler({
      actionId: "tool:req-x:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.executeToolDirect).not.toHaveBeenCalled();
    // Card should be edited to show the expired notice and the user told to retry.
    expect(h.editCard).toHaveBeenCalledTimes(1);
		expect(editedCardJson(h)).toMatch(/expired/i);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[0] as string).toMatch(/expired/i);
  });

  test("a bystander click leaves the row and card live, then the requester can still act", async () => {
    await seedPending("req-bystander");
    const bystander = setup();
    await bystander.handler({
      actionId: "tool:req-bystander:1h",
      value: "1h",
      user: { userId: "user-2", userName: "Someone Else" },
      thread: bystander.thread,
    });

    // Forbidden must NOT take the expired path: no grant, no execution, and
    // crucially the card is left untouched so its buttons stay actionable.
    expect(bystander.grantStore.grant).not.toHaveBeenCalled();
    expect(bystander.executeToolDirect).not.toHaveBeenCalled();
    expect(bystander.editCard).not.toHaveBeenCalled();
    expect(bystander.post).toHaveBeenCalledTimes(1);
    expect(bystander.post.mock.calls[0]?.[0] as string).toBe(
      "Only the requester can act on this approval.",
    );

    // The DB row survived the bystander click, so the real requester still wins.
    const requester = setup();
    await requester.handler({
      actionId: "tool:req-bystander:1h",
      value: "1h",
      thread: requester.thread,
    });
    expect(requester.grantStore.grant).toHaveBeenCalledTimes(1);
    expect(requester.executeToolDirect).toHaveBeenCalledTimes(1);
    expect(requester.editCard).toHaveBeenCalledTimes(1);
    expect(editedCardJson(requester)).toContain("*Approved*");
  });

  test("a retry after a successful claim stays silent — no second grant or receipt", async () => {
    await seedPending("req-retry");
    // Shared across both clicks so the retry sees a card the first click
    // already settled — without this the retry would re-claim a fresh card and
    // wrongly post the "expired" notice, and the test would pass vacuously.
    const claimedCards = new Set<string>();

    const first = setup({ claimedCards });
    await first.handler({
      actionId: "tool:req-retry:1h",
      value: "1h",
      thread: first.thread,
    });
    expect(first.grantStore.grant).toHaveBeenCalledTimes(1);

    // The webhook retry finds the row gone (missing, not forbidden). The card
    // was already claimed, so there is nothing to settle and the retry must be
    // a silent no-op — no second grant, no execution, no post at all.
    const retry = setup({ claimedCards });
    await retry.handler({
      actionId: "tool:req-retry:1h",
      value: "1h",
      thread: retry.thread,
    });
    expect(retry.grantStore.grant).not.toHaveBeenCalled();
    expect(retry.executeToolDirect).not.toHaveBeenCalled();
    expect(retry.editCard).not.toHaveBeenCalled();
    expect(retry.post).not.toHaveBeenCalled();
  });

  test("approve but tool execution throws posts failure message and still stores grant", async () => {
    await seedPending("req-4");
    const h = setup({
      executeToolResult: new Error("boom"),
    });
    await h.handler({
      actionId: "tool:req-4:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("Failed to execute tool: Error: boom");
  });

  test("approve with isError=true result posts 'Tool error: ...'", async () => {
    await seedPending("req-5");
    const h = setup({
      executeToolResult: {
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      },
    });
    await h.handler({
      actionId: "tool:req-5:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.post).toHaveBeenCalledWith("Tool error: permission denied");
  });

  test("deny stores denial grant, takes pending, posts apology", async () => {
    await seedPending("req-6");
    const h = setup();
    await h.handler({
      actionId: "tool:req-6:deny",
      value: "deny",
      thread: h.thread,
    });
    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    const [agentId, pattern, expiresAt, denial] =
      h.grantStore.grant.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(pattern).toBe("/mcp/github/tools/create_issue");
    expect(expiresAt).toBeNull();
    expect(denial).toBe(true);
    expect(h.executeToolDirect).not.toHaveBeenCalled();
    expect(h.post.mock.calls[0]?.[0]).toMatch(/denied/i);
  });

  test("deny with no pending but tracked card (late first click) edits card and posts an expired notice — no grant", async () => {
    const h = setup();
    await h.handler({
      actionId: "tool:req-7:deny",
      value: "deny",
      thread: h.thread,
    });
    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.editCard).toHaveBeenCalledTimes(1);
		expect(editedCardJson(h)).toMatch(/expired/i);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[0] as string).toMatch(/expired/i);
  });

  test("deny edits the approval card to show denial summary", async () => {
    await seedPending("req-editdeny");
    const h = setup();
    await h.handler({
      actionId: "tool:req-editdeny:deny",
      value: "deny",
      thread: h.thread,
    });
    expect(h.editCard).toHaveBeenCalledTimes(1);
		expect(editedCardJson(h)).toContain("*Denied*");
		expect(editedCardJson(h)).not.toContain('"type":"button"');
  });
});

describe("registerActionHandlers — question (no callback)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("question with value posts the value (legacy fallback path)", async () => {
    const h = setup();
    await h.handler({
      actionId: "question:q-1:2",
      value: "Option C",
      thread: h.thread,
    });
    expect(h.post).toHaveBeenCalledWith("Option C");
  });

  test("question with no value falls back to third actionId segment", async () => {
    const h = setup();
    await h.handler({
      actionId: "question:q-1:fallback-text",
      value: "",
      thread: h.thread,
    });
    expect(h.post).toHaveBeenCalledWith("fallback-text");
  });
});

describe("registerActionHandlers — question (with onQuestionClick)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  function setupWithCallback(): {
    handler: ActionHandler;
    onQuestionClick: ReturnType<typeof mock>;
    thread: { post: ReturnType<typeof mock> };
  } {
    let captured: ActionHandler | undefined;
    const chat = {
      onAction: mock((h: ActionHandler) => {
        captured = h;
      }),
    };
    const onQuestionClick = mock(async () => undefined);
    const thread = { post: mock(async () => undefined) };

    registerActionHandlers(
      chat as any,
      { id: "conn-1", platform: "slack", organizationId: "org-1" } as PlatformConnection,
      undefined,
      undefined,
      undefined,
      onQuestionClick as any
    );
    if (!captured) throw new Error("onAction handler not registered");
    return { handler: captured, onQuestionClick, thread };
  }

  test("dispatches question click to onQuestionClick instead of bare post", async () => {
    const h = setupWithCallback();
    await h.handler({
      actionId: "question:q-42:0",
      value: "Phobos",
      thread: h.thread,
      user: { userId: "U_clicker", userName: "ada", fullName: "Ada Lovelace" },
    });

    expect(h.thread.post).not.toHaveBeenCalled();
    expect(h.onQuestionClick).toHaveBeenCalledTimes(1);
    const [questionId, value, threadArg, author] =
      h.onQuestionClick.mock.calls[0];
    expect(questionId).toBe("q-42");
    expect(value).toBe("Phobos");
    expect(threadArg).toBe(h.thread);
    expect(author).toEqual({
      userId: "U_clicker",
      userName: "ada",
      fullName: "Ada Lovelace",
    });
  });

  test("missing questionId is silently ignored", async () => {
    const h = setupWithCallback();
    await h.handler({
      actionId: "question:",
      value: "X",
      thread: h.thread,
    });
    expect(h.onQuestionClick).not.toHaveBeenCalled();
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  test("callback errors are swallowed (no throw out of handler)", async () => {
    const h = setupWithCallback();
    h.onQuestionClick.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await h.handler({
      actionId: "question:q-99:1",
      value: "second",
      thread: h.thread,
    });
    expect(h.onQuestionClick).toHaveBeenCalledTimes(1);
  });
});

describe("registerActionHandlers — guards", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  let h: Harness;
  beforeEach(async () => {
    await resetTestDatabase();
    h = setup();
  });

  test("no thread → no-op", async () => {
    await h.handler({ actionId: "tool:req:approve", value: "1h" });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.grantStore.grant).not.toHaveBeenCalled();
  });

  test("no actionId → no-op", async () => {
    await h.handler({ actionId: "", value: "1h", thread: h.thread });
    expect(h.post).not.toHaveBeenCalled();
  });

  test("unknown prefix → no-op", async () => {
    await h.handler({
      actionId: "other:foo:bar",
      value: "x",
      thread: h.thread,
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.grantStore.grant).not.toHaveBeenCalled();
  });
});

describe("registerActionHandlers — declared template event action", () => {
  function setupTemplateAction(
    result: { created: boolean } | Error = { created: true }
  ): {
    handler: ActionHandler;
    onTemplateEventAction: ReturnType<typeof mock>;
    thread: { post: ReturnType<typeof mock> };
  } {
    let captured: ActionHandler | undefined;
    const chat = {
      onAction: mock((handler: ActionHandler) => {
        captured = handler;
      }),
    };
    const onTemplateEventAction = mock(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const thread = { post: mock(async () => undefined) };

    registerActionHandlers(
      chat as any,
      { id: "conn-1", platform: "gchat" } as PlatformConnection,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onTemplateEventAction as any
    );
    if (!captured) throw new Error("onAction handler not registered");
    return { handler: captured, onTemplateEventAction, thread };
  }

  test("parses source/action/value and posts one receipt", async () => {
    const h = setupTemplateAction();
    const event = {
      actionId: "event-action:42:vote",
      value: "B",
      messageId: "spaces/one/messages/poll",
      thread: h.thread,
      user: { userId: "users/ada" },
    };
    await h.handler(event);

    expect(h.onTemplateEventAction).toHaveBeenCalledWith(42, "vote", "B", event);
    expect(h.thread.post).toHaveBeenCalledWith("Recorded.");
  });

  test("keeps a valueless button null through the chat bridge", async () => {
    const h = setupTemplateAction();
    const event = {
      actionId: "event-action:42:refresh",
      thread: h.thread,
      user: { userId: "users/ada" },
    };
    await h.handler(event);

    expect(h.onTemplateEventAction).toHaveBeenCalledWith(
      42,
      "refresh",
      null,
      event
    );
  });

  test("keeps exact retry silent after the durable rail reports unchanged", async () => {
    const h = setupTemplateAction({ created: false });
    await h.handler({
      actionId: "event-action:42:vote",
      value: "A",
      thread: h.thread,
    });
    expect(h.onTemplateEventAction).toHaveBeenCalledTimes(1);
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  test("surfaces a closed interaction without escaping the webhook handler", async () => {
    const h = setupTemplateAction(
      new ToolUserError("This interaction is closed or has been replaced.", 409)
    );
    await h.handler({
      actionId: "event-action:42:vote",
      value: "A",
      thread: h.thread,
    });
    expect(h.thread.post).toHaveBeenCalledWith(
      "This interaction is closed or has been replaced."
    );
  });

  test("does not expose unexpected server errors to the chat user", async () => {
    const h = setupTemplateAction(new Error("postgres password leaked"));
    await h.handler({
      actionId: "event-action:42:vote",
      value: "A",
      thread: h.thread,
    });
    expect(h.thread.post).toHaveBeenCalledWith(
      "I couldn’t record that interaction."
    );
  });
});

describe("registerActionHandlers — suggestion", () => {
  function setup(withCallback: boolean): {
    handler: ActionHandler;
    onSuggestionClick: ReturnType<typeof mock>;
    thread: { post: ReturnType<typeof mock> };
  } {
    let captured: ActionHandler | undefined;
    const chat = {
      onAction: mock((h: ActionHandler) => {
        captured = h;
      }),
    };
    const onSuggestionClick = mock(async () => undefined);
    const thread = { post: mock(async () => undefined) };

    registerActionHandlers(
      chat as any,
      { id: "conn-1", platform: "slack", organizationId: "org-1" } as PlatformConnection,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      withCallback ? (onSuggestionClick as any) : undefined
    );
    if (!captured) throw new Error("onAction handler not registered");
    return { handler: captured, onSuggestionClick, thread };
  }

  test("dispatches the parsed suggestion id and prompt index", async () => {
    // The button carries only `suggestion:<id>:<i>` — prompt text and routing
    // live in the pending row, which the click handler resolves. This branch's
    // whole job is a faithful parse.
    const h = setup(true);
    await h.handler({
      actionId: "suggestion:s_ab12cd34ef56:2",
      value: "",
      messageId: "message-card-1",
      thread: h.thread,
      user: { userId: "U_clicker", userName: "ada", fullName: "Ada Lovelace" },
    });

    expect(h.onSuggestionClick).toHaveBeenCalledTimes(1);
    const [suggestionId, promptIndex, threadArg, author, actionEvent] =
      h.onSuggestionClick.mock.calls[0];
    expect(suggestionId).toBe("s_ab12cd34ef56");
    expect(promptIndex).toBe(2);
    expect(threadArg).toBe(h.thread);
    expect(author).toEqual({
      userId: "U_clicker",
      userName: "ada",
      fullName: "Ada Lovelace",
    });
    expect(actionEvent).toMatchObject({
      actionId: "suggestion:s_ab12cd34ef56:2",
      messageId: "message-card-1",
    });
    // No bare post — the message must go through the turn pipeline.
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  test("drops a malformed action id instead of guessing", async () => {
    // A mangled id can't resolve a pending row, so there is nothing safe to
    // send. Each variant must be rejected before the click callback runs.
    const h = setup(true);
    for (const actionId of [
      "suggestion:",
      "suggestion::0",
      "suggestion:s_ab12cd34ef56:",
      "suggestion:s_ab12cd34ef56:x",
      "suggestion:s_ab12cd34ef56:-1",
      "suggestion:s_ab12cd34ef56:1.5",
      "suggestion:s_ab12cd34ef56:0:extra",
    ]) {
      await h.handler({
        actionId,
        value: "",
        thread: h.thread,
        user: { userId: "U_clicker" },
      });
    }

    expect(h.onSuggestionClick).not.toHaveBeenCalled();
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  test("no click pipeline wired → no-op (nothing to post either)", async () => {
    // Without the callback there is no row lookup, and the button carries no
    // text — posting anything would fabricate a message the user never chose.
    const h = setup(false);
    await h.handler({
      actionId: "suggestion:s_ab12cd34ef56:1",
      value: "",
      thread: h.thread,
      user: { userId: "U_clicker" },
    });

    expect(h.thread.post).not.toHaveBeenCalled();
  });
});
