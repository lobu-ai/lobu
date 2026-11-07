import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, useAction } from "../api.js";
import { ViewBridge } from "../bridge.js";

let submit: ReturnType<typeof useAction>;
let submitTyped: ReturnType<typeof useAction>;
const typedBinding = { key: "test.set_stage", version: 1 };
function Probe() {
  submit = useAction("vote");
  submitTyped = useAction("setStage");
  return <input aria-label="Event response" defaultValue="" />;
}
const def = defineView({
  key: "event-vote",
  attach: [{ event: "test.poll", type: "test_record" }],
  actions: {
    vote: { emits: "test.vote" },
    setStage: { action: typedBinding },
  },
});
let dom: JSDOM;
let root: Root;
let bridge: ViewBridge;
type Message = {
  id: number;
  method: string;
  params: {
    arguments: {
      scope?: { event: number };
      value: Record<string, unknown>;
      binding?: { key: string; version: number };
      expected?: Record<string, unknown>;
      interaction_id: string;
    };
  };
};
let posted: Message[];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function send(data: unknown) {
  const event = new dom.window.MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: dom.window });
  dom.window.dispatchEvent(event);
}
const calls = () => posted.filter((m) => m.method === "tools/call");

beforeEach(async () => {
  typedBinding.version = 1;
  dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    {
      url: "https://views.test/",
    }
  );
  const g = globalThis as unknown as Record<string, unknown>;
  Object.assign(g, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MessageEvent: dom.window.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  posted = [];
  bridge = new ViewBridge(
    {
      postMessage: (m: unknown) => posted.push(m as Message),
    } as unknown as Window,
    null,
    { requestTimeoutMs: 100 }
  );
  root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      <Provider def={def} bridge={bridge}>
        <Probe />
      </Provider>
    );
    await tick();
  });
  const init = posted.find((m) => m.method === "ui/initialize")!;
  await act(async () => {
    send({ jsonrpc: "2.0", id: init.id, result: { hostContext: {} } });
    await tick();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  bridge.close();
  dom.window.close();
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "navigator",
    "MessageEvent",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    delete g[key];
});

test("does not submit before the host supplies the subject", async () => {
  const result = await submit({ choice: "yes" });
  expect(result.ok).toBe(false);
  expect(calls()).toHaveLength(0);
});

test("explicit retry keeps the accepted intent, while another submission gets a new id", async () => {
  await act(async () => {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { scope: { event: 41 }, params: {} } },
    });
    await tick();
  });
  await act(async () => {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: { view: "event-vote", scope: { event: 42 } },
      },
    });
    await tick();
  });
  const value = { choice: "yes" };
  // The server accepted this request, but its acknowledgement never reaches the guest.
  const failed = await submit(value);
  expect(failed.ok).toBe(false);
  const first = calls()[0];
  expect(first.params.arguments.scope).toEqual({ event: 42 });
  value.choice = "no";
  expect(typeof failed.retry).toBe("function");
  if (!failed.retry)
    throw new Error("Expected a retry after the lost acknowledgement");
  const retry = failed.retry();
  await tick();
  const second = calls()[1];
  expect(second.params.arguments).toEqual(first.params.arguments);
  expect(second.params.arguments.value).toEqual({ choice: "yes" });
  send({
    jsonrpc: "2.0",
    id: second.id,
    result: {
      structuredContent: { created: false, event_id: 99 },
      content: [],
    },
  });
  expect((await retry).ok).toBe(true);
  const next = submit({ choice: "yes" });
  await tick();
  const third = calls()[2];
  expect(third.params.arguments.interaction_id).not.toBe(
    first.params.arguments.interaction_id
  );
  send({
    jsonrpc: "2.0",
    id: third.id,
    result: {
      structuredContent: { created: true, event_id: 100 },
      content: [],
    },
  });
  expect((await next).ok).toBe(true);
});

test("registered action retries retain the loaded revision and observed fields", async () => {
  await act(async () => {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { scope: { event: 42 }, params: {} } },
    });
    await tick();
  });
  const value = { id: 7, stage: "review" };
  const expected = { stage_event_id: null as number | null };
  const failed = await submitTyped(value, { expected });
  expect(failed.ok).toBe(false);
  const first = calls()[0];
  expect(first.params.arguments).toMatchObject({
    binding: { key: "test.set_stage", version: 1 },
    expected: { stage_event_id: null },
    scope: { event: 42 },
    value: { id: 7, stage: "review" },
  });
  value.stage = "done";
  expected.stage_event_id = 99;
  typedBinding.version = 2;
  if (!failed.retry) throw new Error("Expected an explicit retry");
  const retry = failed.retry();
  await tick();
  const second = calls()[1];
  expect(second.params.arguments).toEqual(first.params.arguments);
  send({
    jsonrpc: "2.0",
    id: second.id,
    result: {
      structuredContent: { created: false, event_id: 100 },
      content: [],
    },
  });
  expect((await retry).ok).toBe(true);
});

test("resolving a replacement event discards the previous subject's form", async () => {
  await act(async () => {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { scope: { event: 41 }, params: {} } },
    });
    await tick();
  });
  const original = dom.window.document.querySelector("input");
  if (!original) throw new Error("Expected the event form");
  original.value = "Answer to the old event";
  await act(async () => {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: { view: "event-vote", scope: { event: 42 } },
      },
    });
    await tick();
  });
  expect(dom.window.document.querySelector("input")?.value).toBe("");
});
