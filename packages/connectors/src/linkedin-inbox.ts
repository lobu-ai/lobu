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
  type EventEnvelope,
  type FeedObserveContext,
  type FeedReadContext,
  type FeedReadResult,
  type ChromeActionDispatcher,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import { linkedInInboxProgram } from "./linkedin-inbox-adapter.js";
import {
  LINKEDIN_HOME_URL,
  linkedInScriptArgument,
} from "./linkedin-browser-script.js";

export interface LinkedInInboxCheckpoint {
  linkedin_inbox?: Record<string, unknown>;
  linkedin_direct_messages?: LinkedInDirectMessagesCheckpoint;
}

/**
 * Where stored direct-message history stands. `after` is the newest
 * conversation activity (ms) a finished walk stored; a walk in progress
 * carries LinkedIn's conversation cursor, the newest activity it has seen and
 * how many pages it has read.
 */
interface LinkedInDirectMessagesCheckpoint {
  account: string;
  after?: number;
  page?: string;
  newest?: number;
  pages?: number;
}

/**
 * The live messages feed's `inbox` setting: absent or "me" reads the signed-in
 * member's inbox; a page mailbox URN reads that company page's inbox, which the
 * member must administer. Other feeds read the member's own sources.
 */
function inboxOf(feedKey: string, config: unknown): unknown {
  return feedKey === "live_messages"
    ? (config as { inbox?: unknown } | null | undefined)?.inbox
    : undefined;
}

function savedAccount(ctx: { sessionState?: Record<string, unknown> | null }): string {
  const account = ctx.sessionState?.account_id;
  if (typeof account !== "string" || !/^urn:li:fs_miniProfile:.+$/.test(account))
    throw new Error("LinkedIn source requires the connection's saved account; reconnect this source");
  return account;
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
  op: "read" | "listen" | "send" | "lookup" | "history",
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
 * scrape-owned tab, without opening the inbox. A full conversation URN sends
 * from the inbox it names (a company page's, for a page feed's row). The page program refuses group
 * or unknown conversations, sends at most once per operation run (`ctx.run.id`),
 * and returns only once the message shows in the conversation.
 */
export async function sendLinkedInMessage(
  ctx: ActionContext
): Promise<ActionResult> {
  try {
    const expectedAccount = savedAccount(ctx);
    const browser = requireBrowser(ctx);
    const output = await invoke<Record<string, unknown>>(
      browser,
      await readyTab(browser),
      "send",
      {
        expected_account: expectedAccount,
        conversation_id: ctx.input.conversation_id,
        text: ctx.input.text,
        run_id: ctx.run.id,
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

/**
 * Show direct-message conversations as the person on the other side (name,
 * headline, photo) for `send_message.conversation_id`'s lookup. Read-only: it
 * reads the conversation list from the scrape-owned tab, never the inbox page.
 */
export async function lookupLinkedInConversations(
  ctx: ActionContext
): Promise<ActionResult> {
  try {
    const expectedAccount = savedAccount(ctx);
    const browser = requireBrowser(ctx);
    const output = await invoke<Record<string, unknown>>(
      browser,
      await readyTab(browser),
      "lookup",
      {
        expected_account: expectedAccount,
        values: ctx.input.values,
        query: ctx.input.query,
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
  const expectedAccount = savedAccount(ctx);
  const browser = requireBrowser(ctx);
  return invoke(browser, await readyTab(browser), "read", {
    expected_account: expectedAccount,
    feed: ctx.feedKey,
    inbox: inboxOf(ctx.feedKey, ctx.config),
    query: ctx.query,
    cursor: ctx.cursor,
    limit: ctx.limit,
  });
}

export async function observeLinkedInInbox<
  C extends LinkedInInboxCheckpoint,
  F,
>(ctx: FeedObserveContext<C, F>): Promise<void> {
  const expectedAccount = savedAccount(ctx);
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
    inbox: inboxOf(ctx.feedKey, ctx.config),
    checkpoint: ctx.checkpoint,
    expected_account: expectedAccount,
    bridge_id: binding.bridge_id,
    token: binding.token,
  });
}

/** One conversations page of stored history; the walk ends at five. */
const DIRECT_MESSAGE_WALK_PAGES = 5;

interface DirectMessageRow {
  id: string;
  conversation_id: string;
  thread_id: string;
  conversation_url: string;
  text: string;
  content_kind: string;
  has_attachments: boolean;
  sender_id: string | null;
  sender_member_id: string | null;
  sender_slug: string | null;
  sender_name: string;
  from_me: boolean | null;
  occurred_at: string;
  counterpart_id: string;
  counterpart_member_id: string | null;
  counterpart_slug: string | null;
  counterpart_name: string;
}

interface DirectMessageHistoryPage {
  account: string;
  rows: DirectMessageRow[];
  newest: number | null;
  next: string | null;
}

function directMessageEvent(row: DirectMessageRow): EventEnvelope {
  const present = (value: string | null) => (value ? value : undefined);
  return {
    origin_id: row.id,
    origin_type: "message",
    origin_parent_id: row.thread_id,
    payload_text: row.text,
    author_name: present(row.sender_name),
    source_url: row.conversation_url,
    occurred_at: new Date(row.occurred_at),
    metadata: {
      conversation_id: row.conversation_id,
      content_kind: row.content_kind,
      has_attachments: row.has_attachments,
      ...(row.from_me === null ? {} : { from_me: row.from_me }),
      sender_member_id: present(row.sender_member_id),
      sender_slug: present(row.sender_slug),
      sender_name: present(row.sender_name),
      counterpart_member_id: present(row.counterpart_member_id),
      counterpart_slug: present(row.counterpart_slug),
      counterpart_name: row.counterpart_name,
    },
  };
}

/**
 * Store the signed-in member's 1:1 messages, one conversations page per run.
 * A walk reads the inbox from the most recent activity down to the last
 * finished walk's watermark, the end of the inbox, or five pages, whichever
 * comes first, then moves the watermark. Each changed conversation stores its
 * recent message page; re-stored messages deduplicate by message URN. Groups
 * are skipped, and the inbox is read from the scrape-owned tab, so nothing is
 * marked seen.
 */
export async function syncLinkedInDirectMessages(
  ctx: SyncContext<LinkedInInboxCheckpoint, unknown>
): Promise<SyncResult> {
  const expectedAccount = savedAccount(ctx);
  const browser = requireBrowser(ctx);
  const prior = ctx.checkpoint?.linkedin_direct_messages;
  const page = await invoke<DirectMessageHistoryPage>(
    browser,
    await readyTab(browser),
    "history",
    { expected_account: expectedAccount, page: prior?.page, after: prior?.after }
  );
  if (prior && prior.account !== page.account)
    throw new Error(
      "LinkedIn direct message checkpoint belongs to another account; reconnect this source"
    );
  const newest = Math.max(prior?.newest ?? -1, page.newest ?? -1, prior?.after ?? -1);
  const pages = (prior?.page ? (prior.pages ?? 1) : 0) + 1;
  const done = !page.next || pages >= DIRECT_MESSAGE_WALK_PAGES;
  const checkpoint: LinkedInDirectMessagesCheckpoint = done
    ? { account: page.account, ...(newest >= 0 ? { after: newest } : {}) }
    : {
        account: page.account,
        ...(prior?.after !== undefined ? { after: prior.after } : {}),
        page: page.next as string,
        ...(newest >= 0 ? { newest } : {}),
        pages,
      };
  const events = page.rows.map(directMessageEvent);
  await ctx.commit(events, { linkedin_direct_messages: checkpoint });
  return {
    status: done ? "complete" : "more",
    metadata: { items_found: events.length },
  };
}
