import { describe, expect, test } from "bun:test";
import Cloudflare from "../cloudflare-access.connector.ts";
import Posthog from "../posthog-events.connector.ts";

const query = JSON.stringify({
  start: "2026-01-01T00:00:00Z",
  end: "2026-01-02T00:00:00Z",
});
function context(config: Record<string, string>, extra = {}) {
  return {
    feedKey: "events",
    config,
    credentials: null,
    query,
    limit: 1,
    ...extra,
  } as any;
}

describe("website source readers", () => {
  test("PostHog pages equal timestamps by source UUID and preserves raw event data", async () => {
    const requests: any[] = [];
    const connector = new Posthog(async (_, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        results: [
          ["id-1", "2026-01-01T01:00:00.000001Z", "$pageview", { path: "/" }],
          ["id-2", "2026-01-01T01:00:00.000001Z", "$pageleave", {}],
        ],
      });
    });
    const ctx = context({
      api_host: "https://us.posthog.com",
      project_id: "123",
      POSTHOG_API_KEY: "placeholder",
    });
    const read = connector.definition.feeds!.events.read!;
    const first = await read(ctx);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].properties).toEqual({ path: "/" });
    expect(first.hasMore).toBe(true);
    await read({ ...ctx, cursor: first.nextCursor });
    expect(requests[1].query.query).toContain("uuid > 'id-1'");
    expect(requests[1].query.query).toContain("2026-01-01T01:00:00.000001Z");
    await expect(
      read({
        ...ctx,
        query: JSON.stringify({ start: "2026-01-02", end: "2026-01-03" }),
        cursor: first.nextCursor,
      })
    ).rejects.toThrow("cursor");
  });

  test("Cloudflare uses retained HTTP logs and never substitutes sampled analytics", async () => {
    let request: any;
    const connector = new Cloudflare(async (url, init) => {
      request = { url: String(url), init };
      return Response.json({
        success: true,
        result: [
          {
            rayid: "ray-1",
            edgestarttimestamp: "2026-01-01T01:00:00Z",
            clientrequesturi: "/?q=raw",
          },
        ],
      });
    });
    const result = await connector.definition.feeds!.requests.read!(
      context({
        zone_id: "a".repeat(32),
        hostname: "example.test",
        CLOUDFLARE_API_TOKEN: "placeholder",
      })
    );
    expect(request.url).toContain(
      `/zones/${"a".repeat(32)}/logs/explorer/query/sql`
    );
    expect(request.init.body).toContain("FROM http_requests");
    expect(request.init.body).toContain("clientrequesthost = 'example.test'");
    expect(result.rows[0].clientrequesturi).toBe("/?q=raw");
    expect(result.hasMore).toBe(false);
  });

  test("Cloudflare treats a null result as an empty page", async () => {
    const connector = new Cloudflare(async () =>
      Response.json({ success: true, result: null })
    );
    const result = await connector.definition.feeds!.requests.read!(
      context({
        zone_id: "a".repeat(32),
        hostname: "example.test",
        CLOUDFLARE_API_TOKEN: "placeholder",
      })
    );
    expect(result).toEqual({ rows: [], rowCursors: [], hasMore: false });
  });

  test("rejects unbounded or invalid reads before network access", async () => {
    let calls = 0;
    const connector = new Posthog(async () => {
      calls++;
      throw new Error("network");
    });
    const read = connector.definition.feeds!.events.read!;
    const ctx = context({
      api_host: "https://us.posthog.com",
      project_id: "123",
    });
    await expect(read({ ...ctx, query: undefined })).rejects.toThrow();
    await expect(read({ ...ctx, limit: 201 })).rejects.toThrow();
    await expect(read({ ...ctx, window: {} })).rejects.toThrow();
    await expect(
      read({
        ...ctx,
        config: { ...ctx.config, api_host: "https://attacker.test" },
      })
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("reports upstream errors without emitting source bodies or credentials", async () => {
    const connector = new Cloudflare(
      async () => new Response("secret", { status: 403 })
    );
    await expect(
      connector.definition.feeds!.requests.read!(
        context({ zone_id: "a".repeat(32), hostname: "example.test" })
      )
    ).rejects.toThrow("403");
  });
});
