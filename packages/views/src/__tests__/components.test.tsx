/**
 * Presentational kit coverage: every `@lobu/views/components` export renders
 * without a host (pure props in, DOM out) and reports intent through
 * callbacks. No bridge, no tools — the kit never talks to the host itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BarChart,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  formatCompact,
  LineChart,
  LoadingState,
  PieChart,
  SearchField,
  SelectField,
  Sparkline,
  TruncatedNotice,
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

describe("Card", () => {
  test("title, description, actions and children", async () => {
    render(
      <Card
        title="Deals"
        description="Open pipeline"
        actions={<button type="button">New</button>}
      >
        <span>body</span>
      </Card>
    );
    const html = await shown();
    expect(html).toContain("Deals");
    expect(html).toContain("Open pipeline");
    expect(html).toContain("New");
    expect(html).toContain("body");
  });

  test("bare children render without header", async () => {
    render(
      <Card>
        <span>only</span>
      </Card>
    );
    expect(await shown()).toContain("only");
  });
});

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 2, name: "b" },
  { id: 1, name: "a" },
];

describe("DataTable", () => {
  test("renders headers and cells, custom render wins", async () => {
    render(
      <DataTable
        columns={[
          { key: "id", header: "ID" },
          {
            key: "name",
            header: "Name",
            render: (r) => <strong>{r.name.toUpperCase()}</strong>,
          },
        ]}
        rows={ROWS}
        keyOf={(r) => r.id}
      />
    );
    const html = await shown();
    expect(html).toContain("ID");
    expect(html).toContain("<strong>B</strong>");
    expect(html).not.toContain("No rows.");
  });

  test("sortable header reports intent with direction marker", async () => {
    const seen: string[] = [];
    render(
      <DataTable
        columns={[{ key: "name", header: "Name", sortable: true }]}
        rows={ROWS}
        keyOf={(r) => r.id}
        sort={{ key: "name", dir: "asc" }}
        onSort={(k) => seen.push(k)}
      />
    );
    const html = await shown();
    expect(html).toContain("▲");
    const btn = el.querySelector("button");
    await act(async () => {
      btn?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    expect(seen).toEqual(["name"]);
  });

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

  test("loading, error with retry, and empty states", async () => {
    let retried = 0;
    render(
      <DataTable
        columns={[{ key: "id", header: "ID" }]}
        rows={[]}
        keyOf={(_, i) => i}
        loading
      />
    );
    expect(await shown()).toContain("Loading rows");
    render(
      <DataTable
        columns={[{ key: "id", header: "ID" }]}
        rows={[]}
        keyOf={(_, i) => i}
        error="boom"
        onRetry={() => retried++}
      />
    );
    expect(await shown()).toContain("boom");
    const btn = el.querySelector('[role="alert"] button');
    await act(async () => {
      btn?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    expect(retried).toBe(1);
    render(
      <DataTable
        columns={[{ key: "id", header: "ID" }]}
        rows={[]}
        keyOf={(_, i) => i}
        emptyText="Nothing here."
      />
    );
    expect(await shown()).toContain("Nothing here.");
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

describe("filters", () => {
  test("search reflects the controlled value; select reports changes", async () => {
    let s = "";
    render(
      <FilterBar>
        <SearchField
          value="acme"
          onChange={() => undefined}
          placeholder="Find…"
        />
        <SelectField
          label="Stage"
          value={s}
          options={[{ value: "a", label: "A" }]}
          onChange={(v) => (s = v)}
        />
      </FilterBar>
    );
    await act(async () => undefined);
    const input = el.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input.value).toBe("acme");
    expect(input.placeholder).toBe("Find…");
    const select = el.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "a";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    expect(s).toBe("a");
  });
});

describe("charts", () => {
  const data = [
    { label: "Jan", value: 10 },
    { label: "Feb", value: 20 },
  ];

  test("bar chart renders values with accessible names", async () => {
    render(<BarChart data={data} title="MRR" />);
    const html = await shown();
    expect(html).toContain("MRR");
    expect(html).toContain("Jan: 10");
    expect(el.querySelector("svg")).toBeTruthy();
  });

  test("line chart renders points", async () => {
    render(<LineChart data={data} title="Trend" />);
    expect(await shown()).toContain("Trend");
    expect(el.querySelector("polyline")).toBeTruthy();
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

  test("pie chart renders legend", async () => {
    render(<PieChart data={data} title="Mix" />);
    const html = await shown();
    expect(html).toContain("Mix");
    expect(html).toContain("Jan: 10");
  });

  test("sparkline renders without axes", async () => {
    render(<Sparkline values={[1, 3, 2]} label="spark" />);
    expect(el.querySelector("polyline")).toBeTruthy();
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

describe("query states and formatting", () => {
  test("loading, empty, error, truncated", async () => {
    render(
      <>
        <LoadingState text="Fetching…" />
        <EmptyState title="None yet" hint="Save one first." />
        <ErrorState message="bad" errorCode="UPSTREAM_TIMEOUT" />
        <TruncatedNotice shown={500} total={1200} />
      </>
    );
    const html = await shown();
    expect(html).toContain("Fetching");
    expect(html).toContain("None yet");
    expect(html).toContain("UPSTREAM_TIMEOUT");
    expect(html).toContain("Showing 500 of 1200 rows");
  });

  test("formatCompact", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatCompact(2_500_000)).toBe("2.5M");
  });
});
