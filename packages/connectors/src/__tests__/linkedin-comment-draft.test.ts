import { beforeAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);
let buildFillCommentExpression: (body: string) => string;
let prepareLinkedInComment: typeof import("../linkedin").prepareLinkedInComment;
beforeAll(async () => {
  ({ buildFillCommentExpression, prepareLinkedInComment } = await import(
    "../linkedin"
  ));
});

test("a queued comment never overwrites text the user already entered", async () => {
  const dom = new JSDOM(
    '<div role="textbox" contenteditable="true">My existing comment</div>',
    { runScripts: "outside-only" }
  );
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 40 }) as any;
  dom.window.setTimeout = ((fn: () => void) => {
    fn();
    return 1;
  }) as any;
  const composer = dom.window.document.querySelector("[contenteditable]")!;
  const commands: string[] = [];
  dom.window.document.execCommand = (
    command: string,
    _ui: boolean,
    text?: string
  ) => {
    commands.push(command);
    if (command === "delete") composer.textContent = "";
    if (command === "insertText") composer.textContent = text ?? "";
    return true;
  };
  try {
    const result = await dom.window.eval(
      buildFillCommentExpression("An automated draft")
    );
    expect(result).toMatchObject({ ok: false, reason: "existing_draft" });
    expect(composer.textContent).toBe("My existing comment");
    expect(commands).toEqual([]);
    // A retry of the same draft is already prepared and is not retyped.
    const retry = await dom.window.eval(
      buildFillCommentExpression("My existing comment")
    );
    expect(retry).toMatchObject({ ok: true, reason: "already_prepared" });
    expect(commands).toEqual([]);
  } finally {
    dom.window.close();
  }
});

test("existing draft refusal cannot fall through to a destructive accessibility fill", async () => {
  const calls: string[] = [];
  const browser: any = {
    dispatch: async (key: string) => {
      calls.push(key);
      if (key === "navigate") return { tab_id: 1 };
      if (key === "evaluate")
        return { value: { ok: false, reason: "existing_draft" } };
      return {};
    },
  };
  await expect(
    prepareLinkedInComment(browser, {
      postUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:123456789/",
      body: "A draft",
    })
  ).rejects.toThrow("existing draft");
  expect(calls).not.toContain("type_ref");
  expect(calls).not.toContain("get_accessibility_tree");
});

test("an unavailable DOM check cannot fall back to overwriting an unread editor", async () => {
  const calls: string[] = [];
  const browser: any = {
    dispatch: async (key: string) => {
      calls.push(key);
      if (key === "navigate") return { tab_id: 1 };
      if (key === "evaluate") throw new Error("DOM evaluation unavailable");
      if (key === "get_accessibility_tree")
        return {
          document_epoch: 7,
          tree: [
            { ref_id: 3, role: "textbox", name: "Add a comment", tag: "div" },
          ],
        };
      return {};
    },
  };
  await expect(
    prepareLinkedInComment(browser, {
      postUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:123456789/",
      body: "A draft",
    })
  ).rejects.toThrow();
  expect(calls).not.toContain("type_ref");
});
