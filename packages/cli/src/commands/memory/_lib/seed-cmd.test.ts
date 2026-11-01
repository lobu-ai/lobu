import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as memoryAuth from "./memory-auth.js";
import { seedMemoryWorkspace } from "./seed-cmd.js";

const ORG = "seed-revisions";
const tempDirs: string[] = [];
const firstRule = "contact-record -> project";
const secondRule = "company-record -> project";

interface RelationshipState {
  name: string;
  revision: string;
  rules: string[];
}

beforeEach(() => {
  spyOn(process.stdout, "write").mockImplementation(() => true);
  spyOn(memoryAuth, "getUsableToken").mockResolvedValue({
    token: "seed-test-token",
    contextName: "seed-fixture",
    session: {
      mcpUrl: `https://seed.test/mcp/${ORG}`,
      org: ORG,
      tokenType: "Bearer",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
});

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function project(): string {
  const dir = mkdtempSync(join(import.meta.dir, "seed-fixture-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "lobu.config.ts"),
    `
import { defineConfig, defineRelationshipType } from "@lobu/cli/config";
export default defineConfig({
  org: "${ORG}",
  agents: [],
  relationships: [defineRelationshipType({
    key: "supports",
    name: "Seeded support",
    rules: [
      { source: "contact-record", target: "project" },
      { source: "company-record", target: "project" },
      { source: "contact-record", target: "project" },
    ],
  })],
});
`
  );
  return dir;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A stateful wire boundary: successful writes change the token, and stale
// tokens cannot mutate the stored schema. The command and config loader are real.
function schemaServer(options: {
  initial: RelationshipState | null;
  publicCatalog?: boolean;
  concurrentWriteAfterRead?: boolean;
  concurrentRuleAfterList?: boolean;
}) {
  let state = options.initial;
  let sequence = 1;
  const actions: string[] = [];
  const receipt = () => ({
    relationship_type: state && {
      slug: "supports",
      name: state.name,
      revision: state.revision,
      organization_slug: ORG,
    },
  });
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(
      `https://seed.test/api/${ORG}/manage_entity_schema`
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.schema_type).toBe("relationship_type");
    const action = String(body.action);
    actions.push(action);
    if (action === "get") {
      const response = state
        ? receipt()
        : {
            relationship_type: options.publicCatalog
              ? {
                  slug: "supports",
                  name: "Catalog support",
                  revision: "catalog-r1",
                  organization_slug: "public-catalog",
                }
              : null,
          };
      if (options.concurrentWriteAfterRead) {
        state = { name: "Human edit", revision: "human-r2", rules: [] };
      }
      return json(response);
    }
    if (action === "list_rules") {
      const response = {
        rules: (state?.rules ?? []).map((rule, index) => {
          const [source_entity_type_slug, target_entity_type_slug] =
            rule.split(" -> ");
          return {
            id: index + 1,
            source_entity_type_slug,
            target_entity_type_slug,
          };
        }),
      };
      if (options.concurrentRuleAfterList && state) {
        state = {
          ...state,
          revision: "human-rule-r2",
          rules: [...state.rules, secondRule],
        };
      }
      return json(response);
    }
    if (action === "create") {
      if (state)
        return json({ error: "Relationship type already exists" }, 409);
      state = {
        name: String(body.name),
        revision: `r${sequence++}`,
        rules: [],
      };
      return json(receipt());
    }
    if (!state || body.expected_revision !== state.revision) {
      return json(
        {
          error: "Configuration changed before seeding",
          code: "REVISION_CONFLICT",
        },
        409
      );
    }
    if (action === "update") {
      state = { ...state, name: String(body.name), revision: `r${sequence++}` };
      return json(receipt());
    }
    if (action === "add_rule") {
      const rule = `${body.source_entity_type_slug} -> ${body.target_entity_type_slug}`;
      if (state.rules.includes(rule))
        return json(
          {
            error: "This schema approval is stale because the rule now exists.",
            code: "REVISION_CONFLICT",
          },
          409
        );
      state = {
        ...state,
        rules: [...state.rules, rule],
        revision: `r${sequence++}`,
      };
      return json({
        revision: state.revision,
        rule: { id: state.rules.length },
      });
    }
    throw new Error(`Unexpected seed action: ${action}`);
  });
  return { actions, stored: () => state };
}

function runSeed() {
  return seedMemoryWorkspace({
    path: project(),
    org: ORG,
    url: "https://seed.test/mcp",
    context: "seed-fixture",
  });
}

describe("memory seed relationship revisions", () => {
  test.each([
    "existing",
    "absent",
    "public-catalog",
  ] as const)("seeds metadata and rules from one original baseline for %s", async (mode) => {
    const server = schemaServer({
      initial:
        mode === "existing"
          ? { name: "Original", revision: "original-r0", rules: [firstRule] }
          : null,
      publicCatalog: mode === "public-catalog",
    });
    await runSeed();
    expect(server.stored()).toMatchObject({
      name: "Seeded support",
      rules: [firstRule, secondRule],
    });
    // Refetching after each write could bless intervening human edits.
    expect(server.actions).toEqual(
      mode === "existing"
        ? ["get", "list_rules", "update", "add_rule"]
        : ["get", "create", "add_rule", "add_rule"]
    );
  });

  test("seeding the same relationship twice preserves existing rules and skips duplicate declarations", async () => {
    const server = schemaServer({ initial: null });
    await runSeed();
    await runSeed();
    expect(server.stored()).toMatchObject({
      name: "Seeded support",
      rules: [firstRule, secondRule],
    });
    expect(server.actions).toEqual([
      "get",
      "create",
      "add_rule",
      "add_rule",
      "get",
      "list_rules",
      "update",
    ]);
  });

  test("a rule written after list_rules invalidates the original parent revision", async () => {
    const server = schemaServer({
      initial: {
        name: "Original",
        revision: "original-r0",
        rules: [firstRule],
      },
      concurrentRuleAfterList: true,
    });
    await expect(runSeed()).rejects.toThrow("Configuration changed");
    expect(server.stored()).toEqual({
      name: "Original",
      revision: "human-rule-r2",
      rules: [firstRule, secondRule],
    });
    expect(server.actions).toEqual(["get", "list_rules", "update"]);
  });

  test.each([
    "existing",
    "absent",
  ] as const)("refuses a concurrent writer after an initially %s read", async (mode) => {
    const server = schemaServer({
      initial:
        mode === "existing"
          ? { name: "Original", revision: "original-r0", rules: [] }
          : null,
      concurrentWriteAfterRead: true,
    });
    await expect(runSeed()).rejects.toThrow(
      mode === "existing" ? "Configuration changed" : "already exists"
    );
    expect(server.stored()).toEqual({
      name: "Human edit",
      revision: "human-r2",
      rules: [],
    });
    expect(server.actions).toEqual(
      mode === "existing" ? ["get", "list_rules", "update"] : ["get", "create"]
    );
  });
});
