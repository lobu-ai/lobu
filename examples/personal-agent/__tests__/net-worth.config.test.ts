import { describe, expect, test } from "bun:test";
import taxConfig from "../../personal-finance/lobu.config";
import config from "../lobu.config";

describe("consolidated net-worth configuration", () => {
  test("keeps the durable Automation identity and runs weekly even when books are unchanged", () => {
    const automation = config.automations?.find(
      (candidate) => candidate.slug === "midas-net-worth"
    );
    expect(automation).toBeDefined();
    expect(automation?.name).toBe("Weekly net worth");
    expect(automation?.tags).toEqual(
      expect.arrayContaining(["finance", "net-worth", "balance-sheet"])
    );
    expect(automation?.triggers).toEqual([
      {
        kind: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/London",
        skip_if_unchanged: false,
      },
    ]);
    expect(automation?.executor).toMatchObject({
      kind: "scriptSource",
      path: "./net-worth.reaction.ts",
    });
    expect(automation?.reaction).toBeNull();
    expect(automation?.prompt).toBeUndefined();
    expect(automation?.reactionsGuidance).toBeUndefined();
    expect(Object.values(automation?.sources ?? {})).toEqual([
      expect.objectContaining({ context: true }),
    ]);
  });

  test("exposes the latest precomputed scalar and bounded drilldown as a derived entity", () => {
    const entity = config.entities?.find(
      (candidate) => candidate.key === "net-worth-snapshot"
    );
    expect(entity?.backing?.sql).toContain(
      "metadata->>'schema' = 'net-worth-snapshot/v4'"
    );
    expect(entity?.backing?.sql).toContain("SUM(latest.net_worth_gbp) OVER ()");
    expect(entity?.backing?.sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(entity?.backing?.sql).toContain("LIMIT 1");
    expect(entity?.backing?.sql).toContain("metadata->'previous' AS previous");
    expect(entity?.backing?.sql).not.toContain("GROUP BY");
  });

  test("replaces the legacy asset type with an account metric grain", () => {
    expect(config.entities?.some((entity) => entity.key === "asset")).toBe(
      false
    );
    const account = config.entities?.find((entity) => entity.key === "account");
    expect(account?.measures).toHaveProperty("spend");
    expect(account?.measures).toHaveProperty("transaction_count");
  });

  test("declares a same-org catalog quote handle without shipping duplicate source", () => {
    expect(
      config.connections?.find(
        (connection) => connection.slug === "market-quotes"
      )
    ).toMatchObject({
      connector: "market.quotes",
      feeds: [],
    });
    expect(
      config.connectors?.find(
        (connector) => connector.path === "./market-quotes.connector.ts"
      )
    ).toBeUndefined();
  });

  test("the tax workspace no longer declares a net-worth Automation", () => {
    expect(
      taxConfig.automations?.find(
        (automation) => automation.slug === "net-worth"
      )
    ).toBeUndefined();
  });
});
