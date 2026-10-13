import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);
const { fillLinkedInDraft, linkedInDraftUrl, prepareLinkedInDraft } =
  await import("../linkedin-drafts");
const threadUrl = "https://www.linkedin.com/messaging/thread/synthetic-thread/";

function draftPage(html: string, url = threadUrl) {
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
        `(${fillLinkedInDraft.toString()})(${JSON.stringify({ kind, url, body })})`
      ),
  };
}

const composer =
  '<div class="msg-conversation-listitem--active"><a href="/messaging/thread/synthetic-thread/">Alex Example</a></div><div class="msg-thread"><form class="msg-form"><div tabindex="0" role="textbox" contenteditable="true"></div><button>Send</button></form></div>';

describe("LinkedIn human-submitted drafts", () => {
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
    composer.replace(
      'href="/messaging/thread/synthetic-thread/"',
      'href="/messaging/thread/different-thread/"'
    ),
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
