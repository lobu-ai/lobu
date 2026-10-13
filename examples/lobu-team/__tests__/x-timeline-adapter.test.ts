import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { expandXTimelineReader } from "../x-timeline-adapter";

const snapshot = "({timeline:['Following'],posts:readPage()})";
const binding =
  "const keys=['navigate','evaluate','close_tab']; let identity; if(identity?.profile!=='/synthetic') throw new Error('identity');";
const script = `${binding} const r=await execute({connection_id:11,expression:${JSON.stringify(snapshot)}}); const data=r.output.value; return {coverage:'First loaded page only; no scrolling'};`;
const post = (i: number) => ({
  text: `Post ${i}`,
  url: `https://x.com/synthetic/status/${1000 + i}`,
});
function run(
  pages: unknown[][],
  changed: boolean | "initial" = false,
  elapsedPerScroll = 500
) {
  const expanded = expandXTimelineReader(script);
  const expression = JSON.parse(
    expanded.match(/expression:("(?:[^"\\]|\\.)*")/)![1]
  );
  let page = 0;
  let time = 0;
  const doc = {
    querySelector: () => ({
      getAttribute: () =>
        changed === "initial" || (changed && page > 0)
          ? "/another"
          : "/synthetic",
    }),
  };
  return runInNewContext(expression, {
    document: doc,
    location: { origin: "https://x.com", pathname: "/home" },
    innerHeight: 1000,
    window: {
      scrollBy: () => {
        page++;
      },
    },
    readPage: () => pages[Math.min(page, pages.length - 1)],
    Date: { now: () => time },
    setTimeout: (fn: () => void) => {
      time += elapsedPerScroll;
      fn();
    },
  });
}

test("collects fifty distinct posts across virtualized pages in the receipt", async () => {
  const pages = Array.from({ length: 20 }, (_, i) =>
    Array.from({ length: 5 }, (_, j) => post(i * 4 + j))
  );
  const result = await run(pages);
  expect(result.posts).toHaveLength(50);
  expect(new Set(result.posts.map((p: any) => p.url)).size).toBe(50);
  expect(result.coverage).toContain("target");
  expect(result.posts[49].text).toBe("Post 49");
});

test("stalled pages return bounded partial coverage, never fabricated rows", async () => {
  const result = await run([[post(1), post(1), { text: "No permalink" }]]);
  expect(result.posts).toHaveLength(1);
  expect(result.coverage).toContain("stalled");
});

test("account changes fail closed during scrolling", async () => {
  await expect(run([[post(1)], [post(2)]], true)).rejects.toThrow("changed");
});

test("stops at the scroll budget even when every page adds a new post", async () => {
  const result = await run(Array.from({ length: 60 }, (_, i) => [post(i)]));
  expect(result.posts).toHaveLength(46);
  expect(result.coverage).toContain("scroll budget; 45 scrolls");
});

test("slow pages stop at the time budget with the collected evidence", async () => {
  const result = await run(
    Array.from({ length: 60 }, (_, i) => [post(i)]),
    false,
    8000
  );
  expect(result.posts).toHaveLength(4);
  expect(result.coverage).toContain("time budget; 3 scrolls");
});

test("preserves dollar replacement tokens in the existing DOM projection", () => {
  for (const token of ["$&", "$`", "$'", "$$"]) {
    const projection = `({timeline:['Following'],posts:[],label:${JSON.stringify(token)}})`;
    const original = `${binding} const r=await execute({connection_id:11,expression:${JSON.stringify(projection)}}); const data=r.output.value; return {coverage:'First loaded page only; no scrolling'};`;
    const expanded = expandXTimelineReader(original);
    const expression = JSON.parse(
      expanded.match(/expression:("(?:[^"\\]|\\.)*")/)![1]
    );
    expect(expression).toContain(`const read = () => ${projection};`);
  }
});

test("upgrading is idempotent and rejects an unfamiliar reader", () => {
  const upgraded = expandXTimelineReader(script);
  expect(expandXTimelineReader(upgraded)).toBe(upgraded);
  expect(() => expandXTimelineReader("return [];")).toThrow("shape changed");
});

test("rejects an account switch between the outer probe and first snapshot", async () => {
  await expect(run([[post(1)]], "initial")).rejects.toThrow("changed");
});
test("focuses the same configured scratch tab and requires focus policy", () => {
  const expanded = expandXTimelineReader(script);
  expect(expanded).toContain("'close_tab','focus_tab'");
  expect(expanded).toContain(
    "connection_id:11,operation_key:'focus_tab',input:{tab_id:tab,draw_attention:false}"
  );
});

test("requires a completed focus receipt before reading and always closes the scratch tab", async () => {
  const reader = `const keys=['navigate','evaluate','close_tab']; const tab=7;
    try {
      let identity; identity={profile:'/synthetic'};
      if(identity?.profile!=='/synthetic') throw new Error('identity');
      const r=await client.operations.execute({connection_id:11,operation_key:'evaluate',input:{tab_id:tab,expression:${JSON.stringify(snapshot)}}});
      const data=r.output.value;
      return {posts:data.posts,coverage:'First loaded page only; no scrolling'};
    } finally {
      await client.operations.execute({connection_id:11,operation_key:'close_tab',input:{tab_id:tab}});
    }`;
  for (const status of [
    "completed",
    "pending_approval",
    "failed",
    "running",
    "timeout",
  ]) {
    const calls: string[] = [];
    const result = runInNewContext(
      `(async () => {${expandXTimelineReader(reader)}})()`,
      {
        client: {
          operations: {
            execute: async ({ operation_key }: { operation_key: string }) => {
              calls.push(operation_key);
              return operation_key === "focus_tab"
                ? { status }
                : {
                    status: "completed",
                    output: {
                      value: { posts: [post(1)], coverage: "stalled" },
                    },
                  };
            },
          },
        },
      }
    );
    if (status === "completed") {
      await expect(result).resolves.toMatchObject({
        posts: [post(1)],
        coverage: "stalled",
      });
      expect(calls).toEqual(["focus_tab", "evaluate", "close_tab"]);
    } else {
      await expect(result).rejects.toThrow("focus");
      expect(calls).toEqual(["focus_tab", "close_tab"]);
    }
  }
});
