import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";
import { linkedInScriptArgument } from "../linkedin-browser-script";

mock.module("@lobu/connector-sdk", connectorSdkMock);
const { linkedInDraftUrl, prepareLinkedInDraft } =
  await import("../linkedin-drafts");
const { fillLinkedInDraft } = await import("../linkedin-draft-page.js");
const threadUrl = "https://www.linkedin.com/messaging/thread/synthetic-thread/";

function draftPage(html: string, url = threadUrl, target = url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ width: 100, height: 100 }] as any;
  const clicks: string[] = [];
  dom.window.document.addEventListener("click", (event: Event) =>
    clicks.push((event.target as HTMLElement).textContent ?? "")
  );
  dom.window.document.execCommand = (
    command: string,
    _show: boolean,
    text: string
  ) => {
    expect(command).toBe("insertText");
    dom.window.document.activeElement!.textContent = text ?? "";
    return true;
  };
  return {
    dom,
    clicks,
    fill: (kind: string, body: string) =>
      dom.window.eval(
        `(${fillLinkedInDraft.toString()})(${linkedInScriptArgument({ kind, url: target, body })})`
      ),
  };
}

// Current LinkedIn markup: the selected list item carries no thread href; only the
// open thread's header names the counterpart.
const conversation = (listName: string, threadName = listName) =>
  `<li class="msg-conversation-listitem"><div class="msg-conversation-listitem__link msg-conversations-container__convo-item-link--active"><img alt="${listName}"><h3 class="msg-conversation-listitem__participant-names">${listName}</h3></div></li><div class="msg-thread"><h2 class="msg-entity-lockup__entity-title">${threadName}</h2><form class="msg-form"><div tabindex="0" role="textbox" contenteditable="true"></div><button>Send</button></form></div>`;
const composer = conversation("Alex Example");

describe("LinkedIn human-submitted drafts", () => {
  test("browser arguments round-trip as data without escaping a script context", () => {
    const value = JSON.parse('{"__proto__":{"injected":true}}');
    value.body =
      '</script ><script>globalThis.injected = true</script >\u2028\u2029`"\\';
    const dom = new JSDOM(
      `<script>globalThis.input = ${linkedInScriptArgument(value)};</script>`,
      { runScripts: "outside-only" }
    );
    try {
      expect(dom.window.document.scripts).toHaveLength(1);
      dom.window.eval(dom.window.document.scripts[0].textContent ?? "");
      expect(dom.window.input.body).toBe(value.body);
      expect(Object.hasOwn(dom.window.input, "__proto__")).toBe(true);
      expect(dom.window.input.injected).toBeUndefined();
      expect(dom.window.injected).toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  test("fills an empty exact conversation without clicking Send", async () => {
    const { dom, fill, clicks } = draftPage(composer);
    try {
      expect(await fill("prepare_message", "Hello\nAlex")).toMatchObject({
        prepared: true,
        submitted: false,
      });
      expect(
        dom.window.document.querySelector('[contenteditable="true"]')
          ?.textContent
      ).toBe("Hello\nAlex");
      expect(clicks).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  test.each([
    composer.replace(
      'contenteditable="true"></div>',
      'contenteditable="true">Existing draft</div>'
    ),
    composer + composer,
    conversation("Alex Example", "Sam Example"),
    composer.replace("convo-item-link--active", "convo-item-link"),
    composer.replace(
      "</form>",
      '<div class="msg-form__attachment">attachment</div></form>'
    ),
  ])("refuses existing drafts, ambiguity and attachments", async (html) => {
    const { dom, fill, clicks } = draftPage(html);
    try {
      await expect(fill("prepare_message", "Hello")).rejects.toThrow();
      expect(clicks).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  test("refuses a conversation other than the requested thread", async () => {
    // The list and header carry no thread identity, so the exact URL is what
    // ties the draft to the requested conversation.
    const { dom, fill, clicks } = draftPage(
      composer,
      "https://www.linkedin.com/messaging/thread/other-thread/",
      threadUrl
    );
    try {
      await expect(fill("prepare_message", "Hello")).rejects.toThrow(
        "not the requested draft target"
      );
      expect(
        dom.window.document.querySelector('[contenteditable="true"]')
          ?.textContent
      ).toBe("");
      expect(clicks).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  test("post draft only clicks the personal composer opener", async () => {
    const { dom, fill, clicks } = draftPage(
      "<button>Start a post</button>",
      "https://www.linkedin.com/feed/foryou/"
    );
    dom.window.document
      .querySelector("button")!
      .addEventListener("click", () => {
        dom.window.document.body.insertAdjacentHTML(
          "beforeend",
          '<div role="dialog"><div tabindex="0" role="textbox" contenteditable="true"></div><button>Post</button></div>'
        );
      });
    try {
      expect(await fill("prepare_post", "A draft post")).toMatchObject({
        prepared: true,
        submitted: false,
      });
      expect(clicks).toEqual(["Start a post"]);
    } finally {
      dom.window.close();
    }
  });
  test("rejects off-site and generic message targets before browser dispatch", async () => {
    for (const url of [
      "https://evil.example/messaging/thread/a/",
      "https://www.linkedin.com/messaging/",
      `${threadUrl}?different=1`,
    ]) {
      expect(() =>
        linkedInDraftUrl("prepare_message", { conversation_url: url })
      ).toThrow();
      const result = await prepareLinkedInDraft({
        actionKey: "prepare_message",
        input: { conversation_url: url, body: "Hello" },
        browser: {
          dispatch: () => {
            throw new Error("must not dispatch");
          },
        },
      } as any);
      expect(result.success).toBe(false);
      expect(result.error).not.toContain("must not dispatch");
    }
  });
  test("production action requires page activation and verifies the draft result", async () => {
    const calls: Array<{ key: string; input: any }> = [];
    const result = await prepareLinkedInDraft({
      actionKey: "prepare_message",
      input: { conversation_url: threadUrl, body: "Hello" },
      browser: {
        dispatch: async (key: string, input: any) => {
          calls.push({ key, input });
          return key === "navigate"
            ? { tab_id: 1 }
            : { value: { prepared: true, submitted: false } };
        },
      },
    } as any);
    expect(result.success).toBe(true);
    expect(calls[0]).toMatchObject({
      key: "navigate",
      input: { url: threadUrl, require_page_activation: true },
    });
    expect(calls.map((call) => call.key)).toEqual(["navigate", "evaluate"]);
  });
});
