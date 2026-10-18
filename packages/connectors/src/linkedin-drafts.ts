import {
  requireBrowser,
  type ActionContext,
  type ActionResult,
} from "@lobu/connector-sdk";
import {
  LINKEDIN_HOME_URL,
  linkedInScriptArgument,
} from "./linkedin-browser-script.js";
import { fillLinkedInDraft } from "./linkedin-draft-page.js";

export function linkedInDraftUrl(
  kind: string,
  input: Record<string, unknown>
): string {
  if (kind === "prepare_post") return LINKEDIN_HOME_URL;
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
