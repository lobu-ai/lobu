import { beforeEach, expect, test } from "vitest";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestConnection,
  createTestEvent,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import { createAutomationRun } from "../../../packages/server/src/runs/queue-service";
import config from "../lobu.config";

beforeEach(cleanupTestDatabase);

test("LinkedIn windows exclude other sources and complete with home-feed posts and comments", async () => {
  const definition = config.automations?.find(
    (automation) => automation.slug === "linkedin-feed-flagger"
  );
  if (!definition) throw new Error("Missing LinkedIn automation");
  const query = definition.sources?.posts;
  if (typeof query !== "string") throw new Error("Missing LinkedIn source");
  const workspace = await TestWorkspace.create({
    name: "Synthetic LinkedIn sources",
  });
  const sql = getTestDb();
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-linkedin-owner",
  });
  const arrivedAt = new Date(Date.now() - 60_000);

  async function seed(
    connectorKey: string,
    feedKey: string,
    originType: string
  ) {
    const connection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: connectorKey,
      createDefaultFeed: false,
    });
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status)
      VALUES (${workspace.org.id}, ${connection.id}, ${feedKey}, 'active')
      RETURNING id
    `;
    if (!feed) throw new Error("Missing synthetic feed");
    return createTestEvent({
      organization_id: workspace.org.id,
      connection_id: connection.id,
      connector_key: connectorKey,
      feed_id: Number(feed.id),
      feed_key: feedKey,
      origin_type: originType,
      content: `Synthetic ${connectorKey} ${feedKey} ${originType}`,
      created_at: arrivedAt,
      occurred_at: arrivedAt,
    });
  }

  const post = await seed("linkedin", "home_feed", "post");
  const comment = await seed("linkedin", "home_feed", "comment");
  await seed("x", "home_feed", "post");
  await seed("linkedin", "profile", "profile");
  const created = await workspace.owner.automations.create({
    slug: "synthetic-linkedin-source",
    name: "Synthetic LinkedIn source",
    managed_agent_id: agent.agentId,
    prompt: definition.prompt,
    sources: [{ name: "posts", query }],
  });
  const automationId = Number(created.automation_id);
  const queued = await createAutomationRun({
    organizationId: workspace.org.id,
    automationId,
    agentId: agent.agentId,
    windowStart: new Date(arrivedAt.getTime() - 1_000).toISOString(),
    windowEnd: new Date(arrivedAt.getTime() + 1_000).toISOString(),
    dispatchSource: "scheduled",
  });
  await sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = 'synthetic-linkedin-worker'
    WHERE id = ${queued.runId}
  `;
  const read = (await workspace.owner.knowledge.read({
    automation_id: automationId,
    run_id: queued.runId,
  })) as {
    window_token: string;
    sources: { posts: Array<{ id: number; payload_text: string }> };
  };
  expect(read.sources.posts.map((row) => Number(row.id)).sort()).toEqual(
    [post.id, comment.id].sort()
  );
  expect(
    read.sources.posts.every((row) =>
      row.payload_text.includes("Synthetic linkedin home_feed")
    )
  ).toBe(true);
  await workspace.owner.automations.completeWindow({
    automation_id: String(automationId),
    run_id: queued.runId,
    window_token: read.window_token,
    extracted_data: { flags: [] },
  });
  const [run] =
    await sql`SELECT status, action_output FROM runs WHERE id = ${queued.runId}`;
  expect(run).toMatchObject({
    status: "completed",
    action_output: { flags: [] },
  });
});
