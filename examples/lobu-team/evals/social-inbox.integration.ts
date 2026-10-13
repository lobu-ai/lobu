import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runScript } from "../../../packages/server/src/sandbox/run-script";

const source = readFileSync(
  new URL("../social-research.reaction.ts", import.meta.url),
  "utf8"
);

describe("social inbox reaction in the production isolate", () => {
  it("extracts the complete schema and delivers a source-verified private draft", async () => {
    const schema = await runScript({
      source,
      sdk: {} as any,
      context: {},
      extractExport: "input",
    });
    expect(schema.success, JSON.stringify(schema.error)).toBe(true);
    expect((schema.returnValue as any).required).toContain("inbox_findings");
    const url = "https://www.linkedin.com/messaging/thread/synthetic-thread/";
    const text = "Could you explain how the review flow works?";
    const sent: any[] = [];
    const staged: any[] = [];
    const sdk = {
      query: async () => [{ created_by: "synthetic-owner" }],
      operations: {
        getRun: async () => ({
          run: {
            status: "completed",
            automation_id: 42,
            created_at: "2026-01-01T10:00:00Z",
            completed_at: "2026-01-01T10:05:00Z",
          },
        }),
        listAvailable: async () => ({
          operations: ["read_home_feed", "prepare_message"].map(
            (operation_key) => ({
              operation_key,
              execution_targets: [
                {
                  connection_id: 11,
                  slug: "linkedin-research",
                  executable: true,
                },
                {
                  connection_id: 12,
                  slug: "linkedin-drafts",
                  executable: true,
                },
              ],
            })
          ),
        }),
        execute: async (input: any) => {
          staged.push(input);
          return { status: "in_progress", run_id: 90 };
        },
      },
      feeds: {
        list: async () => ({
          feeds: [{ id: 51, connection_id: 11, feed_key: "live_messages" }],
        }),
        readMany: async () => ({
          results: [
            {
              feed_id: 51,
              ok: true,
              rows: [
                {
                  id: "source-message",
                  text,
                  from_me: false,
                  conversation_url: url,
                },
              ],
            },
          ],
        }),
      },
      notifications: {
        send: async (input: any) => {
          sent.push(input);
          return { event_id: 91 };
        },
      },
    };
    sdk.query = async (sql?: string): Promise<any[]> =>
      sql?.includes("AS source_key")
        ? [{ source_key: createHash("sha256").update(sql).digest("hex") }]
        : sql?.includes("FROM events")
          ? []
          : [{ created_by: "synthetic-owner" }];
    const result = await runScript({
      source,
      sdk: sdk as any,
      context: {
        automation: { id: 42 },
        window: { run_id: 77 },
        extracted_data: {
          summary: "One incoming question",
          findings: [],
          coverage: ["linkedin", "x", "tiktok"].map((platform) => ({
            platform,
            status: "read",
            posts_read: 0,
            detail: "Quiet scan",
          })),
          inbox_findings: [
            {
              platform: "linkedin",
              feed_key: "live_messages",
              source_id: "source-message",
              quote: text,
              summary: "Review question",
              why: "A concrete question",
              limits: "Text only",
              draft: "You review the prepared draft before sending.",
            },
          ],
        },
      },
    });
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      operation_key: "prepare_message",
      activation: { kind: "page_visit", urls: [url] },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipients: ["synthetic-owner"],
      browser_handoff_run_id: 90,
    });
    expect(sent[0].idempotency_key).toMatch(/^social-inbox:[0-9a-f]{64}$/);
  });
});
