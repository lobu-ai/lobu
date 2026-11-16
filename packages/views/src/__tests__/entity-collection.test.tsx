/**
 * EntityCollection on a host without native components: a plain table over
 * the same `manage_entity_schema get` + `manage_entity list` reads, through
 * the real Provider + ViewBridge, failing closed instead of reading every row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider } from "../api.js";
import { ViewBridge } from "../bridge.js";
import {
  EntityCollection,
  type EntityCollectionProps,
  NATIVE_COMPONENT_GLOBAL,
} from "../components.js";

const SCHEMA = {
  properties: {
    status: {
      type: "string",
      enum: ["open", "closed"],
      "x-table-column": true,
      title: "Status",
    },
    due_at: { type: "string", "x-table-column": true, title: "Due" },
  },
  "x-lobu-collection": {
    presets: [
      {
        key: "open",
        label: "Open matters",
        selection: { filters: [{ field: "status", op: "eq", value: "open" }] },
        table: { sort: { field: "due_at", order: "asc" } },
      },
      {
        key: "by-name",
        label: "By name",
        selection: {},
        table: { columns: ["status"], sort: { field: "name", order: "asc" } },
      },
      {
        key: "mine",
        label: "My matters",
        selection: {},
        viewer: { field: "owner_email" },
      },
      {
        key: "this-week",
        label: "Due this week",
        selection: {},
        relativeDate: {
          field: "due_at",
          fromDays: 0,
          toDays: 7,
          timeZone: "UTC",
        },
      },
    ],
  },
};
const ROWS = [
  {
    id: 11,
    name: "Acme v. Beta",
    slug: "acme",
    entity_type: "matter",
    metadata: { status: "open" },
  },
  {
    id: 12,
    name: "Gamma estate",
    slug: "gamma",
    entity_type: "matter",
    metadata: { status: "closed" },
  },
];

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

/** What the host answers each request with. */
function answer(message: Message): unknown {
  if (message.method === "ui/initialize")
    return { hostContext: { theme: "light" } };
  if (message.method === "lobu/open-record") return { mode: "peek" };
  if (message.method !== "tools/call") return {};
  const { name, arguments: input } = message.params as {
    name: string;
    arguments: Record<string, unknown>;
  };
  if (name === "manage_entity_schema")
    return {
      structuredContent: {
        entity_type: {
          slug: "matter",
          name: "Matter",
          metadata_schema: SCHEMA,
        },
      },
    };
  const filters = (input.filters ?? []) as Array<{
    field: string;
    value: unknown;
  }>;
  const entities = ROWS.filter((row) =>
    filters.every(
      (filter) => row.metadata[filter.field as "status"] === filter.value
    )
  );
  return {
    structuredContent: {
      entities,
      metadata: { has_more: false, total_count: entities.length },
    },
  };
}

/** A host that answers the two reads and records what reached it. */
class Host {
  received: Message[] = [];
  postMessage(raw: unknown): void {
    const message = raw as Message;
    this.received.push(message);
    if (message.id !== undefined) reply(message.id, answer(message));
  }
  lists(): Array<Record<string, unknown>> {
    return this.received
      .filter(
        (m) => m.method === "tools/call" && m.params?.name === "manage_entity"
      )
      .map((m) => m.params?.arguments as Record<string, unknown>);
  }
}

/** Replies wait for `settle()`, so every state update lands inside act(). */
let pending: Array<() => void> = [];
function reply(id: number, result: unknown): void {
  pending.push(() => {
    const w = (globalThis as unknown as { window: Window }).window;
    const event = new w.MessageEvent("message", {
      data: { jsonrpc: "2.0", id, result },
    });
    Object.defineProperty(event, "source", { value: w });
    w.dispatchEvent(event);
  });
}

const DEF = defineView({ key: "collection-probe", attach: [] });
let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge | null = null;
let host: Host;
let el: HTMLElement;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://views.test/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.MessageEvent = dom.window.MessageEvent;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  pending = [];
  host = new Host();
  bridge = new ViewBridge(host as unknown as Window, null, {
    requestTimeoutMs: 10_000,
  });
  el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  bridge?.close();
  bridge = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "navigator",
    "MessageEvent",
    "IS_REACT_ACT_ENVIRONMENT",
    NATIVE_COMPONENT_GLOBAL,
  ])
    delete g[key];
  dom.window.close();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      const due = pending;
      pending = [];
      for (const send of due) send();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function mount(props: EntityCollectionProps): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <EntityCollection {...props} />
      </Provider>
    );
  });
  await settle();
  const w = (globalThis as unknown as { window: Window }).window;
  const input = new w.MessageEvent("message", {
    data: {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { scope: {}, params: {} } },
    },
  });
  Object.defineProperty(input, "source", { value: w });
  await act(async () => {
    w.dispatchEvent(input);
  });
  await settle();
}

describe("EntityCollection without native components", () => {
  test("reads the preset's selection and opens a record in the host's peek", async () => {
    await mount({ entityType: "matter", preset: "open" });
    expect(el.textContent).toContain("Acme v. Beta");
    expect(el.textContent).not.toContain("Gamma estate");
    expect(el.querySelector("th")?.textContent).toBe("Name");
    expect(host.lists()).toEqual([
      expect.objectContaining({
        action: "list",
        entity_type: "matter",
        filters: [{ field: "status", op: "eq", value: "open" }],
      }),
    ]);
    const name = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Acme v. Beta"
    );
    await act(async () => name?.click());
    await settle();
    expect(
      host.received.find((m) => m.method === "lobu/open-record")?.params
    ).toEqual({
      record: { entity_id: 11, entity_type: "matter" },
      mode: "peek",
    });
  });

  test("lists in the preset's order with the preset's columns", async () => {
    await mount({ entityType: "matter", preset: "by-name" });
    expect(host.lists()).toEqual([
      expect.objectContaining({ sort_by: "name", sort_order: "asc" }),
    ]);
    expect([...el.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Name",
      "Status",
    ]);
  });

  test("a stored type lists newest first when the preset sorts by an attribute", async () => {
    await mount({ entityType: "matter", preset: "open" });
    expect(host.lists()).toEqual([
      expect.objectContaining({ sort_by: "created_at", sort_order: "desc" }),
    ]);
    expect([...el.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Name",
      "Status",
      "Due",
    ]);
  });

  test("a selection beside a preset edits it", async () => {
    await mount({
      entityType: "matter",
      preset: "open",
      selection: { search: "estate" },
    });
    expect(host.lists()).toEqual([
      expect.objectContaining({ search: "estate", filters: undefined }),
    ]);
  });

  test.each([
    ["a viewer preset, with no identity in a view", { preset: "mine" }],
    ["an unknown preset", { preset: "missing" }],
    ["a relative-date preset it cannot resolve alone", { preset: "this-week" }],
    ["a selection with an unknown key", { selection: { filter: [] } as never }],
    ["an empty segment", { selection: { segment: "" } }],
    ["an over-long segment", { selection: { segment: "s".repeat(121) } }],
    ["an over-long search", { selection: { search: "q".repeat(513) } }],
    [
      "an over-long filter value",
      {
        selection: {
          filters: [{ field: "status", op: "eq", value: "v".repeat(2001) }],
        },
      },
    ],
    [
      "too many filters",
      {
        selection: {
          filters: Array.from({ length: 33 }, () => ({
            field: "status",
            op: "eq" as const,
            value: "open",
          })),
        },
      },
    ],
    [
      "filters that are not a list",
      { defaultSelection: { filters: "status=open" } as never },
    ],
    [
      "an unknown operator",
      {
        defaultSelection: {
          filters: [{ field: "status", op: "like", value: "x" }],
        } as never,
      },
    ],
  ])("fails closed on %s", async (_case, props) => {
    await mount({ entityType: "matter", ...props });
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.lists()).toEqual([]);
    expect(el.textContent).not.toContain("Acme v. Beta");
  });

  test("renders the host's native collection when it supplies one", async () => {
    (globalThis as unknown as Record<string, unknown>)[
      NATIVE_COMPONENT_GLOBAL
    ] = {
      EntityCollection: (props: EntityCollectionProps) => (
        <p>native {props.entityType}</p>
      ),
    };
    await mount({ entityType: "matter" });
    expect(el.textContent).toBe("native matter");
    expect(host.received.filter((m) => m.method === "tools/call")).toEqual([]);
  });
});
