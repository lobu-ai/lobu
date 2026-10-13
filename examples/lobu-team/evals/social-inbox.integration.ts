import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runScript } from "../../../packages/server/src/sandbox/run-script";
import { createConnectorOperationRun } from "../../../packages/server/src/runs/queue-service";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";

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
        listRuns: async () => ({ runs: [] }),
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
                  recalled: false,
                  source_revision: "a".repeat(64),
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
              source_revision: "a".repeat(64),
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

  it("recovers the original queued draft across windows under the real queue provenance guard", async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const { org, user } = await seedOwnerContext({
      orgName: "Synthetic inbox recovery",
    });
    const connector = "synthetic.inbox.recovery";
    await createTestConnectorDefinition({
      key: connector,
      name: "Synthetic draft",
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: connector,
      created_by: user.id,
      visibility: "private",
      createDefaultFeed: false,
    });
    const [automation] =
      await sql`WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
      INSERT INTO automations (id, automation_group_id, organization_id, created_by, name, slug, triggers)
      SELECT id, id, ${org.id}, ${user.id}, 'Synthetic inbox', 'synthetic-inbox', '[]'::jsonb FROM next_id RETURNING id`;
    const url = "https://www.linkedin.com/messaging/thread/synthetic-recovery/";
    const row = {
      id: "synthetic-message",
      text: "Please explain the review flow",
      from_me: false,
      recalled: false,
      source_revision: "a".repeat(64),
      conversation_url: url,
    };
    const extracted = (draft: string) => ({
      findings: [],
      coverage: ["linkedin", "x", "tiktok"].map((platform) => ({
        platform,
        status: "read",
        posts_read: 0,
        detail: "Quiet",
      })),
      inbox_findings: [
        {
          platform: "linkedin",
          feed_key: "live_messages",
          source_id: row.id,
          source_revision: row.source_revision,
          quote: row.text,
          summary: "Review question",
          why: "Relevant",
          limits: "Text only",
          draft,
        },
      ],
    });
    let enqueueCalls = 0;
    let failNotification = true;
    const notifications: any[] = [];
    const readRun = async (id: number) => ({
      run: (
        await sql`SELECT id, status, automation_id, parent_run_id, connection_id, action_key AS operation_key, action_input AS input, action_output AS output, created_by_user_id, created_at, completed_at FROM runs WHERE id = ${id}`
      )[0],
    });
    const makeWindow = async (data: ReturnType<typeof extracted>) => {
      const [window] =
        await sql`INSERT INTO runs (organization_id, run_type, automation_id, status, approval_status, action_output, created_at, completed_at)
        VALUES (${org.id}, 'automation', ${automation.id}, 'completed', 'auto', ${sql.json(data)}, NOW() - interval '1 minute', NOW()) RETURNING id`;
      return Number(window.id);
    };
    const sdkFor = (parentRunId: number) => ({
      query: (statement: string) => sql.unsafe(statement),
      operations: {
        getRun: readRun,
        listRuns: async () => ({
          runs: await sql`SELECT id, status, approval_status, automation_id, parent_run_id, connection_id, action_key AS operation_key, action_input AS input, created_by_user_id FROM runs WHERE organization_id = ${org.id} AND run_type = 'action' ORDER BY id DESC LIMIT 50`,
        }),
        listAvailable: async () => ({
          operations: ["read_home_feed", "prepare_message"].map(
            (operation_key) => ({
              operation_key,
              execution_targets: [
                {
                  connection_id: connection.id,
                  slug: "linkedin-research",
                  executable: true,
                },
                {
                  connection_id: connection.id,
                  slug: "linkedin-drafts",
                  executable: true,
                },
              ],
            })
          ),
        }),
        execute: async (args: any) => {
          enqueueCalls++;
          const queued = await createConnectorOperationRun({
            organizationId: org.id,
            connectionId: connection.id,
            connectorKey: connector,
            operationKey: args.operation_key,
            operationInput: args.input,
            idempotencyKey: args.idempotency_key,
            approvalMode: "inline",
            activation: { ...args.activation, expiresInSeconds: 3600 },
            policyPrincipalKind: "automation",
            policyPrincipalId: String(automation.id),
            createdByUserId: user.id,
            automationId: Number(automation.id),
            parentRunId,
          });
          return { status: "in_progress", run_id: queued.runId };
        },
      },
      feeds: {
        list: async () => ({
          feeds: [
            { id: 51, connection_id: connection.id, feed_key: "live_messages" },
          ],
        }),
        readMany: async () => ({
          results: [{ feed_id: 51, ok: true, rows: [row] }],
        }),
      },
      notifications: {
        send: async (input: any) => {
          if (failNotification) {
            failNotification = false;
            throw new Error("Synthetic notification failure");
          }
          notifications.push(input);
          return { event_id: 91 };
        },
      },
    });
    const executeWindow = (runId: number, data: ReturnType<typeof extracted>) =>
      runScript({
        source,
        sdk: sdkFor(runId) as any,
        context: {
          automation: { id: Number(automation.id) },
          window: { run_id: runId },
          extracted_data: data,
        },
      });
    try {
      const first = extracted(
        "You review every prepared reply before sending."
      );
      const firstId = await makeWindow(first);
      expect((await executeWindow(firstId, first)).success).toBe(false);
      const second = extracted(
        "A regenerated answer must not replace the original."
      );
      const secondId = await makeWindow(second);
      const retry = await executeWindow(secondId, second);
      expect(retry.success, JSON.stringify(retry.error)).toBe(true);
      expect(enqueueCalls).toBe(1);
      expect(notifications[0].body).toContain(first.inbox_findings[0].draft);
      expect(notifications[0].body).not.toContain(
        second.inbox_findings[0].draft
      );
      const [queued] =
        await sql`SELECT id, parent_run_id, activation_kind, action_input FROM runs WHERE organization_id = ${org.id} AND run_type = 'action'`;
      expect(queued).toMatchObject({
        parent_run_id: firstId,
        activation_kind: "page_visit",
        action_input: { body: first.inbox_findings[0].draft },
      });
      expect(notifications[0].browser_handoff_run_id).toBe(Number(queued.id));

      row.id = "synthetic-concurrent-message";
      const identical = extracted("One reviewable answer.");
      const [a, b] = await Promise.all([
        makeWindow(identical),
        makeWindow(identical),
      ]);
      const concurrent = await Promise.all([
        executeWindow(a, identical),
        executeWindow(b, identical),
      ]);
      expect(concurrent.map((result) => result.success)).toEqual([true, true]);
      expect(
        Number(
          (
            await sql`SELECT count(*) AS n FROM runs WHERE organization_id = ${org.id} AND run_type = 'action'`
          )[0].n
        )
      ).toBe(2);
    } finally {
      await cleanupTestDatabase();
    }
  });
});
