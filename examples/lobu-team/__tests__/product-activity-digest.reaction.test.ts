import { describe, expect, it, mock } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import productActivityDigest, {
  buildProductActivityCard,
  collectProductActivityDigest,
  digestCoverage,
} from "../product-activity-digest.reaction.ts";

const context = {
  extracted_data: { run: true, exclude_email: "operator@example.test" },
  entities: [],
  window: {
    run_id: 1234,
    automation_id: 42,
    window_start: "2026-08-13T12:00:00.000Z",
    window_end: "2026-08-13T12:20:00.000Z",
    content_analyzed: 0,
  },
  automation: {
    id: 42,
    slug: "product-activity-digest",
    name: "Lobu production activity digest",
    version: 1,
  },
  organization_id: "lobu-team-id",
  organization_slug: "lobu-team",
} satisfies ReactionContext;

const healthyFeeds = ["lobu-product-activity-db", "lobu-production-logs"].map(
  (connection_slug) => ({
    connection_slug,
    connection_status: "active",
    status: "active",
    last_sync_status: "success",
    last_sync_at: "2026-08-13T12:18:00.000Z",
    consecutive_failures: 0,
    expected_log_window_collected: true,
  })
);
const healthyCoverage = { product: true, logs: true, issues: [] };

describe("Lobu Team product activity digest reaction", () => {
  it("requires both feed health and a collected source window", () => {
    const end = new Date(context.window.window_end);
    expect(digestCoverage(healthyFeeds, end)).toEqual(healthyCoverage);
    for (const patch of [
      { connection_status: "revoked" },
      { status: "paused" },
      { last_sync_status: "failed" },
      { last_sync_at: "2026-08-12T12:00:00.000Z" },
      { expected_log_window_collected: false },
    ]) {
      const coverage = digestCoverage(
        healthyFeeds.map((row) =>
          row.connection_slug === "lobu-production-logs"
            ? { ...row, ...patch }
            : row
        ),
        end
      );
      expect(coverage.product).toBe(true);
      expect(coverage.logs).toBe(false);
      expect(coverage.issues).toHaveLength(1);
    }

    const missedProductCycle = digestCoverage(
      healthyFeeds.map((row) =>
        row.connection_slug === "lobu-product-activity-db"
          ? { ...row, last_sync_at: "2026-08-13T12:03:00.000Z" }
          : row
      ),
      end
    );
    expect(missedProductCycle.product).toBe(false);
    expect(missedProductCycle.logs).toBe(true);
  });

  it("labels observed log counts as partial during catch-up", async () => {
    const send = mock();
    await productActivityDigest(context, {
      query: mock()
        .mockResolvedValue(
          healthyFeeds.map((row) => ({
            ...row,
            expected_log_window_collected: false,
          }))
        )
        .mockResolvedValueOnce([
          {
            connection_slug: "lobu-production-logs",
            metadata: { errors: 3, warnings: 2 },
          },
        ]),
      notifications: { send },
      log: mock(),
    } as unknown as ReactionClient);
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain(
      "3 / 2 observed — coverage incomplete"
    );
  });

  it("does not use a later feed recovery to complete an earlier arrival window", async () => {
    for (const last_sync_at of [
      context.window.window_end,
      "2026-08-13T12:23:00.000Z",
    ]) {
      const send = mock();
      const feeds = healthyFeeds.map((row) => ({ ...row, last_sync_at }));
      expect(
        digestCoverage(feeds, new Date(context.window.window_end))
      ).toMatchObject({
        product: false,
        logs: false,
      });
      await productActivityDigest(context, {
        query: mock().mockResolvedValue(feeds).mockResolvedValueOnce([]),
        notifications: { send },
        log: mock(),
      } as unknown as ReactionClient);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]?.body).toContain("Coverage incomplete");
    }
  });

  it("reports missing coverage even when no activity arrived", async () => {
    const send = mock();
    await productActivityDigest(context, {
      query: mock().mockResolvedValue([]),
      notifications: { send },
      log: mock(),
    } as unknown as ReactionClient);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0];
    expect(JSON.stringify(message.card)).toContain(
      "Unknown — coverage incomplete"
    );
    expect(message.body).toContain("Coverage incomplete");
    expect(message.body).not.toContain("0 errors");
  });
  it("stays silent when the window has no activity", async () => {
    const send = mock();
    const log = mock();
    const query = mock()
      .mockResolvedValue(healthyFeeds)
      .mockResolvedValueOnce([]);
    const client = {
      query,
      notifications: { send },
      log,
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "No production activity; Slack digest skipped",
      expect.objectContaining({
        window_start: expect.any(String),
        window_end: expect.any(String),
      })
    );
  });

  it("sends one rich digest containing users, emails, clients, and log details", async () => {
    const rows = [
      {
        connection_slug: "lobu-product-activity-db",
        title: "New signup",
        payload_text: "Ada Lovelace · ada@example.com · Analytical Engines",
      },
      {
        connection_slug: "lobu-product-activity-db",
        title: "User login",
        payload_text: "Ada Lovelace · ada@example.com · Analytical Engines",
      },
      {
        connection_slug: "lobu-product-activity-db",
        title: "New connection",
        payload_text:
          "google.gmail · Ada's Gmail · Analytical Engines · created by ada@example.com",
      },
      {
        connection_slug: "lobu-product-activity-db",
        title: "MCP activity",
        payload_text:
          "lobu-cli · Ada Lovelace · ada@example.com · Analytical Engines · memory.search · 13 total calls · 1 failed",
      },
      {
        connection_slug: "lobu-production-logs",
        source_url: "https://grafana.example.test",
        metadata: {
          errors: 2,
          warnings: 1,
          error_samples: ["[server] pool exhausted"],
          warning_samples: ["[worker] retrying"],
        },
      },
    ];
    const send = mock().mockResolvedValue({ notified_count: 1 });
    const query = mock()
      .mockResolvedValue(healthyFeeds)
      .mockResolvedValueOnce(rows);
    const client = {
      query,
      notifications: { send },
      log: mock(),
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(send).toHaveBeenCalledTimes(1);
    const notification = send.mock.calls[0]?.[0];
    expect(notification).toMatchObject({
      title: "Lobu production activity digest",
      recipients: "admins",
      idempotency_key: "product-activity-digest:run:1234",
      automation_source: { automation_id: 42, run_id: 1234 },
    });
    const serializedCard = JSON.stringify(notification?.card);
    expect(serializedCard).toContain("Ada Lovelace");
    expect(serializedCard).toContain("ada@example.com");
    expect(serializedCard).toContain("lobu-cli");
    expect(serializedCard).toContain("memory.search");
    expect(serializedCard).toContain("13 total calls");
    expect(serializedCard).toContain("1 failed");
    expect(serializedCard).toContain("pool exhausted");
    expect(serializedCard).toContain("Open production logs");

    const queryText = String(query.mock.calls[0]?.[0]);
    expect(queryText).not.toContain("superseded_by");
    expect(queryText).toContain("e.created_at");
    expect(queryText).toContain("FROM events e");
    expect(queryText).toContain("e.payload_text");
    // Excluded operator rows are handled in memory (no leading-wildcard LIKE
    // over events), and the window is read in bounded keyset pages so excluded
    // rows cannot consume a fixed LIMIT budget.
    expect(queryText).not.toContain("LIKE '%operator@example.test%'");
    expect(queryText).toContain("ORDER BY e.created_at ASC, e.id ASC");
    expect(queryText).toContain("LIMIT 1000");
  });

  it("deduplicates online users while retaining every activity section", () => {
    const digest = collectProductActivityDigest([
      {
        connection_slug: "lobu-product-activity-db",
        title: "User login",
        payload_text: "Ada · ada@example.com",
      },
      {
        connection_slug: "lobu-product-activity-db",
        title: "MCP activity",
        payload_text: "codex · Ada · ada@example.com",
      },
    ]);
    const card = buildProductActivityCard(
      digest,
      {
        start: context.window.window_start,
        end: context.window.window_end,
      },
      healthyCoverage
    );

    expect(JSON.stringify(card)).toContain(
      '"label":"Online users","value":"1"'
    );
    expect(JSON.stringify(card)).toContain("Active MCP conversations (1)");
  });

  it("excludes the operator's own login and MCP rows from presence", () => {
    const digest = collectProductActivityDigest(
      [
        {
          connection_slug: "lobu-product-activity-db",
          title: "User login",
          payload_text: "Operator · operator@example.test",
        },
        {
          connection_slug: "lobu-product-activity-db",
          title: "MCP activity",
          payload_text: "lobu-cli · Operator · operator@example.test",
        },
        {
          connection_slug: "lobu-product-activity-db",
          title: "User login",
          payload_text: "Ada · ada@example.com",
        },
      ],
      "operator@example.test"
    );
    const card = buildProductActivityCard(
      digest,
      {
        start: context.window.window_start,
        end: context.window.window_end,
      },
      healthyCoverage
    );

    expect(digest.logins).toEqual(["Ada · ada@example.com"]);
    expect(digest.mcp_conversations).toHaveLength(0);
    expect(JSON.stringify(card)).toContain(
      '"label":"Online users","value":"1"'
    );
    expect(JSON.stringify(card)).toContain("ada@example.com");
    expect(JSON.stringify(card)).not.toContain("operator");
  });

  it("stays silent when the operator is the only online user", async () => {
    const rows = [
      {
        connection_slug: "lobu-product-activity-db",
        title: "User login",
        payload_text: "Operator · operator@example.test",
      },
      {
        connection_slug: "lobu-product-activity-db",
        title: "MCP activity",
        payload_text: "lobu-cli · Operator · operator@example.test",
      },
    ];
    const send = mock();
    const query = mock()
      .mockResolvedValue(healthyFeeds)
      .mockResolvedValueOnce(rows);
    const client = {
      query,
      notifications: { send },
      log: mock(),
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(send).not.toHaveBeenCalled();
  });

  it("keeps paginating past a full page of excluded rows to report later activity", async () => {
    // Page 1: exactly PAGE_SIZE excluded presence rows (the operator's own).
    // Page 2: one valid login for Ada. The digest must page past page 1 and
    // still report Ada instead of starving on the fixed-budget problem.
    const excludedPage = Array.from({ length: 1000 }, (_, i) => ({
      connection_slug: "lobu-product-activity-db",
      title: "User login",
      payload_text: `Operator · operator@example.test · org ${i}`,
      _created_at: "2026-08-13T12:01:00.000Z",
      _id: 1000 + i,
    }));
    const validRows = [
      {
        connection_slug: "lobu-product-activity-db",
        title: "User login",
        payload_text: "Ada · ada@example.com",
        _created_at: "2026-08-13T12:02:00.000Z",
        _id: 2000,
      },
    ];
    const send = mock().mockResolvedValue({ notified_count: 1 });
    const query = mock()
      .mockResolvedValue(healthyFeeds)
      .mockResolvedValueOnce(excludedPage)
      .mockResolvedValueOnce(validRows);
    const client = {
      query,
      notifications: { send },
      log: mock(),
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(query.mock.calls).toHaveLength(3);
    const serializedCard = JSON.stringify(send.mock.calls[0]?.[0]?.card);
    expect(serializedCard).toContain("ada@example.com");
    expect(serializedCard).not.toContain("operator");
  });

  it("reads only the claimed arrival window, including its lower boundary", async () => {
    const query = mock()
      .mockResolvedValue(healthyFeeds)
      .mockResolvedValueOnce([]);
    await productActivityDigest(context, {
      query,
      notifications: { send: mock() },
      log: mock(),
    } as unknown as ReactionClient);
    expect(query).toHaveBeenCalledTimes(2);
    const statement = String(query.mock.calls[0]?.[0]);
    expect(statement).toContain("e.created_at >= '2026-08-13T12:00:00.000Z'");
    expect(statement).toContain("e.created_at < '2026-08-13T12:20:00.000Z'");
    const coverageStatement = String(query.mock.calls[1]?.[0]);
    expect(coverageStatement).toContain(
      "e.origin_id = '2026-08-13T12:00:00.000Z'"
    );
    expect(coverageStatement).toContain(
      "e.created_at < '2026-08-13T12:20:00.000Z'"
    );
  });

  it("rejects invalid windows before reading or notifying", async () => {
    const query = mock();
    const send = mock();
    for (const window_end of ["invalid", context.window.window_start]) {
      await expect(
        productActivityDigest(
          {
            ...context,
            window: { ...context.window, window_end },
          },
          {
            query,
            notifications: { send },
            log: mock(),
          } as unknown as ReactionClient
        )
      ).rejects.toThrow("requires a valid arrival window");
    }
    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails before notifying when the row budget would truncate activity", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({
      connection_slug: "lobu-product-activity-db",
      title: "New signup",
      payload_text: "Ada · ada@example.com",
      _created_at: "2026-08-13T12:01:00.000Z",
      _id: i + 1,
    }));
    const query = mock().mockResolvedValue(page);
    const send = mock();
    await expect(
      productActivityDigest(context, {
        query,
        notifications: { send },
        log: mock(),
      } as unknown as ReactionClient)
    ).rejects.toThrow("exceeded its row budget");
    expect(query).toHaveBeenCalledTimes(20);
    expect(send).not.toHaveBeenCalled();
  });

  it("requires the run id used to deduplicate retries", async () => {
    const query = mock();
    const client = {
      query,
      notifications: { send: mock() },
      log: mock(),
    } as unknown as ReactionClient;

    await expect(
      productActivityDigest(
        {
          ...context,
          window: { ...context.window, run_id: undefined as never },
        },
        client
      )
    ).rejects.toThrow("requires a durable run id");
    expect(query).not.toHaveBeenCalled();
  });
});
