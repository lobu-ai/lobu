import { beforeAll, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";
import { JSDOM } from "jsdom";
import { buildLinkedInLikeExpression, setLinkedInLike } from "../linkedin-like";

mock.module("@lobu/connector-sdk", connectorSdkMock);
let LinkedIn: any;
beforeAll(async () => {
  LinkedIn = (await import("../linkedin.connector")).default;
});

test("LinkedIn declares an idempotent set_like action", () => {
  const action = new LinkedIn().definition.actions.set_like;
  expect(action?.kind).toBe("write");
  expect(action?.annotations.idempotentHint).toBe(true);
  expect(action?.inputSchema.required).toEqual(["post_url", "liked"]);
});

test("set_like rejects invalid state before touching a browser", async () => {
  const result = await new LinkedIn().execute({
    actionKey: "set_like",
    input: { post_url: "https://www.linkedin.com/feed/", liked: "true" },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("liked must be a boolean");
});

const postUrl =
  "https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000123/";

function page(label = "no reaction", extra = "") {
  const dom = new JSDOM(
    `<main><button aria-label="Reaction button state: ${label}">Like</button>${extra}</main>`,
    { url: postUrl, runScripts: "outside-only" }
  );
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ width: 10 }] as any;
  const button = dom.window.document.querySelector("button")!;
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    const liked =
      button.getAttribute("aria-label") === "Reaction button state: Like";
    button.setAttribute(
      "aria-label",
      `Reaction button state: ${liked ? "no reaction" : "Like"}`
    );
  };
  return { dom, clicks: () => clicks };
}

test("sets desired state, ignores comment controls and does not toggle on retry", async () => {
  const { dom, clicks } = page(
    "no reaction",
    '<div id="replaceableComment_123"><button aria-label="Reaction button state: no reaction">Like comment</button></div>'
  );
  const first = await dom.window.eval(
    buildLinkedInLikeExpression(postUrl, true)
  );
  expect(first).toEqual({ liked: true, changed: true, post_url: postUrl });
  const retry = await dom.window.eval(
    buildLinkedInLikeExpression(postUrl, true)
  );
  expect(retry.changed).toBe(false);
  expect(clicks()).toBe(1);
  const removed = await dom.window.eval(
    buildLinkedInLikeExpression(postUrl, false)
  );
  expect(removed.liked).toBe(false);
  expect(clicks()).toBe(2);
  dom.window.close();
});

test("rejects a different post, ambiguous controls and other reaction types", async () => {
  for (const [label, extra, url, error] of [
    ["no reaction", "", postUrl.replace("0123", "0456"), "post changed"],
    [
      "no reaction",
      '<button aria-label="Reaction button state: no reaction">Other post</button>',
      postUrl,
      "ambiguous",
    ],
    ["Celebrate", "", postUrl, "Preserving"],
  ]) {
    const { dom, clicks } = page(label, extra);
    await expect(
      dom.window.eval(buildLinkedInLikeExpression(url, true))
    ).rejects.toThrow(error);
    expect(clicks()).toBe(0);
    dom.window.close();
  }
});

test("rejects navigation after a click instead of confirming the wrong post", async () => {
  const { dom } = page();
  dom.window.document.querySelector("button")!.onclick = () =>
    dom.window.history.replaceState({}, "", postUrl.replace("0123", "0456"));
  await expect(
    dom.window.eval(buildLinkedInLikeExpression(postUrl, true))
  ).rejects.toThrow("post changed");
  dom.window.close();
});

test("re-reads after reload and closes only its scratch tab on verification failure", async () => {
  const calls: Array<{ key: string; input: any }> = [];
  let reads = 0;
  const browser: any = {
    dispatch: async (key: string, input: any) => {
      calls.push({ key, input });
      if (key === "navigate") return { tab_id: 99 };
      if (key === "evaluate")
        return {
          value: {
            post_url: postUrl,
            liked: ++reads === 1,
            changed: reads === 1,
          },
        };
      return {};
    },
  };
  await expect(setLinkedInLike(browser, postUrl, true)).rejects.toThrow(
    "did not persist"
  );
  expect(calls.map((c) => c.key)).toEqual([
    "navigate",
    "evaluate",
    "navigate",
    "evaluate",
    "close_tab",
  ]);
  expect(calls.at(-1)?.input.tab_id).toBe(99);
});
