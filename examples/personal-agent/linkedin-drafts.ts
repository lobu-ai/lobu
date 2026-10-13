import {
  requireBrowser,
  type ActionContext,
  type ActionResult,
} from "@lobu/connector-sdk";
import { linkedInScriptArgument } from "./linkedin-browser-script";

export function linkedInDraftUrl(
  kind: string,
  input: Record<string, unknown>
): string {
  if (kind === "prepare_post") return "https://www.linkedin.com/feed/foryou/";
  const url = new URL(String(input.conversation_url ?? ""));
  if (
    url.origin !== "https://www.linkedin.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/messaging\/thread\/[A-Za-z0-9_=%-]+\/$/.test(url.pathname)
  ) {
    throw new Error(
      "conversation_url must be the exact LinkedIn conversation URL ending in a slash"
    );
  }
  return url.href;
}

/** Serialized as one closed function; never clicks Send/Post or presses Enter. */
export async function fillLinkedInDraft(input: {
  kind: string;
  url: string;
  body: string;
}) {
  function fail(message: string): never {
    throw new Error(`LinkedIn draft: ${message}`);
  }
  if (location.href !== input.url)
    fail("The activated page is not the requested draft target");
  const visible = (element: Element) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  let editor: HTMLElement | undefined;
  if (input.kind === "prepare_message") {
    const selected = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        '.msg-conversation-listitem--active a[href*="/messaging/thread/"], a[aria-current="page"][href*="/messaging/thread/"]'
      ),
    ].filter(
      (link) =>
        visible(link) &&
        new URL(link.href).pathname === new URL(input.url).pathname
    );
    if (selected.length !== 1)
      fail("The selected conversation does not match the requested recipient");
    const threads = [...document.querySelectorAll(".msg-thread")].filter(
      visible
    );
    if (threads.length !== 1) fail("Exactly one conversation must be open");
    const editors = [
      ...threads[0].querySelectorAll<HTMLElement>(
        '.msg-form [contenteditable="true"][role="textbox"]'
      ),
    ].filter(visible);
    if (editors.length !== 1)
      fail("The conversation message composer is unavailable");
    editor = editors[0];
    if (
      threads[0].querySelector(
        '.msg-form__attachment, .msg-form__attachments [data-attachment-id], input[type="file"]:disabled'
      )
    ) {
      fail("The conversation already has an attachment draft");
    }
  } else if (input.kind === "prepare_post") {
    if (document.querySelector('[role="dialog"] [contenteditable="true"]'))
      fail("A composer is already open; finish or close it first");
    const buttons = [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href="https://www.linkedin.com/preload/sharebox/?"]'
      ),
    ].filter(
      (button) =>
        visible(button) && button.textContent?.trim() === "Start a post"
    );
    if (buttons.length !== 1)
      fail("The personal post composer entry point is unavailable");
    buttons[0].click();
    for (let attempt = 0; attempt < 40; attempt++) {
      const editors = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"] [contenteditable="true"][role="textbox"], [role="dialog"] .ql-editor[contenteditable="true"]'
        ),
      ].filter(visible);
      if (editors.length === 1) {
        editor = editors[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!editor) fail("The personal post composer did not open");
    const dialog = editor.closest('[role="dialog"]');
    if (
      !dialog ||
      dialog.querySelector('input[type="file"]:disabled, [data-attachment-id]')
    )
      fail("The post composer is not an empty text draft");
  } else fail("Unsupported draft action");
  if (!editor || location.href !== input.url)
    fail("The activated target changed");
  if (
    (editor.textContent ?? "").trim() ||
    editor.querySelector("img,video,audio,[contenteditable=false]")
  )
    fail("The composer already contains a draft");
  editor.focus();
  if (!document.execCommand("insertText", false, input.body))
    fail("The browser could not fill the draft");
  const normalized = (value: string) => value.replace(/\r\n/g, "\n").trim();
  if (
    normalized(editor.innerText ?? editor.textContent ?? "") !==
    normalized(input.body)
  )
    fail("The draft text could not be verified; review the composer");
  return {
    prepared: true,
    submitted: false,
    url: input.url,
    message:
      input.kind === "prepare_message"
        ? "Draft ready. Review it and click Send in LinkedIn."
        : "Draft ready. Review it and click Post in LinkedIn.",
  };
}

export async function prepareLinkedInDraft(
  ctx: ActionContext
): Promise<ActionResult> {
  try {
    const body =
      typeof ctx.input.body === "string" ? ctx.input.body.trim() : "";
    if (!body || body.length > 3000)
      throw new Error("body must contain 1–3000 characters");
    const url = linkedInDraftUrl(ctx.actionKey, ctx.input);
    const browser = requireBrowser(ctx);
    const nav = await browser.dispatch<{ tab_id?: number }>("navigate", {
      url,
      require_page_activation: true,
    });
    if (typeof nav.tab_id !== "number")
      throw new Error("The activated LinkedIn page is unavailable");
    const result = await browser.dispatch<{
      value?: Record<string, unknown>;
      exception?: unknown;
    }>("evaluate", {
      tab_id: nav.tab_id,
      await_promise: true,
      expression: `(${fillLinkedInDraft.toString()})(${linkedInScriptArgument({ kind: ctx.actionKey, url, body })})`,
    });
    if (
      result.exception ||
      result.value?.prepared !== true ||
      result.value?.submitted !== false
    ) {
      throw new Error(
        `Draft could not be verified: ${JSON.stringify(result.exception ?? result.value)}`
      );
    }
    return { success: true, output: { ...result.value, tab_id: nav.tab_id } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
