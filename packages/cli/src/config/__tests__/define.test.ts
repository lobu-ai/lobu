import { describe, expect, test } from "bun:test";
import { Kind, OptionalKind, Type } from "@sinclair/typebox";
import {
  type Agent,
  type AuthProfile,
  type ConnectorClassExport,
  connectorFromFile,
  context,
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  type EntityType,
  every,
  field,
  on,
  reactionFromFile,
} from "../define.js";
import { isSecretRef, secret } from "../secret.js";

describe("secret", () => {
  test("builds a resolvable ref and narrows", () => {
    const s = secret("GITHUB_TOKEN");
    expect(s).toEqual({ $secret: "GITHUB_TOKEN" });
    expect(isSecretRef(s)).toBe(true);
    expect(isSecretRef({})).toBe(false);
    expect(() => secret("")).toThrow();
  });
});

describe("authoring producers", () => {
  test("define* brand their output and preserve config", () => {
    const person = defineEntityType({ key: "person", name: "Person" });
    expect(person.kind).toBe("entityType");
    expect(person.key).toBe("person");

    const worksAt = defineRelationshipType({
      key: "works_at",
      rules: [{ source: person, target: "org" }],
    });
    expect(worksAt.kind).toBe("relationshipType");
    // typed handle: the EntityType object is usable as a rule source
    expect((worksAt.rules?.[0]?.source as EntityType).key).toBe("person");
  });

  test("agent + automation use typed handles", () => {
    const crm = defineAgent({
      id: "crm",
      providers: [
        { model: "claude-sonnet-4-6", key: secret("ANTHROPIC_API_KEY") },
      ],
    });
    expect(crm.kind).toBe("agent");
    expect(isSecretRef(crm.providers?.[0]?.key)).toBe(true);

    const w = defineAutomation({
      agent: crm,
      slug: "health",
      prompt: "assess",
    });
    expect(w.kind).toBe("automation");
    expect((w.agent as Agent).id).toBe("crm");
  });

  test("reactionFromFile carries the path as a branded marker (no import)", () => {
    const r = reactionFromFile("./reactions/health.reaction.ts");
    expect(r).toEqual({
      kind: "reactionSource",
      path: "./reactions/health.reaction.ts",
    });

    const w = defineAutomation({
      agent: "crm",
      slug: "health",
      prompt: "assess",
      reaction: reactionFromFile("./reactions/health.reaction.ts"),
    });
    expect(w.reaction?.kind).toBe("reactionSource");
    expect(w.reaction?.path).toBe("./reactions/health.reaction.ts");
  });

  test("connectorFromFile carries the path as a branded marker (no import)", () => {
    // Bare (untyped) form still works — the generic defaults.
    const bare = connectorFromFile("./github-issues.connector.ts");
    expect(bare).toEqual({
      kind: "connectorSource",
      path: "./github-issues.connector.ts",
    });

    // The opt-in typed form produces the SAME runtime marker — the generic is
    // erased, carrying only the path as data (no module import at eval time).
    const typed = connectorFromFile<ConnectorClassExport>(
      "./github-issues.connector.ts"
    );
    expect(typed).toEqual(bare);

    const project = defineConfig({
      agents: [defineAgent({ id: "crm" })],
      connectors: [bare],
    });
    expect(project.connectors?.[0]?.kind).toBe("connectorSource");
    expect(project.connectors?.[0]?.path).toBe("./github-issues.connector.ts");
  });

  test("connection + auth profile wire by handle", () => {
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: "github",
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      authProfile: auth,
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    expect(conn.kind).toBe("connection");
    expect((conn.authProfile as AuthProfile).slug).toBe("gh-app");
    expect(isSecretRef(auth.credentials?.clientSecret)).toBe(true);
  });

  test("on() emits the canonical connector event trigger", () => {
    const t = on("slack", "message.created", {
      match: { channel_id: "#support" },
    });
    expect(t).toEqual({
      kind: "event",
      source: "connector",
      connector_key: "slack",
      event_types: ["message.created"],
      match: { channel_id: "#support" },
    });
    // Downstream normalization owns defaults; the shorthand must not bake them.
    expect(t.execution).toBeUndefined();
  });

  test("on() accepts several event types and dedupes", () => {
    expect(
      on("jira", ["issue.created", "issue.updated", "issue.created"])
        .event_types
    ).toEqual(["issue.created", "issue.updated"]);
  });

  test("on() wires a connection handle and overridable execution fields", () => {
    const conn = defineConnection({ slug: "support", connector: "slack" });
    const t = on("slack", "message.created", {
      connection: conn,
      execution: "window",
      active_run: "coalesce",
    });
    expect(t.connection).toBe(conn);
    expect(t.execution).toBe("window");
    expect(t.active_run).toBe("coalesce");
  });

  test("every() emits the canonical schedule trigger", () => {
    expect(every("0 9 * * 1", { timezone: "Europe/Istanbul" })).toEqual({
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/Istanbul",
    });
    expect(every("0 9 * * 1")).toEqual({
      kind: "schedule",
      cron: "0 9 * * 1",
    });
  });

  test("context() emits a context-only SQL source", () => {
    expect(context("SELECT id, name FROM entities")).toEqual({
      query: "SELECT id, name FROM entities",
      context: true,
    });
  });

  test("field() emits a TypeBox string column with display metadata", () => {
    const f = field("Name");
    expect(f[Kind]).toBe("String");
    expect(JSON.parse(JSON.stringify(f))).toEqual({
      type: "string",
      "x-table-label": "Name",
      "x-table-column": true,
    });
  });

  test("field() opts: enum passthrough, column opt-out, optional wrapper", () => {
    const withEnum = field("Stage", { enum: ["a", "b"] });
    expect(JSON.parse(JSON.stringify(withEnum))).toEqual({
      type: "string",
      enum: ["a", "b"],
      "x-table-label": "Stage",
      "x-table-column": true,
    });

    const noColumn = field("X", { column: false });
    expect(JSON.parse(JSON.stringify(noColumn))).toEqual({
      type: "string",
      "x-table-label": "X",
    });

    const opt = field("Email", { optional: true });
    expect(opt[OptionalKind]).toBe("Optional");
    // the Optional marker is a symbol: serialized schema stays plain JSON Schema
    expect(JSON.parse(JSON.stringify(opt))).toEqual({
      type: "string",
      "x-table-label": "Email",
      "x-table-column": true,
    });
  });

  test("field() accepts any TypeBox schema for non-string columns", () => {
    const seats = field(Type.Integer(), "Seats");
    expect(JSON.parse(JSON.stringify(seats))).toEqual({
      type: "integer",
      "x-table-label": "Seats",
      "x-table-column": true,
    });
  });

  test("defineEntityType derives required from field() optionality", () => {
    const lead = defineEntityType({
      key: "lead",
      properties: {
        name: field("Name"),
        company: field("Company", { optional: true }),
        stage: field("Stage", { enum: ["a", "b"] }),
        email: field("Email", { column: false, optional: true }),
      },
    });
    expect(lead.required).toEqual(["name", "stage"]);
    expect(lead.properties?.name).toHaveProperty("x-table-label", "Name");
    // symbols are stripped: stored properties are pure JSON Schema
    expect(
      Object.getOwnPropertySymbols(lead.properties?.company ?? {})
    ).toEqual([]);
    expect(JSON.parse(JSON.stringify(lead.properties))).toEqual({
      name: { type: "string", "x-table-label": "Name", "x-table-column": true },
      company: {
        type: "string",
        "x-table-label": "Company",
        "x-table-column": true,
      },
      stage: {
        type: "string",
        enum: ["a", "b"],
        "x-table-label": "Stage",
        "x-table-column": true,
      },
      email: { type: "string", "x-table-label": "Email" },
    });
  });

  test("defineEntityType: explicit required wins; raw JSON keeps all-optional", () => {
    const explicit = defineEntityType({
      key: "x",
      required: ["name"],
      properties: {
        name: field("Name"),
        email: field("Email", { optional: true }),
      },
    });
    expect(explicit.required).toEqual(["name"]);

    // no field()/TypeBox → today's default: no derived required list
    const raw = defineEntityType({
      key: "y",
      properties: { name: { type: "string" }, email: { type: "string" } },
    });
    expect(raw.required).toBeUndefined();
  });

  test("field() schemas compose inside Type.Object", () => {
    const schema = Type.Object({
      name: field("Name"),
      email: field("Email", { optional: true }),
    });
    expect(schema.required).toEqual(["name"]);
    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: "object",
      properties: {
        name: {
          type: "string",
          "x-table-label": "Name",
          "x-table-column": true,
        },
        email: {
          type: "string",
          "x-table-label": "Email",
          "x-table-column": true,
        },
      },
      required: ["name"],
    });
  });

  test("defineConfig aggregates the project manifest", () => {
    const crm = defineAgent({ id: "crm" });
    const project = defineConfig({ org: "lobu-crm", agents: [crm] });
    expect(project.kind).toBe("project");
    expect(project.org).toBe("lobu-crm");
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]?.id).toBe("crm");
  });

  test("defineEntityType rejects the retired viewTemplate with a migration error", () => {
    expect(() =>
      defineEntityType({
        key: "deal",
        name: "Deal",
        viewTemplate: { type: "card" },
      } as unknown as Omit<EntityType, "kind">)
    ).toThrow(
      /viewTemplate.*retired.*Remove 'viewTemplate' from lobu\.config\.ts/
    );
    // A clean config still passes through untouched.
    expect(defineEntityType({ key: "deal", name: "Deal" }).kind).toBe(
      "entityType"
    );
  });
});
