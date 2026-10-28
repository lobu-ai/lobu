/**
 * Presentational kit logic: pagination clamping and chart scaling/layout edge
 * cases, rendered without a host (pure props in, DOM out).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BarChart,
  DataTable,
  formatCompact,
  LineChart,
  PieChart,
  Sparkline,
} from "../components.js";

let dom: JSDOM;
let root: Root | null = null;
let el: HTMLElement;

function render(node: React.ReactNode): void {
  act(() => {
    root?.render(node);
  });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://views.test/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.navigator;
  delete g.IS_REACT_ACT_ENVIRONMENT;
  dom.window.close();
});

async function shown(): Promise<string> {
  await act(async () => undefined);
  return el.innerHTML;
}

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 2, name: "b" },
  { id: 1, name: "a" },
];

describe("DataTable", () => {
  test("pagination clamps at the ends", async () => {
    const pages: number[] = [];
    render(
      <DataTable
        columns={[{ key: "id", header: "ID" }]}
        rows={ROWS}
        keyOf={(r) => r.id}
        pagination={{
          page: 1,
          pageSize: 2,
          total: 5,
          onPage: (p) => pages.push(p),
        }}
      />
    );
    expect(await shown()).toContain("Page 1 of 3");
    const [prev, next] = [...el.querySelectorAll("nav button")];
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    expect(pages).toEqual([2]);
  });

  test("shrinking total keeps pagination so the user can navigate back", async () => {
    const pages: number[] = [];
    render(
      <DataTable
        columns={[{ key: "id", header: "ID" }]}
        rows={[]}
        keyOf={(_, i) => i}
        emptyText="No rows on this page."
        pagination={{
          page: 2,
          pageSize: 10,
          total: 5,
          onPage: (p) => pages.push(p),
        }}
      />
    );
    // Total shrank 15 -> 5 while the view sat on page 2: the rows are gone
    // but Previous must stay reachable.
    expect(await shown()).toContain("No rows on this page.");
    expect(await shown()).toContain("Page 2 of 1");
    const [prev, next] = [...el.querySelectorAll("nav button")];
    expect((prev as HTMLButtonElement).disabled).toBe(false);
    expect((next as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      prev.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    expect(pages).toEqual([1]);
  });

  test("pagination works without a total and stops after a short page", async () => {
    const pages: number[] = [];
    const table = (rows: Row[], page: number) => (
      <DataTable
        columns={[{ key: "id", header: "ID" }]}
        rows={rows}
        keyOf={(r) => r.id}
        pagination={{ page, pageSize: 2, onPage: (p) => pages.push(p) }}
      />
    );
    render(table(ROWS, 1));
    const next = el.querySelector(
      '[aria-label="Next page"]'
    ) as HTMLButtonElement;
    expect(next).not.toBeNull();
    await act(async () => next.click());
    expect(pages).toEqual([2]);
    render(table(ROWS.slice(0, 1), 2));
    expect(
      (el.querySelector('[aria-label="Next page"]') as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (el.querySelector('[aria-label="Previous page"]') as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
});

describe("charts", () => {
  const data = [
    { label: "Jan", value: 10 },
    { label: "Feb", value: 20 },
  ];

  // A large level with small movement: from zero the line is flat at the top.
  const level = [
    { label: "W1", value: 2_600_000 },
    { label: "W2", value: 2_700_000 },
  ];
  const ys = () =>
    [...el.querySelectorAll("circle")].map((c) => Number(c.getAttribute("cy")));

  test("line chart baseline auto spreads a narrow range over the plot", () => {
    render(<LineChart data={level} height={180} baseline="auto" />);
    const points = ys();
    expect(points).toHaveLength(2);
    const [a, b] = points;
    // 180 tall, 6 top + 22 bottom padding: 152px of plot; 10% headroom each side.
    expect(Math.abs(a! - b!)).toBeGreaterThan(100);
    expect(el.textContent).toContain("2590000");
  });

  test.each([
    { count: 0, anchors: [] },
    { count: 1, anchors: ["middle"] },
    { count: 2, anchors: ["start", "end"] },
    { count: 3, anchors: ["start", "middle", "end"] },
    {
      count: 8,
      anchors: [
        "start",
        "middle",
        "middle",
        "middle",
        "middle",
        "middle",
        "middle",
        "end",
      ],
    },
    { count: 9, anchors: [] },
  ])("line chart positions and anchors labels for $count points", ({
    count,
    anchors,
  }) => {
    render(
      <LineChart
        data={Array.from({ length: count }, (_, i) => ({
          label: `2026-01-${String(i + 1).padStart(2, "0")}`,
          value: i,
        }))}
      />
    );
    const labels = [...el.querySelectorAll("g > text")];
    expect(labels.map((t) => t.getAttribute("text-anchor"))).toEqual(anchors);
    const axis = el.querySelectorAll("line")[1]!;
    const left = Number(axis.getAttribute("x1"));
    const right = Number(axis.getAttribute("x2"));
    if (count === 1) {
      expect(Number(labels[0]!.getAttribute("x"))).toBe((left + right) / 2);
    } else if (labels.length > 1) {
      expect(Number(labels[0]!.getAttribute("x"))).toBe(left);
      expect(Number(labels.at(-1)!.getAttribute("x"))).toBe(right);
    }
  });

  test("line chart defaults to a zero baseline", () => {
    render(<LineChart data={level} height={180} />);
    const points = ys();
    expect(points).toHaveLength(2);
    const [a, b] = points;
    expect(Math.abs(a! - b!)).toBeLessThan(40);
  });

  test.each([
    BarChart,
    LineChart,
  ])("%p uses content width and cleans up its observer", (Chart) => {
    const g = globalThis as unknown as Record<string, unknown>;
    const original = Object.getOwnPropertyDescriptor(g, "ResizeObserver");
    let resize: (width: number) => void = () => undefined;
    let observed: Element | undefined;
    let disconnected = false;
    g.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        resize = (width) =>
          cb(
            [
              {
                contentRect: new dom.window.DOMRect(0, 0, width, 120),
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver
          );
      }
      observe(target: Element) {
        observed = target;
      }
      disconnect() {
        disconnected = true;
      }
    };
    try {
      render(<Chart data={data} height={120} />);
      expect(el.querySelector("svg")?.getAttribute("viewBox")).toBe(
        "0 0 320 120"
      );
      const figure = el.querySelector("figure") as HTMLElement;
      expect(observed).toBe(figure);
      // Transforms change outer bounds without changing the SVG's layout width.
      figure.getBoundingClientRect = () =>
        new dom.window.DOMRect(0, 0, 400, 120);
      for (const width of [800, 200, 640]) {
        act(() => resize(width));
        const svg = el.querySelector("svg");
        expect(svg?.getAttribute("viewBox")).toBe(`0 0 ${width} 120`);
        expect(svg?.querySelectorAll("line")[1]?.getAttribute("x2")).toBe(
          String(width - 8)
        );
      }
      act(() => resize(0));
      expect(el.querySelector("svg")?.getAttribute("viewBox")).toBe(
        "0 0 640 120"
      );
      render(null);
      expect(disconnected).toBe(true);
    } finally {
      if (original) Object.defineProperty(g, "ResizeObserver", original);
      else delete g.ResizeObserver;
    }
  });

  test.each([
    [],
    [0],
    [20],
    [-20, -20],
    [-20, -10],
    [-10, 20],
  ])("line chart auto bounds contain %j", (...values) => {
    const formatted: number[] = [];
    render(
      <LineChart
        data={values.map((value, i) => ({ label: String(i), value }))}
        baseline="auto"
        formatValue={(value) => {
          formatted.push(value);
          return `value=${value}`;
        }}
      />
    );
    expect(ys()).toHaveLength(values.length);
    for (const y of ys()) {
      expect(y).toBeGreaterThan(6);
      expect(y).toBeLessThan(158);
    }
    expect(formatted.every(Number.isFinite)).toBe(true);
    expect(el.textContent).toContain("value=");
  });

  test.each([
    [-10, 20],
    [-10, -20],
  ])("bar chart preserves negative values %j", (...values) => {
    render(
      <BarChart
        data={values.map((value, i) => ({ label: String(i), value }))}
      />
    );
    const bars = [...el.querySelectorAll("rect")];
    expect(bars.length).toBe(2);
    for (const bar of bars) {
      expect(Number(bar.getAttribute("height"))).toBeGreaterThan(0);
      expect(Number(bar.getAttribute("y"))).toBeGreaterThanOrEqual(0);
      expect(
        Number(bar.getAttribute("y")) + Number(bar.getAttribute("height"))
      ).toBeLessThanOrEqual(180);
    }
  });

  test("a small single-slice pie fits its viewport", () => {
    render(<PieChart data={[{ label: "One", value: 1 }]} size={100} />);
    const circle = el.querySelector("circle")!;
    const cy = Number(circle.getAttribute("cy"));
    const radius = Number(circle.getAttribute("r"));
    expect(cy - radius).toBeGreaterThanOrEqual(0);
    expect(cy + radius).toBeLessThanOrEqual(100);
  });

  test("a single sparkline observation remains visible", () => {
    render(<Sparkline values={[3]} />);
    expect(el.querySelector("circle")).not.toBeNull();
  });

  test("empty data renders an empty frame, never throws", async () => {
    render(
      <>
        <BarChart data={[]} />
        <LineChart data={[]} />
        <PieChart data={[]} />
        <Sparkline values={[]} />
      </>
    );
    await shown();
    expect(el.querySelectorAll("svg").length).toBe(4);
  });
});

describe("formatCompact", () => {
  test("formatCompact", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatCompact(2_500_000)).toBe("2.5M");
  });
});
