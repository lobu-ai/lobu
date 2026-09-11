import { describe, expect, it, spyOn } from "bun:test";
import LokiActivityConnector, {
  queryLokiActivity,
  windowsToCollect,
} from "../loki-activity.connector.ts";

describe("Lobu Team Loki activity connector", () => {
  it("persists a successful empty window as coverage evidence", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        status: "success",
        data: { resultType: "vector", result: [] },
      })
    );
    try {
      const result = await new LokiActivityConnector().sync({
        feedKey: "activity",
        checkpoint: null,
        config: {
          LOKI_URL: "https://loki.example.test",
          namespace: "synthetic",
        },
      } as never);
      expect(result.events).toHaveLength(1);
      const event = result.events[0]!;
      expect(event.metadata).toMatchObject({
        errors: 0,
        warnings: 0,
      });
      expect(result.checkpoint).toEqual({
        window_end: event.origin_id,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("retains an old checkpoint and drains backlog in bounded oldest-first batches", () => {
    const checkpoint = { window_end: "2026-08-10T12:00:00.000Z" };
    const now = new Date("2026-08-13T12:23:00.000Z");
    const first = windowsToCollect(checkpoint, now);
    expect(first).toHaveLength(72);
    expect(first[0]?.start.toISOString()).toBe(checkpoint.window_end);
    expect(first.at(-1)?.end.toISOString()).toBe("2026-08-11T12:00:00.000Z");
    const firstBatchEnd = first.at(-1)!.end.toISOString();
    const second = windowsToCollect({ window_end: firstBatchEnd }, now);
    expect(second[0]?.start.toISOString()).toBe(firstBatchEnd);
    expect(second).toHaveLength(72);
  });
  it("collects aligned 20-minute windows and resumes from its checkpoint", () => {
    const windows = windowsToCollect(
      { window_end: "2026-08-13T11:40:00.000Z" },
      new Date("2026-08-13T12:23:00.000Z")
    );

    expect(windows).toEqual([
      {
        start: new Date("2026-08-13T11:40:00.000Z"),
        end: new Date("2026-08-13T12:00:00.000Z"),
      },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
    ]);
  });

  it("returns counts and useful error/warning samples", async () => {
    const urls: URL[] = [];
    const responses = [
      {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            { metric: { level: "error" }, value: [0, "2"] },
            { metric: { level: "warning" }, value: [0, "1"] },
          ],
        },
      },
      {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { pod: "lobu-server-1", level: "error" },
              values: [["1", '{"level":"error","message":"DB pool failed"}']],
            },
            {
              stream: { pod: "lobu-worker-1", level: "warn" },
              values: [["2", '{"level":"warn","msg":"retrying run"}']],
            },
          ],
        },
      },
    ];
    const fetchImpl = async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return Response.json(responses.shift());
    };

    const result = await queryLokiActivity(
      {
        LOKI_URL: "https://loki.example.test",
        namespace: "lobu",
      },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
      fetchImpl
    );

    expect(result).toEqual({
      errors: 2,
      warnings: 1,
      error_samples: ["[lobu-server-1] DB pool failed"],
      warning_samples: ["[lobu-worker-1] retrying run"],
    });
    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get("start")).toBe("1786622400000000000");
    expect(urls[1]?.searchParams.get("end")).toBe("1786623600000000000");
  });

  it("does not request samples when the window has no log activity", async () => {
    let calls = 0;
    const result = await queryLokiActivity(
      { LOKI_URL: "https://loki.example.test", namespace: "lobu" },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
      async () => {
        calls += 1;
        return Response.json({
          status: "success",
          data: { resultType: "vector", result: [] },
        });
      }
    );

    expect(result).toEqual({
      errors: 0,
      warnings: 0,
      error_samples: [],
      warning_samples: [],
    });
    expect(calls).toBe(1);
  });
});
