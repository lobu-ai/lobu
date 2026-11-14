import { describe, expect, it } from "bun:test";
import { buildScopedQuery } from "../../utils/execute-data-sources";

describe("buildScopedQuery tableless parameter coverage", () => {
  it("does not bind context values that the query does not reference", () => {
    const scoped = buildScopedQuery("SELECT 1 AS value", [], {
      organizationId: "org_test",
      entityIds: [42],
    });

    expect({ sql: scoped.sql, params: scoped.params }).toEqual({
      sql: "SELECT 1 AS value",
      params: [],
    });
  });

  it("binds repeated entity placeholders once", () => {
    const scoped = buildScopedQuery(
      "SELECT {{entityId}} AS first_id, {{entityId}} AS second_id",
      [],
      {
        organizationId: "org_test",
        entityIds: [42],
      },
    );

    expect({ sql: scoped.sql, params: scoped.params }).toEqual({
      sql: "SELECT $1::bigint AS first_id, $1::bigint AS second_id",
      params: [42],
    });
  });

  it("allocates referenced context values in stable compiler order", () => {
    const scoped = buildScopedQuery(
      "SELECT {{query.name}} AS name, {{organizationId}} AS organization_id, {{query.missing}} AS missing",
      [],
      {
        organizationId: "org_test",
        query: { name: "Alpha" },
      },
    );

    expect({ sql: scoped.sql, params: scoped.params }).toEqual({
      sql: "SELECT $2::text AS name, $1 AS organization_id, $3::text AS missing",
      params: ["org_test", "Alpha", null],
    });
  });

  it("rejects unresolved placeholders", () => {
    expect(() =>
      buildScopedQuery("SELECT {{unknown}} AS value", [], {
        organizationId: "org_test",
      }),
    ).toThrow("Unknown context variables: {{unknown}}");
  });

  it("rejects raw positional parameters", () => {
    expect(() =>
      buildScopedQuery("SELECT $1 AS value", [], {
        organizationId: "org_test",
      }),
    ).toThrow("Positional parameters ($1, $2, ...) are not allowed");
  });
});
