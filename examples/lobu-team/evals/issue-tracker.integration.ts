import type { ReactionClient } from "@lobu/connector-sdk";
import { beforeEach, expect, it } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import { seedOwnerContext } from "../../../packages/server/src/__tests__/setup/test-fixtures";
import type { Env } from "../../../packages/server/src/index";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { runIssueTracker } from "../issue-tracker.reaction";
import config from "../lobu.config";

beforeEach(cleanupTestDatabase);

const FINGERPRINT = "0123456789abcdef0123456789abcdef";

/** The ClickHouse read is the only stubbed edge: its SQL is ClickHouse's. */
function occurrenceRow(lastSeen: string, releases = ["rel-a"]) {
  return {
    fingerprint: FINGERPRINT,
    kind: "system",
    issue_title: "Error: Invalid encrypted format",
    issue_culprit: "log worker-auth",
    message: "Invalid encrypted format",
    first_seen_at: "2026-11-04T09:00:00.000Z",
    last_seen_at: lastSeen,
    seen_2h: "4",
    seen_24h: "4",
    seen_14d: "4",
    max_orgs: "1",
    max_users: "1",
    releases_2h: releases,
    last_release: releases.at(-1),
    sample_trace_id: "synthetic-trace",
  };
}

it("creates, refreshes and regresses one issue per fingerprint without touching triage", async () => {
  const { ctx, org } = await seedOwnerContext();
  const sdk = buildClientSDK(ctx, {} as Env);
  const issueType = config.entities?.find((type) => type.key === "issue");
  if (!issueType) throw new Error("issue type missing from lobu.config");
  await sdk.entitySchema.createType({
    slug: issueType.key,
    name: issueType.name ?? "Issue",
    metadata_schema: { type: "object", properties: issueType.properties },
  });

  let clickhouse = [occurrenceRow(new Date().toISOString())];
  const client = {
    ...sdk,
    query: (sql: string, options?: { connection?: string }) =>
      options?.connection === "lobu-analytics"
        ? Promise.resolve(clickhouse)
        : sdk.query(sql, options),
  } as unknown as ReactionClient;
  const run = (dryRun: boolean) =>
    runIssueTracker(
      {
        window: {
          run_id: 1,
          automation_id: 1,
          window_start: new Date().toISOString(),
          window_end: new Date().toISOString(),
        },
      } as Parameters<typeof runIssueTracker>[0],
      client,
      dryRun
    );
  const sql = getTestDb();
  const issues = () =>
    sql`SELECT e.id, e.slug, e.name, e.metadata FROM entities e
        JOIN entity_types t ON t.id = e.entity_type_id
        WHERE e.organization_id = ${org.id} AND t.slug = 'issue' AND e.deleted_at IS NULL`;

  // Dry run plans the create and writes nothing.
  expect(await run(true)).toMatchObject({ dry_run: true, created: 1 });
  expect(await issues()).toHaveLength(0);

  expect(await run(false)).toMatchObject({ created: 1, updated: 0 });
  const [created] = await issues();
  expect(created).toMatchObject({
    slug: `issue-${FINGERPRINT}`,
    name: "Error: Invalid encrypted format",
    metadata: {
      fingerprint: FINGERPRINT,
      status: "new",
      kind: "system",
      seen_24h: 4,
    },
  });

  // An agent triages and a person resolves it; the next run only refreshes.
  const resolvedAt = new Date(Date.now() - 60_000).toISOString();
  await sdk.entities.update({
    entity_id: created.id,
    metadata: {
      triage_summary: "Worker secret rotated",
      status: "resolved",
      resolved_at: resolvedAt,
    },
  });
  clickhouse = [occurrenceRow(new Date(Date.now() - 120_000).toISOString())];
  expect(await run(false)).toMatchObject({ created: 0, updated: 1, alerts: 0 });

  // Seen again after the resolution: regressed, triage kept, still one record.
  clickhouse = [occurrenceRow(new Date().toISOString(), ["rel-a", "rel-b"])];
  expect(await run(false)).toMatchObject({ created: 0, updated: 1, alerts: 1 });
  const after = await issues();
  expect(after).toHaveLength(1);
  expect(after[0].metadata).toMatchObject({
    status: "regressed",
    triage_summary: "Worker secret rotated",
    resolved_at: resolvedAt,
    last_release: "rel-b",
  });
});
