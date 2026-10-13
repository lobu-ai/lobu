/// <reference path="./linkedin-inbox-adapter.d.ts" />
import {
  requireBrowser,
  type FeedObserveContext,
  type FeedReadContext,
  type FeedReadResult,
  type ChromeActionDispatcher,
} from "@lobu/connector-sdk";
import { linkedInInboxProgram } from "./linkedin-inbox-adapter.js";
import {
  LINKEDIN_HOME_URL,
  linkedInScriptArgument,
} from "./linkedin-browser-script.ts";

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
  op: "read" | "listen",
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

export async function readLinkedInInbox<F>(
  ctx: FeedReadContext<F>
): Promise<FeedReadResult> {
  if (ctx.offset || ctx.sort || ctx.window || ctx.query || ctx.match) {
    throw new Error(
      "LinkedIn inbox reads use source order and the returned cursor; search, offsets, sorting, matching, and time windows are not supported."
    );
  }
  const browser = requireBrowser(ctx);
  return invoke(browser, await readyTab(browser), "read", {
    feed: ctx.feedKey,
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
