import { describe, expect, it } from "vitest";
import {
  linkDestination,
  NAVIGATION_MAX_BYTES,
  NAVIGATION_MAX_DEPTH,
  NAVIGATION_MAX_ITEMS,
  type NavigationConfig,
  navigationHrefDestination,
  validateNavigationConfig,
} from "../contracts/tools/navigation";

const ORIGIN = "https://app.example";

const doc = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  sections: [{ id: "main", label: "Main", items }],
  ...extra,
});

describe("validateNavigationConfig", () => {
  it("accepts groups, clickable parents and repeated destinations", () => {
    const config: NavigationConfig = {
      schemaVersion: 1,
      sections: [
        {
          id: "work",
          label: "Work",
          items: [
            {
              id: "pipeline",
              label: "Pipeline",
              target: {
                kind: "view",
                key: "pipeline",
                params: { stage: "won", open: false, page: 0 },
              },
              children: [
                {
                  id: "deals",
                  target: { kind: "collection", entityType: "deal" },
                },
                {
                  id: "deals-again",
                  label: "Deals",
                  target: { kind: "collection", entityType: "deal" },
                },
              ],
            },
            {
              id: "reports",
              label: "Reports",
              children: [
                { id: "acme", target: { kind: "record", entityId: 7 } },
              ],
            },
            {
              id: "docs",
              label: "Docs",
              target: { kind: "link", href: "https://docs.example/x" },
            },
          ],
        },
        { id: "empty", items: [] },
      ],
    };
    expect(validateNavigationConfig(config)).toEqual([]);
  });

  it("rejects duplicate ids across sections and levels", () => {
    const errors = validateNavigationConfig({
      schemaVersion: 1,
      sections: [
        {
          id: "a",
          items: [{ id: "x", target: { kind: "record", entityId: 1 } }],
        },
        {
          id: "b",
          items: [
            {
              id: "g",
              label: "G",
              children: [{ id: "a", target: { kind: "record", entityId: 2 } }],
            },
            { id: "x", target: { kind: "record", entityId: 3 } },
          ],
        },
      ],
    });
    expect(errors.join("\n")).toContain("duplicate id 'a'");
    expect(errors.join("\n")).toContain("duplicate id 'x'");
  });

  it("requires a target or children, and a label on a group", () => {
    expect(
      validateNavigationConfig(doc([{ id: "lonely", label: "L" }]))[0]
    ).toContain("needs a target, children, or both");
    expect(
      validateNavigationConfig(
        doc([
          {
            id: "g",
            children: [{ id: "c", target: { kind: "record", entityId: 1 } }],
          },
        ])
      )[0]
    ).toContain("needs a label");
  });

  it("requires a label on a plain link", () => {
    expect(
      validateNavigationConfig(
        doc([{ id: "l", target: { kind: "link", href: "deal" } }])
      )[0]
    ).toContain("a link needs a label");
  });

  const chain = (levels: number) => {
    let item: Record<string, unknown> = {
      id: `l${levels}`,
      target: { kind: "record", entityId: 1 },
    };
    for (let level = levels - 1; level >= 1; level -= 1) {
      item = { id: `l${level}`, label: "x", children: [item] };
    }
    return item;
  };

  it("nests freely up to the depth ceiling and checks every nested item", () => {
    expect(
      validateNavigationConfig(doc([chain(NAVIGATION_MAX_DEPTH)]))
    ).toEqual([]);
    expect(
      validateNavigationConfig(doc([chain(NAVIGATION_MAX_DEPTH + 1)]))[0]
    ).toContain(`deeper than ${NAVIGATION_MAX_DEPTH} levels`);
    // A malformed item deep in the tree is found, with its path.
    const deep = chain(12) as { children: Array<Record<string, unknown>> };
    let cursor = deep;
    for (let i = 0; i < 6; i += 1) cursor = cursor.children[0] as typeof deep;
    cursor.children[0] = { id: "bad", target: { kind: "nope" } };
    expect(validateNavigationConfig(doc([deep]))[0]).toContain(
      ".children[0].children[0]"
    );
  });

  it("holds a thousand views in wide groups, and bounds the total and size", () => {
    const groups = (count: number, per: number) =>
      Array.from({ length: count }, (_, g) => ({
        id: `g${g}`,
        label: `Group ${g}`,
        children: Array.from({ length: per }, (_, i) => ({
          id: `g${g}-${i}`,
          target: { kind: "view", key: `view-${g}-${i}`, params: { page: 0 } },
        })),
      }));
    // No per-group child cap: 4 groups of 250 views.
    expect(validateNavigationConfig(doc(groups(4, 250)))).toEqual([]);
    expect(validateNavigationConfig(doc(groups(10, 500))).join("\n")).toContain(
      `more than ${NAVIGATION_MAX_ITEMS} items`
    );
    const huge = doc([
      {
        id: "big",
        label: "x".repeat(10),
        target: { kind: "link", href: `deal?q=${"x".repeat(2000)}` },
      },
    ]);
    (huge.sections[0] as { items: unknown[] }).items = Array.from(
      { length: 600 },
      (_, i) => ({
        id: `l${i}`,
        label: "L",
        target: { kind: "link", href: `deal?q=${"y".repeat(2000)}` },
      })
    );
    expect(validateNavigationConfig(huge)[0]).toContain(
      `exceed the limit of ${NAVIGATION_MAX_BYTES}`
    );
  });

  it("rejects unknown keys, versions and mixed view scopes", () => {
    expect(
      validateNavigationConfig(doc([], { extra: 1 })).length
    ).toBeGreaterThan(0);
    expect(
      validateNavigationConfig({ schemaVersion: 2, sections: [] }).length
    ).toBeGreaterThan(0);
    expect(
      validateNavigationConfig(
        doc([
          {
            id: "v",
            target: {
              kind: "view",
              key: "v",
              scope: { event: 1, type: "deal" },
            },
          },
        ])
      )[0]
    ).toContain(".target.scope: scope.event");
    expect(
      validateNavigationConfig(
        doc([
          { id: "v", target: { kind: "view", key: "v", scope: { nope: 1 } } },
        ])
      ).length
    ).toBeGreaterThan(0);
    expect(
      validateNavigationConfig(
        doc([
          {
            id: "v",
            target: { kind: "view", key: "v", params: { nested: { a: 1 } } },
          },
        ])
      ).length
    ).toBeGreaterThan(0);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "http://insecure.example",
    "/other-workspace/deal",
    "//evil.example/x",
    "../other/deal",
    "deal/%2e%2e/%2E%2E/x",
    "deal/..%2fx",
    "deal\\x",
    "deal x",
    "https://user:pw@evil.example",
  ])("rejects link href %s", (href) => {
    expect(
      validateNavigationConfig(
        doc([{ id: "l", label: "L", target: { kind: "link", href } }])
      )[0]
    ).toContain("target.href");
  });
});

describe("navigation destinations", () => {
  it("resolves workspace-relative paths under the workspace root", () => {
    expect(
      navigationHrefDestination("deal?stage=won&q=%C3%BC#top", ORIGIN, "acme")
    ).toEqual({
      kind: "internal",
      path: "/acme/deal?stage=won&q=%C3%BC#top",
    });
  });

  it("keeps https links external", () => {
    expect(
      navigationHrefDestination("https://docs.example/a?b=1", ORIGIN, "acme")
    ).toEqual({
      kind: "external",
      href: "https://docs.example/a?b=1",
    });
  });

  it("confines a view's same-origin links to its workspace", () => {
    expect(linkDestination(`${ORIGIN}/acme/deal/x`, ORIGIN, "acme")).toEqual({
      kind: "internal",
      path: "/acme/deal/x",
    });
    expect(linkDestination(`${ORIGIN}/acme`, ORIGIN, "acme")?.kind).toBe(
      "internal"
    );
    expect(
      linkDestination(`${ORIGIN}/acme-other/x`, ORIGIN, "acme")
    ).toBeNull();
    expect(
      linkDestination(`${ORIGIN}/acme/../other/x`, ORIGIN, "acme")
    ).toBeNull();
    expect(
      linkDestination(`${ORIGIN}/account/settings`, ORIGIN, "acme")
    ).toBeNull();
    expect(linkDestination("javascript:alert(1)", ORIGIN, "acme")).toBeNull();
    expect(linkDestination("data:text/html,x", ORIGIN, "acme")).toBeNull();
    expect(
      linkDestination("http://elsewhere.example/", ORIGIN, "acme")
    ).toBeNull();
  });
});
