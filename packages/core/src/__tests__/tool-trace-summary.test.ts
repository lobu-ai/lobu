/**
 * The retrieval evidence a tool trace carries.
 *
 * This exists because the promptfoo provider builds `metadata.retrievedContext`
 * from `snippets` alone: a turn that retrieves and answers but ships no summary
 * leaves every RAG assertion with nothing to compare against, and the eval
 * passes or fails for the wrong reason.
 */

import { describe, expect, test } from "bun:test";
import { summarizeToolTrace } from "../tool-trace-summary";

/** How the gateway's MCP proxy actually returns a tool result. */
function mcpReply(body: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

describe("summarizeToolTrace", () => {
  test("extracts event ids and snippet text from a retrieval result", () => {
    const summary = summarizeToolTrace(
      "search_memory",
      mcpReply({
        content: [
          { id: 11, text_content: "the deploy is frozen until Friday" },
          { id: 12, text_content: "ask the platform team first" },
        ],
      })
    );

    expect(summary).toEqual({
      event_ids: [11, 12],
      snippets: [
        { id: 11, text: "the deploy is frozen until Friday" },
        { id: 12, text: "ask the platform team first" },
      ],
    });
  });

  test("reads the gateway-prefixed tool name too", () => {
    const summary = summarizeToolTrace(
      "lobu_search_memory",
      mcpReply({ content: [{ id: 3, text_content: "hello" }] })
    );
    expect(summary?.snippets).toEqual([{ id: 3, text: "hello" }]);
  });

  test("summarises nothing for a tool that does not retrieve", () => {
    // Shape alone must not qualify: a non-retrieval tool returning an
    // id-bearing array is not retrieval evidence.
    expect(
      summarizeToolTrace(
        "query_sdk",
        mcpReply({ content: [{ id: 1, text_content: "x" }] })
      )
    ).toBeNull();
  });

  test("returns null rather than throwing on a truncated body", () => {
    // The exact failure this module exists to avoid: a clipped JSON string.
    // Best-effort by contract — a trace is a view of the turn and must never
    // be able to fail it.
    const clipped = {
      content: [{ type: "text", text: '{"content":[{"id":1,"text_' }],
    };
    expect(summarizeToolTrace("search_memory", clipped)).toBeNull();
  });

  test("returns null on a plain-text result", () => {
    expect(
      summarizeToolTrace("search_memory", {
        content: [{ type: "text", text: "no matches" }],
      })
    ).toBeNull();
  });

  test("keeps ids that carry no text, since they are still evidence", () => {
    const summary = summarizeToolTrace(
      "search_memory",
      mcpReply({ content: [{ id: 7 }, { id: 8, text_content: "has text" }] })
    );
    expect(summary?.event_ids).toEqual([7, 8]);
    expect(summary?.snippets).toEqual([{ id: 8, text: "has text" }]);
  });

  test("bounds what one trace can carry", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      text_content: "x".repeat(5_000),
    }));
    const summary = summarizeToolTrace(
      "search_memory",
      mcpReply({ content: many })
    );
    expect(summary?.snippets).toHaveLength(16);
    for (const snippet of summary?.snippets ?? []) {
      expect(snippet.text.length).toBeLessThanOrEqual(2_000);
    }
  });

  test("returns null for an empty result set", () => {
    expect(
      summarizeToolTrace("search_memory", mcpReply({ content: [] }))
    ).toBeNull();
  });
});
