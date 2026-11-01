import { describe, expect, it } from "bun:test";
import type { ActionContext } from "@lobu/connector-sdk";
import DataForSeoConnector, {
  type RankTrackingCheckpoint,
  rankEventId,
} from "../dataforseo.connector.ts";
import { runSync } from "./sync-harness";

const credentials = {
  DATAFORSEO_LOGIN: "synthetic-login",
  DATAFORSEO_PASSWORD: "synthetic-password",
};

/**
 * Fake DataForSEO Standard API: every posted keyword becomes a task, and a
 * task is reported ready only once the test marks its keyword ready.
 */
function fakeStandardApi() {
  const posts: string[][] = [];
  const ready = new Set<string>();
  const outage = { tasksReady: false };
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/serp/google/organic/task_post")) {
      const tasks = JSON.parse(String(init?.body)) as Array<{
        keyword: string;
      }>;
      posts.push(tasks.map((task) => task.keyword));
      return Response.json({
        status_code: 20000,
        tasks: tasks.map((task) => ({
          id: `task-${task.keyword}`,
          status_code: 20100,
        })),
      });
    }
    if (url.endsWith("/serp/google/organic/tasks_ready")) {
      if (outage.tasksReady) return new Response("upstream", { status: 503 });
      return Response.json({
        status_code: 20000,
        tasks: [
          { result: [...ready].map((keyword) => ({ id: `task-${keyword}` })) },
        ],
      });
    }
    const got = url.match(/\/task_get\/advanced\/task-(.+)$/);
    if (got) {
      return Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            cost: 0.0006,
            result: [
              {
                items: [
                  { type: "paid", url: "https://ads.example.test" },
                  {
                    type: "organic",
                    rank_group: 2,
                    rank_absolute: 3,
                    domain: "www.example.test",
                    url: `https://www.example.test/${got[1]}`,
                  },
                  {
                    type: "organic",
                    rank_group: 1,
                    rank_absolute: 1,
                    domain: "other.test",
                    url: "https://other.test/",
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { posts, ready, outage, fetchImpl };
}

function rankConnector(fetchImpl: DataForSeoConnector["fetchImpl"]) {
  const connector = new DataForSeoConnector();
  connector.fetchImpl = fetchImpl;
  connector.pollIntervalMs = 0;
  connector.maxPolls = 1;
  return connector;
}

describe("DataForSEO rank_tracking feed", () => {
  it("never re-posts a keyword a previous run already recorded today", async () => {
    const api = fakeStandardApi();
    const connector = rankConnector(api.fetchImpl);
    const config = {
      ...credentials,
      keywords: ["alpha", "beta"],
      target_domain: "example.test",
    };

    api.ready.add("alpha");
    const first = await runSync(connector, {
      feedKey: "rank_tracking",
      config,
      checkpoint: null,
    });
    expect(first.status).toBe("more");
    expect(first.events.map((event) => event.metadata?.keyword)).toEqual([
      "alpha",
    ]);

    api.ready.add("beta");
    const second = await runSync(connector, {
      feedKey: "rank_tracking",
      config,
      checkpoint: first.checkpoint,
    });
    expect(second.status).toBe("complete");
    expect(second.events.map((event) => event.metadata?.keyword)).toEqual([
      "beta",
    ]);
    // Every task_post is billed: each keyword is posted exactly once per day.
    expect(api.posts).toEqual([["alpha", "beta"]]);
    expect(
      (second.checkpoint as RankTrackingCheckpoint).completed?.keywords.sort()
    ).toEqual(["alpha", "beta"]);
  });

  it("keeps paid task ids when the poll after task_post fails", async () => {
    const api = fakeStandardApi();
    const connector = rankConnector(api.fetchImpl);
    const config = { ...credentials, keywords: ["alpha"] };

    api.outage.tasksReady = true;
    const committed: { checkpoint: RankTrackingCheckpoint | null } = {
      checkpoint: null,
    };
    await expect(
      runSync(connector, {
        feedKey: "rank_tracking",
        config,
        checkpoint: null,
        commit: async (_events, next) => {
          committed.checkpoint = next as RankTrackingCheckpoint;
        },
      })
    ).rejects.toThrow("HTTP 503");
    expect(committed.checkpoint?.pending).toEqual([
      { keyword: "alpha", task_id: "task-alpha" },
    ]);

    api.outage.tasksReady = false;
    api.ready.add("alpha");
    const retry = await runSync(connector, {
      feedKey: "rank_tracking",
      config,
      checkpoint: committed.checkpoint,
    });
    expect(retry.status).toBe("complete");
    expect(retry.events.map((event) => event.metadata?.keyword)).toEqual([
      "alpha",
    ]);
    expect(api.posts).toEqual([["alpha"]]);
  });

  it("records the target's organic rank under a stable per-day origin_id", async () => {
    const api = fakeStandardApi();
    api.ready.add("Alpha Beta");
    const run = await runSync(rankConnector(api.fetchImpl), {
      feedKey: "rank_tracking",
      config: {
        ...credentials,
        keywords: ["Alpha Beta"],
        target_domain: "example.test",
      },
      checkpoint: null,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({
      origin_id: rankEventId("Alpha Beta", today),
      origin_type: "rank_check",
      metadata: { rank_absolute: 3, organic_total: 2 },
    });
  });
});

describe("DataForSEO actions", () => {
  it("separates rejected credentials (401) from an intermediary refusal (403)", async () => {
    const connector = new DataForSeoConnector();
    const run = async (status: number) => {
      connector.fetchImpl = async () =>
        new Response("blocked by synthetic proxy", { status });
      return connector.execute({
        actionKey: "account_balance",
        input: {},
        config: credentials,
      } as unknown as ActionContext);
    };
    const unauthorized = await run(401);
    const refused = await run(403);
    expect(unauthorized.success).toBe(false);
    expect(unauthorized.error).toContain("DATAFORSEO_PASSWORD");
    expect(refused.success).toBe(false);
    expect(refused.error).not.toContain("DATAFORSEO_PASSWORD");
    expect(refused.error).toContain("blocked by synthetic proxy");
  });
});
