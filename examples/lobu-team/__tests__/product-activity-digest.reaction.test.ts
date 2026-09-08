import { describe, expect, it, mock } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import productActivityDigest, {
  buildProductActivityCard,
  collectProductActivityDigest,
} from "../product-activity-digest.reaction.ts";

const context = {
  extracted_data: { run: true, exclude_email: "emrekabakci@gmail.com" },
  entities: [],
  window: {
    run_id: 1234,
    automation_id: 42,
    window_start: "2026-08-13T12:00:00.000Z",
    window_end: "2026-08-13T12:20:00.000Z",
    granularity: "20 minutes",
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

describe("Lobu Team product activity digest reaction", () => {
  it("stays silent when the window has no activity", async () => {
    const send = mock();
    const log = mock();
    const query = mock().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
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
    const query = mock().mockResolvedValueOnce(rows);
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
    expect(queryText).not.toContain("LIKE '%emrekabakci@gmail.com%'");
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
    const card = buildProductActivityCard(digest, {
      start: context.window.window_start,
      end: context.window.window_end,
    });

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
          payload_text: "Burak · emrekabakci@gmail.com",
        },
        {
          connection_slug: "lobu-product-activity-db",
          title: "MCP activity",
          payload_text: "lobu-cli · Burak · emrekabakci@gmail.com",
        },
        {
          connection_slug: "lobu-product-activity-db",
          title: "User login",
          payload_text: "Ada · ada@example.com",
        },
      ],
      "emrekabakci@gmail.com"
    );
    const card = buildProductActivityCard(digest, {
      start: context.window.window_start,
      end: context.window.window_end,
    });

    expect(digest.logins).toEqual(["Ada · ada@example.com"]);
    expect(digest.mcp_conversations).toHaveLength(0);
    expect(JSON.stringify(card)).toContain(
      '"label":"Online users","value":"1"'
    );
    expect(JSON.stringify(card)).toContain("ada@example.com");
    expect(JSON.stringify(card)).not.toContain("emrekabakci");
  });

  it("stays silent when the operator is the only online user", async () => {
    const rows = [
      {
        connection_slug: "lobu-product-activity-db",
        title: "User login",
        payload_text: "Burak · emrekabakci@gmail.com",
      },
      {
        connection_slug: "lobu-product-activity-db",
        title: "MCP activity",
        payload_text: "lobu-cli · Burak · emrekabakci@gmail.com",
      },
    ];
    const send = mock();
    const query = mock().mockResolvedValueOnce(rows);
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
      payload_text: `Burak · emrekabakci@gmail.com · org ${i}`,
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
      .mockResolvedValueOnce(excludedPage)
      .mockResolvedValueOnce(validRows);
    const client = {
      query,
      notifications: { send },
      log: mock(),
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(query.mock.calls).toHaveLength(2);
    const serializedCard = JSON.stringify(send.mock.calls[0]?.[0]?.card);
    expect(serializedCard).toContain("ada@example.com");
    expect(serializedCard).not.toContain("emrekabakci");
  });

  it("reads only the claimed arrival window, including its lower boundary", async () => {
    const query = mock().mockResolvedValue([]);
    await productActivityDigest(context, {
      query,
      notifications: { send: mock() },
      log: mock(),
    } as unknown as ReactionClient);
    expect(query).toHaveBeenCalledTimes(1);
    const statement = String(query.mock.calls[0]?.[0]);
    expect(statement).toContain("e.created_at >= '2026-08-13T12:00:00.000Z'");
    expect(statement).toContain("e.created_at < '2026-08-13T12:20:00.000Z'");
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
          window: { ...context.window, run_id: undefined },
        },
        client
      )
    ).rejects.toThrow("requires a durable run id");
    expect(query).not.toHaveBeenCalled();
  });
});
