import { describe, expect, test } from "bun:test";
import { client } from "../generated/client.gen.js";
import { querySdk } from "../generated/sdk.gen.js";

describe("generated shared client default", () => {
  test("omitted baseUrl resolves against the absolute localhost default", async () => {
    const urls: string[] = [];
    const seenAuth: Array<string | null> = [];
    const previous = client.getConfig();
    client.setConfig({
      headers: { authorization: "Bearer test-token" },
      fetch: (async (request: Request) => {
        urls.push(request.url);
        seenAuth.push(request.headers.get("authorization"));
        return new Response(JSON.stringify({ rows: [], total_count: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    try {
      await querySdk({
        path: { orgSlug: "review-org" },
        body: { script: "export default async () => null;" },
      }).catch(() => null);
    } finally {
      client.setConfig(previous);
    }
    // Node has no origin to resolve a bare "/" against: the default must
    // stay an absolute localhost URL. This also pins the default against
    // accidental changes during client regeneration.
    expect(urls).toEqual(["http://localhost:8787/api/review-org/query_sdk"]);
    expect(seenAuth).toEqual(["Bearer test-token"]);
  });
});
