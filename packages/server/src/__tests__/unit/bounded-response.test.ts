import { describe, expect, test } from "bun:test";
import { readResponseBytesWithLimit, readResponseTextWithLimit } from "../../utils/bounded-response";

describe("bounded response ingestion", () => {
  test("preserves binary bytes and existing UTF-8 text decoding", async () => {
    const bytes = Buffer.from([0, 255, 128, 65]);
    expect(await readResponseBytesWithLimit(new Response(bytes), 4, "large")).toEqual(bytes);
    expect(await readResponseTextWithLimit(new Response("héllo"), 6, "large")).toBe("héllo");
  });

  test.each([undefined, "2", "100"])("rejects oversized bodies with content-length %s", async (length) => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body, { headers: length ? { "content-length": length } : {} });
    await expect(readResponseBytesWithLimit(response, 4, "large")).rejects.toThrow("large (max 4 bytes).");
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test("releases the stream lock when reading fails", async () => {
    const response = new Response(new ReadableStream({
      pull(controller) { controller.error(new Error("transport failed")); },
    }));
    await expect(readResponseBytesWithLimit(response, 4, "large")).rejects.toThrow("transport failed");
    expect(response.body?.locked).toBe(false);
  });
});
