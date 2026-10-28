import { describe, expect, test } from "bun:test";
import { ApiError } from "../../../memory/_lib/errors.js";
import { ApplyClient, isDuplicateError } from "../client.js";

describe("ApplyClient", () => {
  test("listFeeds rejects an incomplete empty page instead of planning from partial state", async () => {
    const client = new ApplyClient(
      {
        apiBaseUrl: "https://example.test",
        orgSlug: "fixture",
        token: "test-token",
      },
      (async () =>
        new Response(
          JSON.stringify({ feeds: [], has_more: true })
        )) as typeof fetch
    );
    await expect(client.listFeeds(3)).rejects.toThrow(
      "empty page with more feeds remaining"
    );
  });

  test("collection presentation persists with schema fields and clears only when explicitly pruned", async () => {
    const bodies: Record<string, any>[] = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );
    const collection = {
      presets: [
        {
          key: "large",
          label: "Large",
          selection: {
            filters: [{ field: "size", op: "gte" as const, value: 200 }],
          },
        },
      ],
    };
    const core = {
      properties: { size: { type: "number" } },
      required: ["size"],
    };
    await client.upsertEntityType(
      { slug: "account", collection },
      { "x-other": true },
      core
    );
    expect(bodies[0]?.metadata_schema).toMatchObject({
      ...core,
      "x-other": true,
      "x-lobu-collection": collection,
    });
    await client.upsertEntityType(
      { slug: "account", properties: core.properties },
      { "x-lobu-collection": collection }
    );
    expect(bodies[1]?.metadata_schema["x-lobu-collection"]).toEqual(collection);
    await client.upsertEntityType(
      { slug: "account" },
      { "x-lobu-collection": collection },
      core,
      new Set(["collection"])
    );
    expect(bodies[2]?.metadata_schema).toEqual({ type: "object", ...core });
  });

  test("applyChatConnection rejects a malformed success response", async () => {
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async () =>
        new Response(
          JSON.stringify({
            action: "apply_chat_connection",
            created: true,
            changed: true,
          }),
          { status: 200 }
        )) as typeof fetch
    );

    await expect(
      client.applyChatConnection({
        slug: "team-slack",
        connector: "slack",
        config: { botToken: "xoxb-test" },
      })
    ).rejects.toThrow(/returned no connection payload/);
  });
});

describe("ApplyClient — entity schema merge", () => {
  test("upsertEntityType sends backing:null only when the diff flagged the revert", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    // A stored type with no diff flag: backing is omitted, so a fired update
    // for an unrelated field never reverts out-of-band backing.
    await client.upsertEntityType({ slug: "company", name: "Company" });
    expect(JSON.parse(String(calls[0]?.init?.body)).backing).toBeUndefined();

    // Flagged revert (derived → stored): backing:null is sent.
    await client.upsertEntityType(
      { slug: "company", name: "Company" },
      undefined,
      undefined,
      new Set(["backing"])
    );
    expect(JSON.parse(String(calls[1]?.init?.body)).backing).toBeNull();
  });

  test("upsertEntityType sends metrics_config:null only when the diff flagged the removal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType({ slug: "company", name: "Company" });
    expect(
      JSON.parse(String(calls[0]?.init?.body)).metrics_config
    ).toBeUndefined();

    await client.upsertEntityType(
      { slug: "company", name: "Company" },
      undefined,
      undefined,
      new Set(["metrics"])
    );
    expect(JSON.parse(String(calls[1]?.init?.body)).metrics_config).toBeNull();
  });

  test("upsertEntityType sends event_kinds when declared, omits when not, clears when flagged", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    const eventKinds = {
      valuation: {
        description: "A snapshot",
        metadataSchema: { type: "object" },
      },
    };
    await client.upsertEntityType({ slug: "deal", eventKinds });
    expect(JSON.parse(String(calls[0]?.init?.body)).event_kinds).toEqual(
      eventKinds
    );

    // Not declared + not flagged → omitted, so an unrelated update never wipes
    // out-of-band eventKinds. Flagged prune removal → null is sent.
    await client.upsertEntityType({ slug: "person", name: "Person" });
    expect(
      JSON.parse(String(calls[1]?.init?.body)).event_kinds
    ).toBeUndefined();
    await client.upsertEntityType(
      { slug: "person", name: "Person" },
      undefined,
      undefined,
      new Set(["eventKinds"])
    );
    expect(JSON.parse(String(calls[2]?.init?.body)).event_kinds).toBeNull();
  });

  test("listEntityTypes hoists event_kinds; null/empty stays undefined", async () => {
    const eventKinds = { note: { description: "A note" } };
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async () =>
        new Response(
          JSON.stringify({
            entity_types: [
              { slug: "deal", event_kinds: eventKinds },
              { slug: "person", event_kinds: null },
              { slug: "empty", event_kinds: {} },
            ],
          }),
          { status: 200 }
        )) as typeof fetch
    );

    const types = await client.listEntityTypes();
    const byKey = Object.fromEntries(types.map((t) => [t.slug, t]));
    expect(byKey.deal?.eventKinds).toEqual(eventKinds);
    expect(byKey.person?.eventKinds).toBeUndefined();
    expect(byKey.empty?.eventKinds).toBeUndefined();
  });

  test("an undeclared metadata_schema extension survives an apply round-trip", async () => {
    // A policy authored out-of-band is unmanaged when resolutionPolicy is
    // omitted from config. Since upsert rebuilds metadata_schema from flat
    // properties/required, the extension must ride along or apply erases it.
    const resolution = {
      rules: [
        {
          fields: ["email"],
          normalizer: "email",
          onMatch: "auto_link",
        },
      ],
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        const body = JSON.parse(String(init?.body)) as { action?: string };
        if (body.action === "list") {
          return new Response(
            JSON.stringify({
              entity_types: [
                {
                  slug: "person",
                  metadata_schema: {
                    type: "object",
                    properties: { email: { type: "string" } },
                    required: ["email"],
                    "x-lobu-resolution": resolution,
                  },
                },
                { slug: "company", metadata_schema: { type: "object" } },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    const [person, company] = await client.listEntityTypes();
    expect(person?.schemaExtras).toEqual({ "x-lobu-resolution": resolution });
    // A type with nothing but hoisted core keys stays undefined (no churn).
    expect(company?.schemaExtras).toBeUndefined();

    // Re-apply a config that adds a field: properties come from config, the
    // out-of-band key rides along.
    await client.upsertEntityType(
      {
        slug: "person",
        properties: {
          email: { type: "string" },
          handle: { type: "string" },
        },
        required: ["email"],
      },
      person?.schemaExtras
    );

    const posted = JSON.parse(String(calls[1]?.init?.body));
    expect(posted.metadata_schema).toEqual({
      type: "object",
      properties: {
        email: { type: "string" },
        handle: { type: "string" },
      },
      required: ["email"],
      "x-lobu-resolution": resolution,
    });
  });

  test("declared resolutionPolicy is folded into metadata_schema and wins over out-of-band extras", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType(
      {
        slug: "person",
        properties: { email: { type: "string" } },
        resolutionPolicy: {
          "x-lobu-resolution": {
            rules: [
              { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
            ],
          },
        },
      },
      // Remote out-of-band value differs — the declared policy must win.
      { "x-lobu-resolution": { rules: [] } }
    );

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.metadata_schema["x-lobu-resolution"]).toEqual({
      rules: [{ fields: ["email"], normalizer: "email", onMatch: "auto_link" }],
    });
    expect(body.metadata_schema.properties).toEqual({
      email: { type: "string" },
    });
  });

  test("out-of-band resolution extras survive when no policy is declared", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType(
      { slug: "person", properties: { email: { type: "string" } } },
      {
        "x-lobu-resolution": {
          rules: [
            { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
          ],
        },
      }
    );
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.metadata_schema["x-lobu-resolution"]).toEqual({
      rules: [{ fields: ["email"], normalizer: "email", onMatch: "auto_link" }],
    });
  });

  test("an extension-only type never wipes the live properties/required (remote core round-trips)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    // Config declares ONLY the resolution policy — no properties/required. The
    // live type has a full schema, which must survive the rebuild verbatim.
    await client.upsertEntityType(
      {
        slug: "person",
        resolutionPolicy: {
          "x-lobu-resolution": {
            rules: [
              { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
            ],
          },
        },
      },
      undefined,
      {
        properties: { email: { type: "string" }, handle: { type: "string" } },
        required: ["email"],
      }
    );

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.metadata_schema).toEqual({
      type: "object",
      properties: { email: { type: "string" }, handle: { type: "string" } },
      required: ["email"],
      "x-lobu-resolution": {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
        ],
      },
    });
  });

  test("a policy-only upsert omits undeclared facets instead of clearing them", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType({
      slug: "person",
      resolutionPolicy: {
        "x-lobu-resolution": {
          rules: [
            { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
          ],
        },
      },
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    // Facets the config does not own must not be sent at all — sending null
    // would clear live eventKinds/backing/metrics on the server.
    expect("event_kinds" in body).toBe(false);
    expect("backing" in body).toBe(false);
    expect("metrics_config" in body).toBe(false);
  });

  test("a prune-flagged removal clears properties/required instead of preserving them", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType(
      {
        slug: "person",
        resolutionPolicy: {
          "x-lobu-resolution": {
            rules: [
              { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
            ],
          },
        },
      },
      undefined,
      {
        properties: { email: { type: "string" } },
        required: ["email"],
      },
      new Set(["properties", "required"])
    );

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.metadata_schema.properties).toEqual({});
    expect("required" in body.metadata_schema).toBe(false);
  });

  test("a prune-flagged resolutionPolicy removal drops x-lobu-resolution from the schema", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType(
      { slug: "person", name: "Person" },
      {
        "x-lobu-resolution": {
          rules: [
            { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
          ],
        },
      },
      { properties: { email: { type: "string" } } },
      new Set(["resolutionPolicy"])
    );

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.metadata_schema["x-lobu-resolution"]).toBeUndefined();
    // The live core round-trips; only the pruned extension is dropped.
    expect(body.metadata_schema.properties).toEqual({
      email: { type: "string" },
    });
  });

  test("config-owned metadata_schema keys win over stale carried-forward ones", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    await client.upsertEntityType(
      { slug: "person", properties: { email: { type: "string" } } },
      // A malformed extras bag must never shadow the config's own fields —
      // including `required`, which the config omits here (an empty required
      // is expressed by NOT sending the key, so a stale one must not ride in).
      {
        properties: { stale: { type: "string" } },
        required: ["stale"],
        "x-lobu-note": "keep",
      }
    );

    const posted = JSON.parse(String(calls[0]?.init?.body));
    expect(posted.metadata_schema).toEqual({
      type: "object",
      properties: { email: { type: "string" } },
      "x-lobu-note": "keep",
    });
  });

  test("listEntityTypes hoists metrics_config to metrics; null/empty stays undefined", async () => {
    const metrics = {
      measures: {
        spend: {
          eventSet: "charges",
          agg: "sum",
          expr: "x",
          description: "Spend.",
        },
      },
    };
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async () =>
        new Response(
          JSON.stringify({
            entity_types: [
              { slug: "company", metrics_config: metrics },
              { slug: "person", metrics_config: null },
              { slug: "empty", metrics_config: {} },
            ],
          }),
          { status: 200 }
        )) as typeof fetch
    );

    const types = await client.listEntityTypes();
    const byKey = Object.fromEntries(types.map((t) => [t.slug, t]));
    expect(byKey.company?.metrics).toEqual(metrics);
    // null and empty {} both hoist to undefined → no diff churn for non-metric types.
    expect(byKey.person?.metrics).toBeUndefined();
    expect(byKey.empty?.metrics).toBeUndefined();
  });
});

// Issue #1177: a 422 schema-validation error from `create` must NOT be
// mistaken for "already exists" (which retried as `update` and buried the
// real message under "Entity type not found").
describe("isDuplicateError", () => {
  test("coded duplicates are duplicates", () => {
    for (const code of [
      "entity_type_exists",
      "relationship_type_exists",
      "already_exists",
    ]) {
      expect(
        isDuplicateError(
          new ApiError(`POST /x failed: [${code}] thing already exists`, 409)
        )
      ).toBe(true);
    }
  });

  test("bare 409 without a code is still a duplicate", () => {
    expect(
      isDuplicateError(new ApiError("POST /x failed: conflict", 409))
    ).toBe(true);
  });

  test("422 validation error is NOT a duplicate", () => {
    expect(
      isDuplicateError(
        new ApiError(
          "POST /x failed: [invalid_schema] metadata_schema.properties.a.x-table-column must be a boolean",
          422
        )
      )
    ).toBe(false);
  });

  test("code-less 400 is NOT a duplicate", () => {
    expect(
      isDuplicateError(new ApiError("POST /x failed: slug is required", 400))
    ).toBe(false);
  });

  test("missing status is NOT a duplicate", () => {
    expect(isDuplicateError(new ApiError("Invalid JSON from /x"))).toBe(false);
  });
});

describe("ApplyClient — upsert create/update flow", () => {
  test("create → coded 409 duplicate → retries as update (idempotent)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        const body = JSON.parse(String(init?.body));
        if (body.action === "create") {
          return new Response(
            JSON.stringify({
              error:
                "[entity_type_exists] Entity type with slug 'task' already exists",
            }),
            { status: 409 }
          );
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch
    );

    const result = await client.upsertEntityType({
      slug: "task",
      name: "Task",
    });
    expect(result).toEqual({ updated: true });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body)).action).toBe("create");
    expect(JSON.parse(String(calls[1]?.init?.body)).action).toBe("update");
  });

  test("create → 422 validation error surfaces verbatim, no update retry", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            error:
              "[invalid_schema] metadata_schema.properties.a.x-table-column must be a boolean",
          }),
          { status: 422 }
        );
      }) as typeof fetch
    );

    await expect(
      client.upsertEntityType({ slug: "task", name: "Task" })
    ).rejects.toThrow(
      /metadata_schema.properties.a.x-table-column must be a boolean/
    );
    // The doomed `update` retry (which produced the misleading
    // "Entity type 'task' not found") must not happen.
    expect(calls).toHaveLength(1);
  });
});

describe("ApplyClient — deployment baseline read", () => {
  test("getLatestDeployment resolves a pre-route server's 404 to no baseline", async () => {
    // `/deployments/latest` always answers 200 ({deployment: null} when there
    // is none), so a 404 means the server predates the route. That must read as
    // "no recorded baseline", not fail the whole apply.
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async () =>
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
        })) as typeof fetch
    );

    await expect(client.getLatestDeployment()).resolves.toBeNull();
  });

  test("getLatestDeployment propagates a non-404 failure (never a silent baseline reset)", async () => {
    const client = new ApplyClient(
      { apiBaseUrl: "https://example.test", orgSlug: "acme", token: "tok" },
      (async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
        })) as typeof fetch
    );

    await expect(client.getLatestDeployment()).rejects.toThrow(/boom/);
  });
});
