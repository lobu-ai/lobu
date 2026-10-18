import {
  assertInboxSourceRead,
  assertNoCursor,
  assertNoMatch,
  assertNoOffsetPaging,
  assertNoSort,
  assertNoWindow,
  requireBrowser,
  type ActionContext,
  type ActionResult,
  type FeedObserveContext,
  type FeedReadContext,
  type FeedReadResult,
  type ChromeActionDispatcher,
} from "@lobu/connector-sdk";
import { linkedInInboxProgram } from "./linkedin-inbox-adapter.js";
import {
  LINKEDIN_HOME_URL,
  linkedInScriptArgument,
} from "./linkedin-browser-script.js";

export interface LinkedInInboxCheckpoint {
  linkedin_inbox?: Record<string, unknown>;
}

async function readyTab(browser: ChromeActionDispatcher): Promise<number> {
  // Opening the inbox itself marks conversations seen. A scrape-owned neutral
  // tab supplies authentication without changing notification/message state.
  // Use LinkedIn's settled route: /feed/ redirects and reloads the warm tab,
  // destroying the other feed's listener on every read or observation setup.
  const tab = await browser.dispatch<{ tab_id?: number }>("navigate", {
    url: LINKEDIN_HOME_URL,
    persistent: true,
    wait_for_load: true,
  });
  if (typeof tab.tab_id !== "number")
    throw new Error("LinkedIn source tab is unavailable");
  return tab.tab_id;
}

async function invoke<T>(
  browser: ChromeActionDispatcher,
  tabId: number,
  op: "read" | "listen" | "send",
  input: Record<string, unknown>
): Promise<T> {
  const result = await browser.dispatch<{ value?: T; exception?: unknown }>(
    "evaluate",
    {
      tab_id: tabId,
      expression: `(() => { (${linkedInInboxProgram.toString()})(); return globalThis.__lobuLinkedInInboxV1.${op}(${linkedInScriptArgument(input)}); })()`,
      await_promise: true,
    }
  );
  if (result.exception || !result.value)
    throw new Error(
      `LinkedIn source ${op} failed: ${JSON.stringify(result.exception ?? "empty response")}`
    );
  return result.value;
}

/**
 * Send one text reply into an existing direct-message conversation from the
 * scrape-owned tab, without opening the inbox. The page program refuses group
 * or unknown conversations, dedupes on `idempotency_key`, and returns only once
 * the message shows in the conversation.
 */
export async function sendLinkedInMessage(
  ctx: ActionContext
): Promise<ActionResult> {
  try {
    const browser = requireBrowser(ctx);
    const output = await invoke<Record<string, unknown>>(
      browser,
      await readyTab(browser),
      "send",
      {
        conversation_id: ctx.input.conversation_id,
        text: ctx.input.text,
        idempotency_key: ctx.input.idempotency_key,
      }
    );
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readLinkedInInbox<F>(
  ctx: FeedReadContext<F>
): Promise<FeedReadResult> {
  if (ctx.feedKey === "live_messages" && ctx.query?.startsWith("id:")) {
    // A message reference read back by id (chat ingress, Automations).
    const message =
      "LinkedIn message lookup by id:<message URN> takes no cursor, offset, sorting, matching, or time window";
    assertNoCursor(ctx, message);
    assertNoOffsetPaging(ctx, message);
    assertNoSort(ctx, message);
    assertNoWindow(ctx, message);
    assertNoMatch(ctx, message);
  } else {
    assertInboxSourceRead(ctx, "LinkedIn");
  }
  const browser = requireBrowser(ctx);
  return invoke(browser, await readyTab(browser), "read", {
    feed: ctx.feedKey,
    query: ctx.query,
    cursor: ctx.cursor,
    limit: ctx.limit,
  });
}

export async function observeLinkedInInbox<
  C extends LinkedInInboxCheckpoint,
  F,
>(ctx: FeedObserveContext<C, F>): Promise<void> {
  const browser = requireBrowser(ctx);
  const tabId = await readyTab(browser);
  const binding = await browser.dispatch<{
    bridge_id?: string;
    token?: string;
    listening?: boolean;
    subscription?: { scope_key: string };
  }>("feed_listen", { tab_id: tabId });
  if (
    !binding.bridge_id ||
    !binding.token ||
    !binding.subscription ||
    binding.listening === false
  ) {
    throw new Error("The paired browser must support source subscriptions");
  }
  await invoke(browser, tabId, "listen", {
    feed: ctx.feedKey,
    checkpoint: ctx.checkpoint,
    bridge_id: binding.bridge_id,
    token: binding.token,
  });
}
