import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { identityDigest } from "../identity-bootstrap.ts";
import type { IdentityClient } from "../identity-import.script.ts";
import { runMcpIdentity } from "../identity-mcp.ts";

const observation = {
  provider: "gmail" as const,
  account_scope: "synthetic-account",
  namespace: "gmail:mailbox",
  native_key: "contact@example.test",
  source_refs: [
    {
      feed_id: 101,
      connection_id: 202,
      origin_id: "native-1",
      observed_at: "2026-01-01",
    },
  ],
};
const request = {
  workspace: "synthetic-workspace",
  mode: "preview" as const,
  input: { observations: [observation] },
};
const noSdk = {
  org: async () => {
    throw new Error("Preview must not call the SDK");
  },
};

test("portable keys remain byte-identical to the shipped SHA256 namespace", () => {
  for (const value of [
    null,
    [],
    "",
    "Málaga / 東京 / 😀",
    "\ud800",
    ["gmail:mailbox", "synthetic-account", "contact@example.test"],
    "a".repeat(10000),
  ]) {
    expect(identityDigest(value)).toBe(
      createHash("sha256").update(JSON.stringify(value)).digest("hex")
    );
  }
});

test("published bundle runs with no Bun, Node, require, filesystem, crypto or TextEncoder", async () => {
  const asset = readFileSync(
    new URL("../identity-bootstrap.mcp.js", import.meta.url),
    "utf8"
  );
  const decoded = asset.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  expect(decoded).not.toMatch(
    /\/(?:Users|home)\/|file:\/\/|[a-z]:\\|sourceMappingURL|require\(/i
  );
  const execute = runInNewContext(
    `${asset.replace(
      /export\s*\{runMcpIdentity\};?\s*$/,
      "globalThis.execute = runMcpIdentity;"
    )};execute`,
    {},
    { timeout: 3000 }
  );
  expect(await execute(noSdk, request)).toEqual(
    await runMcpIdentity(noSdk, request)
  );
  const { client } = identityStore();
  const preview = await execute(client, request);
  const importing = {
    ...request,
    mode: "import",
    continuation: preview.continuation,
  };
  expect(await execute(client, importing)).toMatchObject({
    done: true,
    changed: 1,
  });
  expect(await execute(client, importing)).toMatchObject({
    done: true,
    changed: 0,
  });
  expect(await execute(client, { ...importing, mode: "verify" })).toMatchObject(
    {
      done: true,
      changed: 0,
    }
  );
});

function identityStore() {
  type Row = { id: number; slug: string; metadata: Record<string, unknown> };
  const rows = new Map<number, Row>();
  const sdk: IdentityClient = {
    query: async (sql) =>
      [...rows.values()].filter((row) => sql.includes(`'${row.slug}'`)),
    entities: {
      create: async (input) => {
        const row = structuredClone({ ...input, id: rows.size + 1 }) as Row;
        rows.set(row.id, row);
        return { entity: structuredClone(row) };
      },
      get: async ({ entity_id }) => ({
        entity: structuredClone(rows.get(entity_id)),
      }),
      update: async (input) => {
        const row = rows.get(Number(input.entity_id))!;
        row.metadata = structuredClone(input.metadata) as Row["metadata"];
        return { success: true };
      },
      listLinks: async () => {
        throw new Error("No links expected");
      },
      link: async () => {
        throw new Error("No links expected");
      },
    },
  };
  return { rows, sdk, client: { org: async () => sdk } };
}

test("call-budget interruption resumes evidence chunks, then replay and verification cover every chunk", async () => {
  const { rows, client } = identityStore();
  const batch = {
    ...request,
    input: {
      observations: Array.from({ length: 21 }, (_, index) => ({
        ...observation,
        native_key: `contact-${index}@example.test`,
        source_refs: Array.from({ length: 81 }, (_, ref) => ({
          ...observation.source_refs[0],
          origin_id: `native-${ref}`,
        })),
      })),
    },
  };
  const seed = {
    ...batch,
    input: {
      observations: batch.input.observations.map((row) => ({
        ...row,
        source_refs: [row.source_refs[0]],
      })),
    },
  };
  const seedPreview = await runMcpIdentity(client, seed);
  await runMcpIdentity(client, {
    ...seed,
    mode: "import",
    continuation: seedPreview.continuation,
  });
  const preview = await runMcpIdentity(client, batch);
  expect(preview.chunks).toBe(63);
  for (const [pass, mode] of (
    ["import", "import", "verify"] as const
  ).entries()) {
    let continuation = preview.continuation;
    let accepted = 0;
    for (let attempt = 0; attempt < preview.chunks; attempt++) {
      const result = await runMcpIdentity(client, {
        ...batch,
        mode,
        continuation,
      });
      if (!("accepted_chunks" in result)) throw new Error("Expected progress");
      expect(result.accepted_chunks).toBeGreaterThan(0);
      expect(result.sdk_calls).toBeLessThanOrEqual(150);
      if (pass === 0 && attempt === 0) {
        expect(result.sdk_calls).toBe(150);
        expect(result.accepted_chunks).toBeLessThan(40);
      }
      accepted += result.accepted_chunks;
      continuation = result.continuation;
      if (pass > 0) {
        expect(result.changed).toBe(0);
        expect(result.linked).toBe(0);
      }
      if (result.done) break;
    }
    expect(accepted).toBe(preview.chunks);
    expect(continuation.next).toBe(preview.chunks);
  }
  expect(rows.size).toBe(21);
  for (const row of rows.values())
    expect(row.metadata.source_refs).toHaveLength(81);
});

test("a lost create response or authorization failure cannot advance the continuation", async () => {
  const { client, sdk, rows } = identityStore();
  const preview = await runMcpIdentity(client, request);
  const importing = {
    ...request,
    mode: "import" as const,
    continuation: preview.continuation,
  };
  const create = sdk.entities.create;
  const lost = new Error("Response lost");
  sdk.entities.create = async (input) => {
    await create(input);
    throw lost;
  };
  await expect(runMcpIdentity(client, importing)).rejects.toBe(lost);
  expect(rows.size).toBe(1);
  sdk.entities.create = create;
  expect(await runMcpIdentity(client, importing)).toMatchObject({
    done: true,
    changed: 0,
  });
  const denied = new Error("Access denied");
  sdk.query = async () => {
    throw denied;
  };
  await expect(runMcpIdentity(client, importing)).rejects.toBe(denied);
  expect(preview.continuation.next).toBe(0);
});

test("preview binds a continuation to the input and workspace before any write", async () => {
  const preview = await runMcpIdentity(noSdk, request);
  expect(preview.identities).toBe(1);
  expect(preview.continuation.next).toBe(0);
  await expect(
    runMcpIdentity(noSdk, { ...request, mode: "import" })
  ).rejects.toThrow("Preview first");
  await expect(
    runMcpIdentity(noSdk, {
      ...request,
      mode: "import",
      workspace: "different",
      continuation: preview.continuation,
    })
  ).rejects.toThrow("Input/workspace changed");
  await expect(
    runMcpIdentity(noSdk, {
      ...request,
      mode: "verify",
      continuation: { ...preview.continuation, mode: "import" },
    })
  ).rejects.toThrow("switching");
  await expect(
    runMcpIdentity(noSdk, {
      ...request,
      mode: "import",
      continuation: { ...preview.continuation, next: -1 },
    })
  ).rejects.toThrow("Invalid continuation");
});
