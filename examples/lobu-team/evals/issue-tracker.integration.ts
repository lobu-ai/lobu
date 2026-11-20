import type { ReactionClient } from "@lobu/connector-sdk";
import { beforeEach, expect, it } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import type { Env } from "../../../packages/server/src/index";
import { buildClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import trackIssues, {
  healthSnapshotSql,
  RULES,
  readHealthSnapshot,
  runIssueTracker,
} from "../issue-tracker.reaction";
import config from "../lobu.config";
import { configureIssueRepair } from "../scripts/configure-issue-repair";

beforeEach(cleanupTestDatabase);

const FINGERPRINT = "0123456789abcdef0123456789abcdef";

/** The ClickHouse read is the only stubbed edge: its SQL is ClickHouse's. */
function occurrenceRow(
  lastSeen: string,
  releases = ["rel-a"],
  fingerprint = FINGERPRINT
) {
  return {
    fingerprint,
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
    // Pageable reach: the regression below must clear the alert threshold.
    max_users: String(RULES.highMinUsers),
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
  let failNextAlert = false;
  const client = {
    ...sdk,
    notifications: {
      ...sdk.notifications,
      send: (input: Parameters<typeof sdk.notifications.send>[0]) => {
        if (!failNextAlert) return sdk.notifications.send(input);
        failNextAlert = false;
        return Promise.reject(new Error("delivery unavailable"));
      },
    },
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

  // Seen again after the resolution. A failed alert leaves the status alone,
  // so the retry still alerts; then: regressed, triage kept, one record.
  clickhouse = [occurrenceRow(new Date().toISOString(), ["rel-a", "rel-b"])];
  failNextAlert = true;
  await expect(run(false)).rejects.toThrow(/delivery unavailable/);
  expect((await issues())[0].metadata.status).toBe("resolved");
  expect(await run(false)).toMatchObject({ created: 0, updated: 1, alerts: 1 });
  // Delivered once: the rejected send stored nothing, the retry one alert.
  const delivered = await sql`SELECT id FROM events
      WHERE organization_id = ${org.id}
        AND metadata->>'_lobu_idempotency_key' = ${`issue:${FINGERPRINT}:regressed:${resolvedAt}`}`;
  expect(delivered).toHaveLength(1);
  const after = await issues();
  expect(after).toHaveLength(1);
  expect(after[0].metadata).toMatchObject({
    status: "regressed",
    triage_summary: "Worker secret rotated",
    resolved_at: resolvedAt,
    last_release: "rel-b",
  });

  // Moved back to resolved on the board: only status changes. The run stamps
  // the resolution instead of re-alerting off the stale resolved_at.
  await sdk.entities.update({
    entity_id: created.id,
    metadata: { status: "resolved" },
  });
  expect(await run(false)).toMatchObject({ created: 0, updated: 1, alerts: 0 });
  const [reResolved] = await issues();
  expect(reResolved.metadata.status).toBe("resolved");
  expect(Date.parse(reResolved.metadata.resolved_at as string)).toBeGreaterThan(
    Date.parse(reResolved.metadata.regressed_at as string)
  );

  // A deleted issue keeps its slug: the fingerprint stays suppressed instead
  // of failing every run on a duplicate create.
  await sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${created.id}`;
  clickhouse = [occurrenceRow(new Date().toISOString(), ["rel-b"])];
  expect(await run(false)).toMatchObject({
    issues: 0,
    created: 0,
    updated: 0,
  });

  // One failed write must not hold back the rest of the run. Another record
  // already holds the second fingerprint's slug, so only its create fails.
  const blocked = "1".repeat(32);
  const fresh = "2".repeat(32);
  await sdk.entitySchema.createType({
    slug: "note",
    name: "Note",
    metadata_schema: { type: "object", properties: {} },
  });
  await sdk.entities.create({
    entity_type: "note",
    name: "Squatter",
    slug: `issue-${blocked}`,
  });
  clickhouse = [
    occurrenceRow(new Date().toISOString(), ["rel-b"], blocked),
    occurrenceRow(new Date().toISOString(), ["rel-b"], fresh),
  ];
  await expect(run(false)).rejects.toThrow(
    /^1 of 2 issue changes failed: create 1{32}/
  );
  expect((await issues()).map((row) => row.slug)).toEqual([`issue-${fresh}`]);
});

it("files silent overdue work in owned scope and requires successful recovery", async () => {
  const { ctx, org, user } = await seedOwnerContext();
  const sdk = buildClientSDK(ctx, {} as Env);
  const sql = getTestDb();
  const issueType = config.entities!.find((type) => type.key === "issue")!;
  await sdk.entitySchema.createType({
    slug: "issue",
    name: "Issue",
    metadata_schema: { type: "object", properties: issueType.properties },
  });
  const created = await sdk.automations.create({
    slug: "silent-external",
    name: "Silent external work",
    prompt: "Process due work",
    triggers: [
      {
        kind: "schedule",
        cron: "0 * * * *",
        timezone: "UTC",
        skip_if_unchanged: false,
      },
    ],
  });
  if (!("automation_id" in created)) throw new Error("Unexpected approval");
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '2 hours' WHERE id = ${Number(created.automation_id)}`;
  const client = {
    ...sdk,
    query: async (text: string, options?: { connection?: string }) =>
      options?.connection === "lobu-analytics"
        ? []
        : options?.connection === "health-source"
          ? sql.unsafe(text)
          : sdk.query(text, options),
  } as unknown as ReactionClient;
  const context = {
    organization_id: org.id,
    window: { automation_id: Number(created.automation_id), run_id: 1 },
  } as Parameters<typeof trackIssues>[0];
  const health = { workspaces: [org.slug], connection: "health-source" };
  const run = (dryRun = false) =>
    dryRun
      ? runIssueTracker(context, client, true, {
          ...health,
          ownerUserId: user.id,
        })
      : trackIssues(context, client, { health });
  const issues = () => sdk.entities.list({ entity_type: "issue" });
  await run(true);
  expect((await issues()).entities).toHaveLength(0);
  await run();
  let items = (await issues()).entities;
  expect(items).toHaveLength(1);
  expect(items[0].metadata).toMatchObject({ status: "new", kind: "system" });
  expect(items[0].name).toContain("Silent external work");
  await run();
  expect((await issues()).entities).toHaveLength(1);
  // Merely moving the due time is not evidence that the work ran.
  await sql`UPDATE automations SET next_run_at = NOW() + INTERVAL '1 hour' WHERE id = ${Number(created.automation_id)}`;
  await run();
  expect((await issues()).entities[0]!.metadata!.status).not.toBe("resolved");
  await sql`UPDATE automations SET last_run_completed_at = NOW() WHERE id = ${Number(created.automation_id)}`;
  await run();
  expect((await issues()).entities[0]!.metadata!.status).toBe("resolved");
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '2 hours' WHERE id = ${Number(created.automation_id)}`;
  await run();
  items = (await issues()).entities;
  expect(items).toHaveLength(1);
  expect(items[0]!.metadata!.status).toBe("regressed");
  // Retry claims can change last_sync_status to pending; the failure streak
  // must keep the issue visible until an actual successful sync.
  const [connection] =
    await sql`INSERT INTO connections (organization_id,connector_key,slug,display_name,status,created_by,visibility)
    VALUES (${org.id},'synthetic.source','synthetic-source','Synthetic source','active',${user.id},'org') RETURNING id`;
  const [feed] =
    await sql`INSERT INTO feeds (organization_id,connection_id,feed_key,status,consecutive_failures,last_sync_status)
    VALUES (${org.id},${connection.id},'items','active',3,'pending') RETURNING id`;
  await run();
  items = (await issues()).entities;
  expect(items).toHaveLength(2);
  const feedIssue = items.find((i) =>
    String(i.metadata?.culprit).endsWith(`:feed:${feed.id}`)
  )!;
  await sdk.entities.update({
    entity_id: Number(feedIssue.id),
    metadata: { triage_summary: "Keep this investigation" },
  });
  await sql`UPDATE feeds SET consecutive_failures=0,last_sync_status='success',last_sync_at=NOW() WHERE id=${feed.id}`;
  await run();
  const recovered = (await issues()).entities.find(
    (i) => i.id === feedIssue.id
  )!;
  expect(recovered.metadata).toMatchObject({
    status: "resolved",
    triage_summary: "Keep this investigation",
  });
  // Auth propagation pauses feeds before they necessarily fail. A healthy
  // connection with a manually paused feed stays quiet, but unavailable
  // connections must still reach the repair queue with zero failures.
  await sql`UPDATE feeds SET status='paused',next_run_at=NULL WHERE id=${feed.id}`;
  await run();
  expect((await issues()).entities).toHaveLength(2);
  for (const status of ["pending_auth", "revoked", "error"]) {
    await sql`UPDATE connections SET status=${status} WHERE id=${connection.id}`;
    await run();
    items = (await issues()).entities;
    expect(items).toHaveLength(3);
    const connectionIssue = items.find((i) =>
      String(i.metadata?.culprit).endsWith(`:connection:${connection.id}`)
    )!;
    expect(connectionIssue.metadata).toMatchObject({ status: "new" });
    expect(JSON.parse(String(connectionIssue.metadata?.message))).toMatchObject(
      {
        problem: "connection_unavailable",
        status,
      }
    );
  }
  // Losing ownership must fail closed: the now-invisible outage must stay
  // open, but the health failure must not abort occurrence ingestion.
  await sql`UPDATE member SET role = 'member' WHERE "organizationId" = ${org.id} AND "userId" = ${user.id}`;
  const demoted = (await run()) as { health_error: string | null };
  expect(demoted.health_error).toMatch(/ownership|scope/i);
  items = (await issues()).entities;
  expect(items).toHaveLength(3);
  const stranded = items.find((i) =>
    String(i.metadata?.culprit).endsWith(`:connection:${connection.id}`)
  )!;
  expect(stranded.metadata?.status).toBe("new");
});

it("keeps foreign work out and exposes the issue repair queue to external claims", async () => {
  const { ctx, org, user } = await seedOwnerContext();
  const sql = getTestDb();
  const sdk = buildClientSDK(ctx, {
    JWT_SECRET: "synthetic-issue-repair-test-signing-key",
  } as Env);
  const foreignOwner = await seedOwnerContext({ orgName: "Synthetic foreign" });
  const foreign = foreignOwner.org;
  const agent = await createTestAgent({
    organizationId: org.id,
    ownerUserId: user.id,
  });
  const tracker = await sdk.automations.create({
    slug: "issue-tracker",
    name: "Issue tracker",
    managed_agent_id: agent.agentId,
    reaction_script: "export default async () => ({});",
  });
  if (!("automation_id" in tracker)) throw new Error("Unexpected approval");
  const scope = {
    ownerUserId: user.id,
    workspaces: [org.slug],
    connection: "health-source",
  };
  const foreignSdk = buildClientSDK(foreignOwner.ctx, {} as Env);
  await foreignSdk.automations.create({
    slug: "foreign-work",
    name: "Foreign work",
    prompt: "Synthetic work",
  });
  const [privateConnection] =
    await sql`INSERT INTO connections (organization_id,connector_key,slug,display_name,status,created_by,visibility)
    VALUES (${org.id},'synthetic.source','private-source','Private source','active',${foreignOwner.user.id},'private') RETURNING id`;
  await sql`INSERT INTO feeds (organization_id,connection_id,feed_key,status,consecutive_failures)
    VALUES (${org.id},${privateConnection.id},'private-items','active',3)`;
  const rows = await sql.unsafe(healthSnapshotSql(scope));
  expect(rows.every((r) => r.workspace === org.slug)).toBe(true);
  expect(rows.some((r) => r.kind === "feed" || r.kind === "connection")).toBe(
    false
  );
  await expect(
    readHealthSnapshot(
      {
        query: (text: string) => sql.unsafe(text),
      } as unknown as ReactionClient,
      { ...scope, workspaces: [org.slug, foreign.slug] }
    )
  ).rejects.toThrow(/ownership|scope/);
  const issueType = config.entities!.find((t) => t.key === "issue")!;
  await sdk.entitySchema.createType({
    slug: "issue",
    name: "Issue",
    metadata_schema: { type: "object", properties: issueType.properties },
  });
  const issue = await sdk.entities.create({
    entity_type: "issue",
    name: "Synthetic broken feed",
    metadata: { fingerprint: "a".repeat(32), status: "new", kind: "system" },
  });
  const configured = await configureIssueRepair(
    sdk,
    String(tracker.automation_id),
    1,
    {
      reaction: "export default async () => ({});",
      prompt:
        "Inspect the issue, record evidence, then complete with extracted_data: {}.",
    }
  );
  if (!("automation_id" in configured.repair))
    throw new Error("Unexpected approval");
  const id = String(configured.repair.automation_id);
  const repeated = await configureIssueRepair(
    sdk,
    String(tracker.automation_id),
    1,
    {
      reaction: "export default async () => ({});",
      prompt:
        "Inspect the issue, record evidence, then complete with extracted_data: {}.",
    }
  );
  expect(repeated.repair.automation_id).toBe(id);
  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = ${Number(id)}`;
  const claim = await sdk.automations.claimNextWindow({ automation_id: id });
  expect(claim).toHaveProperty("context.window_token");
  const context = (claim as any).context;
  expect(
    context.sources.issues.some(
      (r: any) => Number(r.id) === Number((issue as any).entity.id)
    )
  ).toBe(true);
  await sdk.automations.completeWindow({
    automation_id: id,
    run_id: (claim as any).run_id,
    window_token: context.window_token,
    extracted_data: {},
  });
  const [run] =
    await sql`SELECT status FROM runs WHERE id = ${(claim as any).run_id}`;
  expect(run.status).toBe("completed");
});
