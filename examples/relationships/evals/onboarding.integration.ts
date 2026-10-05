import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import { seedOwnerContext } from "../../../packages/server/src/__tests__/setup/test-fixtures";
import type { Env } from "../../../packages/server/src/index";
import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { buildEntitySchemaNamespace } from "../../../packages/server/src/sandbox/namespaces/entity-schema";
import { runScript } from "../../../packages/server/src/sandbox/run-script";
import { manageConnections } from "../../../packages/server/src/tools/admin/manage_connections";
import {
  resolveConnectorCode,
  type StoredConnectorVersion,
} from "../../../packages/server/src/utils/ensure-connector-installed";
import { initWorkspaceProvider } from "../../../packages/server/src/workspace";
import { buildLinkedInArtifact } from "../build-linkedin.mjs";
import setupRelationships, { personSchema } from "../setup";

const env = { ENVIRONMENT: "test" } as Env;
const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "relationships-artifact-"));
  directories.push(directory);
  return directory;
}

beforeAll(async () => {
  await initWorkspaceProvider();
  await cleanupTestDatabase();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("relationships preset", () => {
  it("creates an org-local person schema once and preserves later customizations", async () => {
    const { ctx, org } = await seedOwnerContext({
      orgName: "Synthetic Relationships",
    });
    const entitySchema = buildEntitySchemaNamespace(ctx, env);
    const client = { entitySchema };
    // Execute the exact checked-in script using the production SDK isolate.
    const source = await readFile(
      new URL("../setup.ts", import.meta.url),
      "utf8"
    );
    expect(await runScript({ source, sdk: client as ClientSDK })).toMatchObject(
      {
        success: true,
        returnValue: {
          status: "applied",
          entity_type: { slug: "person", organization_id: org.id },
        },
      }
    );
    const sql = getTestDb();
    const rows = () =>
      sql`SELECT * FROM entity_types WHERE organization_id = ${org.id} AND slug = 'person'`;
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].metadata_schema).toEqual(
      personSchema.metadata_schema
    );
    const customized = {
      ...personSchema.metadata_schema,
      properties: {
        ...personSchema.metadata_schema.properties,
        relationship_note: { type: "string" },
      },
      "x-lobu-resolution": { rules: [] },
    };
    await entitySchema.updateType({
      slug: "person",
      name: "My contacts",
      metadata_schema: customized,
    });
    const before = await rows();
    expect(await setupRelationships({}, client)).toMatchObject({
      status: "already_present",
      entity_type: { name: "My contacts" },
    });
    expect(await rows()).toEqual(before);
  });

  it("does not mistake a public person's schema for the current organization's schema", async () => {
    const other = await seedOwnerContext({
      orgName: "Synthetic Public Schema",
    });
    await setupRelationships(
      {},
      { entitySchema: buildEntitySchemaNamespace(other.ctx, env) }
    );
    const sql = getTestDb();
    await sql`UPDATE organization SET visibility = 'public' WHERE id = ${other.org.id}`;
    const local = await seedOwnerContext({
      orgName: "Synthetic Fresh Relationships",
    });
    expect(
      await setupRelationships(
        {},
        { entitySchema: buildEntitySchemaNamespace(local.ctx, env) }
      )
    ).toMatchObject({
      status: "applied",
      entity_type: { organization_id: local.org.id },
    });
  });

  it("returns a held schema approval without claiming setup completed", async () => {
    const pending = {
      status: "pending_approval",
      approval_queued: true,
      run_id: "synthetic-run",
    };
    expect(
      await setupRelationships(
        {},
        {
          entitySchema: {
            listTypes: async () => ({ entity_types: [] }),
            createType: async () => pending,
          },
        }
      )
    ).toBe(pending);
  });
});

describe("LinkedIn URL artifact", () => {
  it("installs one portable file by URL and runs it after compiler normalization in an isolate", async () => {
    const directory = await temporaryDirectory();
    const path = await buildLinkedInArtifact(directory);
    const code = await readFile(path, "utf8");
    expect(code).not.toContain("./linkedin-takeout");
    expect(code).not.toContain("./linkedin-identity");
    expect(code).not.toContain("./takeout-utils");
    await rm(directory, { recursive: true, force: true });
    vi.stubEnv("CONNECTOR_SOURCE_ALLOWLIST", "artifacts.invalid");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(code));
    const { ctx, org } = await seedOwnerContext({
      orgName: "Synthetic LinkedIn Install",
    });
    // Same input as the existing URL-install form: no special compiled flag.
    const installed = await manageConnections(
      {
        action: "install_connector",
        source_url: "https://artifacts.invalid/linkedin.js",
      },
      env,
      ctx
    );
    expect(installed).toMatchObject({ connector_key: "linkedin" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const sql = getTestDb();
    // Simulate a later compiler upgrade; retained bytes must still be usable.
    await sql`UPDATE connector_versions SET compile_config_hash = NULL WHERE organization_id = ${org.id} AND connector_key = 'linkedin'`;
    const [version] =
      await sql`SELECT id, organization_id, version, compiled_code, compile_config_hash FROM connector_versions WHERE organization_id = ${org.id} AND connector_key = 'linkedin'`;
    expect(version.compile_config_hash).toBeNull();
    const normalized = await resolveConnectorCode(
      "linkedin",
      version as unknown as StoredConnectorVersion
    );
    const result = await new IsolateExecutor({ timeoutMs: 10_000 }).execute(
      normalized,
      {
        mode: "action",
        actionKey: "prepare_comment",
        actionInput: {
          post_url: "https://www.linkedin.com/feed/",
          body: "Synthetic draft",
        },
        config: {},
        credentials: null,
        sessionState: null,
        env: {},
      }
    );
    expect(result).toMatchObject({
      mode: "action",
      output: { status: "not_actionable", reason: "missing_durable_post_id" },
    });
  });

  it.each([
    "/Users/synthetic-foreign-builder/project/source.ts",
    "file:%2F%2F%2FUsers%2Fsynthetic-foreign-builder%2Fproject%2Fsource.ts",
    "C:\\Users\\synthetic-foreign-builder\\project\\source.ts",
  ])("rejects foreign build-machine paths in emitted bytes: %s", async (path) => {
    const source = await temporaryDirectory();
    const destination = await temporaryDirectory();
    await writeFile(
      join(source, "linkedin.connector.ts"),
      `export default class Connector { marker = ${JSON.stringify(path)}; }`
    );
    await expect(buildLinkedInArtifact(destination, source)).rejects.toThrow(
      "Build-machine path"
    );
    await expect(
      readFile(join(destination, "linkedin.js"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
