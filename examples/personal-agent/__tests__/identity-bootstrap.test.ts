import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunks,
  main,
  sdkScript,
  unwrapSdk,
} from "../identity-bootstrap.cli.ts";
import {
  buildManifest,
  type Observation,
  observationKey,
} from "../identity-bootstrap.ts";
import { captureDefinition } from "../identity-capture.ts";
import {
  type IdentityClient,
  runIdentityChunk,
} from "../identity-import.script.ts";
import { extractParticipants } from "../identity-participants.ts";

const ref = {
  feed_id: 101,
  connection_id: 202,
  origin_id: "native-message-1",
  observed_at: "2026-01-01T00:00:00Z",
};
const row = (overrides: Partial<Observation> = {}): Observation => ({
  provider: "whatsapp",
  account_scope: "synthetic-account-a",
  namespace: "whatsapp:jid",
  native_key: "441234567890@c.us",
  source_refs: [ref],
  ...overrides,
});
function aliasInput() {
  const a = row(),
    b = row({ namespace: "whatsapp:phone", native_key: "+441234567890" });
  return {
    observations: [a, b],
    aliases: [
      {
        left: observationKey(a),
        right: observationKey(b),
        kind: "same_row" as const,
        source_ref: ref,
      },
    ],
  };
}

function store() {
  const rows = new Map<number, any>();
  const links: any[] = [];
  let next = 1;
  const client: IdentityClient = {
    query: async (sql) =>
      [...rows.values()].filter((entity) => sql.includes(`'${entity.slug}'`)),
    entities: {
      create: async (input) => {
        const entity = { ...input, id: next++ };
        rows.set(entity.id, structuredClone(entity));
        return { entity };
      },
      get: async ({ entity_id }) => ({
        entity: structuredClone(rows.get(entity_id)),
      }),
      update: async (input) => {
        rows.set(Number(input.entity_id), {
          ...rows.get(Number(input.entity_id)),
          metadata: structuredClone(input.metadata),
        });
        return { success: true };
      },
      listLinks: async (input) => ({
        relationships: links
          .filter(
            (edge) =>
              edge.from_entity_id === input.entity_id &&
              edge.relationship_type_slug === input.relationship_type_slug
          )
          .slice(
            Number(input.offset),
            Number(input.offset) + Number(input.limit)
          ),
      }),
      link: async (input) => {
        links.push({ ...input, id: next++ });
        if (input.relationship_type_slug === "same_source_account") {
          const member_ids = [
            Number(input.from_entity_id),
            Number(input.to_entity_id),
          ];
          for (const id of member_ids)
            rows.get(id).identity = { root_id: member_ids[1], member_ids };
        }
        return { success: true };
      },
    },
  };
  return { client, rows, links };
}

describe("deterministic identity manifest", () => {
  test("WhatsApp numeric identifiers fail instead of silently losing a participant", () => {
    expect(() =>
      extractParticipants(
        {
          provider: "whatsapp",
          account_scope: "synthetic-account",
          feed_id: 101,
          connection_id: 202,
        },
        [{ ...ref, metadata: { sender_jid: 441234567890 } }]
      )
    ).toThrow("strings");
  });
  test("CLI preparation preserves conflicting alias evidence for validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-alias-test-"));
    try {
      const input = aliasInput();
      input.aliases.unshift({ ...input.aliases[0], kind: "redirect" as any });
      const path = join(dir, "input.json");
      writeFileSync(path, JSON.stringify(input));
      await expect(main(["prepare", "--input", path])).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("native metadata extraction is body-free, skips self, and rejects numeric precision loss", () => {
    const source = {
      provider: "x" as const,
      account_scope: "synthetic-account",
      feed_id: 101,
      connection_id: 202,
    };
    const input = extractParticipants(source, [
      {
        ...ref,
        metadata: {
          sender_id: "1234567890123456789",
          sender_handle: "sample_user",
          body: "PRIVATE BODY",
        },
      },
      {
        ...ref,
        origin_id: "self",
        metadata: {
          sender_id: "9876543210123456789",
          sender_handle: "myself",
          from_me: true,
        },
      },
    ]);
    expect(input.observations).toHaveLength(2);
    expect(buildManifest(input).aliases).toHaveLength(1);
    expect(JSON.stringify(input)).not.toContain("PRIVATE BODY");
    expect(() =>
      extractParticipants(source, [
        { ...ref, metadata: { sender_id: Number("1234567890123456789") } },
      ])
    ).toThrow("strings");
    expect(() =>
      extractParticipants(source, [
        { ...ref, connection_id: 999, metadata: {} },
      ])
    ).toThrow("changed");
  });
  test("order-independent normalization, dedupe and privacy projection", () => {
    const a = row({
      display_names: ["Same Name"],
      source_refs: [{ ...ref, body: "PRIVATE" } as any],
    });
    const b = row({
      display_names: ["Second Name"],
      source_refs: [{ ...ref, origin_id: "native-message-2" }],
    });
    const first = buildManifest({ observations: [a, b] });
    expect(first).toEqual(buildManifest({ observations: [b, a] }));
    expect(first.items).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
    expect(first.items[0].metadata.source_refs).toHaveLength(2);
  });
  test("explicit account scope separates equal identifiers", () => {
    expect(
      buildManifest({
        observations: [row(), row({ account_scope: "synthetic-account-b" })],
      }).items
    ).toHaveLength(2);
    expect(() =>
      buildManifest({ observations: [row({ account_scope: "" })] })
    ).toThrow("account_scope");
  });
  test("an email observation never creates or verifies a person", () => {
    const result = buildManifest({
      observations: [
        row({
          provider: "gmail",
          namespace: "gmail:mailbox",
          native_key: "Role+Tag@Example.TEST",
        }),
      ],
    });
    expect(result.items[0].metadata.native_key).toBe("role+tag@example.test");
    expect(result.items[0].person_ids).toEqual([]);
    expect(result.items[0].metadata.classification).toBe("unknown");
  });
  test("holds suppress links in either input order", () => {
    for (const input of [
      [row({ held: true }), row({ person_ids: [900] })],
      [row({ person_ids: [900] }), row({ held: true })],
    ]) {
      expect(
        buildManifest({ observations: input }).items[0].person_ids
      ).toEqual([]);
    }
  });
  test("structural phone/JID evidence groups without a name", () => {
    const plan = buildManifest(aliasInput());
    expect(plan.aliases).toHaveLength(1);
    expect(plan.items[0].metadata.canonical_source_account_key).toBe(
      plan.items[1].metadata.canonical_source_account_key
    );
  });
  test("names alone, missing evidence and conflicting reuse fail closed", () => {
    const input = aliasInput();
    expect(() =>
      buildManifest({
        ...input,
        aliases: [
          {
            ...input.aliases[0],
            source_ref: { ...ref, origin_id: "not-shared" },
          },
        ],
      })
    ).toThrow();
    expect(() =>
      buildManifest({
        ...input,
        aliases: [...input.aliases, ...input.aliases],
      })
    ).toThrow("reuse");
    expect(
      buildManifest({
        observations: input.observations.map((r) => ({
          ...r,
          display_names: ["Same Name"],
        })),
      }).aliases
    ).toEqual([]);
  });
  test("cross-account alias evidence fails", () => {
    const input = aliasInput();
    input.observations[1].account_scope = "another-account";
    input.aliases[0].right = observationKey(input.observations[1]);
    expect(() => buildManifest(input)).toThrow("Cross-account");
  });
  test.each([
    "whatsapp:group",
    "whatsapp:lid",
    "whatsapp:display-name",
  ])("%s is never a phone alias", (namespace) => {
    const input = aliasInput();
    const native_key =
      namespace === "whatsapp:group"
        ? "12345@g.us"
        : namespace === "whatsapp:lid"
          ? "12345@lid"
          : "Someone";
    input.observations[0] = row({ namespace, native_key });
    input.aliases[0].left = observationKey(input.observations[0]);
    expect(() => buildManifest(input)).toThrow();
  });
  test("large histories are split without losing a source reference", () => {
    const plan = buildManifest({
      observations: [
        row({
          source_refs: Array.from({ length: 1226 }, (_, i) => ({
            ...ref,
            origin_id: `message-${i}`,
          })),
        }),
      ],
    });
    const work = chunks(plan);
    expect(work.length).toBeGreaterThan(1);
    expect(
      work.flatMap((c) => c.items).flatMap((i) => i.metadata.source_refs)
    ).toHaveLength(1226);
    expect(work.every((c) => JSON.stringify(c).length <= 40000)).toBe(true);
  });
});

describe("governed import, verification and replay", () => {
  test("opaque person IDs retain case when proving contact-field evidence", async () => {
    const s = store();
    const c = chunks(
      buildManifest({
        observations: [
          row({
            provider: "linkedin",
            namespace: "linkedin:opaque",
            native_key: "AbC_123",
            person_ids: [900],
          }),
        ],
      })
    )[0];
    s.rows.set(900, {
      id: 900,
      entity_type: "person",
      metadata: { linkedin_member_id: "abc_123" },
    });
    await expect(runIdentityChunk(s.client, c, false)).rejects.toThrow(
      "exact contact-field"
    );
    expect(s.links).toHaveLength(0);
    s.rows.get(900).metadata.linkedin_member_id = "AbC_123";
    await runIdentityChunk(s.client, c, false);
    expect(s.links).toHaveLength(1);
  });
  test("capture config is external, silent and explicitly scoped, with no schedule", () => {
    const definition = captureDefinition({
      slug: "synthetic-reference-capture",
      principal: "synthetic-owner",
      subscriptions: [
        {
          connector_key: "synthetic.connector",
          connection_id: 202,
          event_types: ["declared.changed"],
        },
      ],
    });
    expect(definition.execution_config).toEqual({
      executor: { kind: "external" },
    });
    expect(definition.triggers).toEqual([
      {
        kind: "event",
        source: "connector",
        connector_key: "synthetic.connector",
        connection_id: 202,
        event_types: ["declared.changed"],
        capture: "references",
        output: "silent",
      },
    ]);
    expect(JSON.stringify(definition)).not.toContain("payload_text");
  });
  test("both retained aliases survive grouping and replay produces zero new writes", async () => {
    const s = store(),
      plan = buildManifest(aliasInput());
    for (const c of chunks(plan)) await runIdentityChunk(s.client, c, false);
    expect(s.rows.size).toBe(2);
    expect(s.links).toHaveLength(1);
    for (const c of chunks(plan)) {
      const result = await runIdentityChunk(s.client, c, false);
      expect(result.records.every((r) => r.action === "adopted")).toBe(true);
      expect(result.edges.every((r) => r.action === "adopted")).toBe(true);
      await runIdentityChunk(s.client, c, true);
    }
    expect(s.rows.size).toBe(2);
    expect(s.links).toHaveLength(1);
  });
  test("a lost create response is reconciled by slug without duplication", async () => {
    const s = store(),
      plan = buildManifest({ observations: [row()] }),
      c = chunks(plan)[0];
    const create = s.client.entities.create;
    s.client.entities.create = async (input) => {
      await create(input);
      throw new Error("lost response");
    };
    await expect(runIdentityChunk(s.client, c, false)).rejects.toThrow(
      "lost response"
    );
    s.client.entities.create = create;
    const result = await runIdentityChunk(s.client, c, false);
    expect(result.records[0].action).toBe("adopted");
    expect(s.rows.size).toBe(1);
  });
  test("partial history resume merges references and preserves existing metadata", async () => {
    const s = store(),
      initial = buildManifest({ observations: [row()] });
    await runIdentityChunk(s.client, chunks(initial)[0], false);
    s.rows.get(1).metadata.classification = "reviewed service account";
    const added = buildManifest({
      observations: [
        row({ source_refs: [{ ...ref, origin_id: "later-message" }] }),
      ],
    });
    await runIdentityChunk(s.client, chunks(added)[0], false);
    expect(s.rows.get(1).metadata.source_refs).toHaveLength(2);
    expect(s.rows.get(1).metadata.classification).toBe(
      "reviewed service account"
    );
  });
  test("slug collision, approval and missing persisted writes never count as success", async () => {
    const s = store(),
      c = chunks(buildManifest({ observations: [row()] }))[0];
    s.client.entities.create = async () => ({ approval_queued: true });
    await expect(runIdentityChunk(s.client, c, false)).rejects.toThrow(
      "approval"
    );
    const good = store();
    await runIdentityChunk(good.client, c, false);
    good.rows.get(1).metadata.import_key = "foreign";
    await expect(runIdentityChunk(good.client, c, false)).rejects.toThrow(
      "collision"
    );
  });
  test("person fields must be proved, and the only edge is ordinary evidence", async () => {
    const s = store(),
      c = chunks(
        buildManifest({
          observations: [
            row({
              provider: "x",
              namespace: "x:handle",
              native_key: "Sample_User",
              person_ids: [900],
            }),
          ],
        })
      )[0];
    s.rows.set(900, {
      id: 900,
      slug: "person-fixture",
      entity_type: "person",
      metadata: { x_handle: "unrelated" },
    });
    await expect(runIdentityChunk(s.client, c, false)).rejects.toThrow(
      "exact contact-field"
    );
    s.rows.get(900).metadata.x_handle = "sample_user";
    await runIdentityChunk(s.client, c, false);
    expect(s.links.map((r) => r.relationship_type_slug)).toEqual([
      "matches_contact_field",
    ]);
  });
  test("compiled SDK script executes without local imports or closure state", async () => {
    const s = store(),
      c = chunks(buildManifest({ observations: [row()] }))[0];
    const script = sdkScript(c, false).replace("export default", "return");
    const fn = new Function(script)();
    const result = await fn({}, s.client);
    expect(result.records).toHaveLength(1);
  });
  test("truncated or denied SDK envelopes fail closed", () => {
    expect(() =>
      unwrapSdk({ truncated: true, records: [], edges: [] })
    ).toThrow();
    expect(() =>
      unwrapSdk({
        authorization_status: "pending_approval",
        records: [],
        edges: [],
      })
    ).toThrow();
    expect(() =>
      unwrapSdk({ success: false, return_value: { records: [], edges: [] } })
    ).toThrow();
    expect(() => unwrapSdk({ return_value: { records: [] } })).toThrow();
    expect(
      unwrapSdk({
        content: [
          {
            type: "text",
            text: '```json\n{"success":true,"return_value":{"records":[],"edges":[]}}\n```',
          },
        ],
      })
    ).toEqual({ records: [], edges: [] });
  });
  test.each([
    { from: 999, to: 900, type: "matches_contact_field", accepted: false },
    { from: 1, to: 998, type: "matches_contact_field", accepted: false },
    { from: 1, to: 900, type: "same_person", accepted: false },
    { from: 1, to: 900, type: "matches_contact_field", accepted: true },
  ])("real CLI validates exact edge receipts: %j", async ({
    accepted,
    ...edge
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "identity-edge-test-"));
    try {
      const input = { observations: [row({ person_ids: [900] })] };
      const item = buildManifest(input).items[0];
      const inputPath = join(dir, "input.json"),
        receipts = join(dir, "receipts.json"),
        executable = join(dir, "lobu");
      writeFileSync(inputPath, JSON.stringify(input));
      const result = {
        records: [{ slug: item.slug, id: 1, action: "adopted" }],
        edges: [{ ...edge, action: "adopted" }],
      };
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ return_value: result })}'\n`
      );
      chmodSync(executable, 0o700);
      const command = Bun.spawn(
        [
          process.execPath,
          new URL("../identity-bootstrap.cli.ts", import.meta.url).pathname,
          "import",
          "--input",
          inputPath,
          "--org",
          "synthetic-org",
          "--context",
          "synthetic-context",
          "--receipts",
          receipts,
        ],
        {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(await command.exited).toBe(accepted ? 0 : 1);
      const stderr = await new Response(command.stderr).text();
      if (accepted) expect(stderr).toBe("");
      else expect(stderr).toContain("Invalid edge receipt");
      expect(existsSync(receipts)).toBe(accepted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("real CLI rejects a short response without writing an accepted checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-bootstrap-test-"));
    try {
      const input = join(dir, "input.json"),
        receipts = join(dir, "receipts.json"),
        executable = join(dir, "lobu");
      writeFileSync(input, JSON.stringify({ observations: [row()] }));
      writeFileSync(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"return_value":{"records":[],"edges":[]}}\'\n'
      );
      chmodSync(executable, 0o700);
      const cli = new URL("../identity-bootstrap.cli.ts", import.meta.url)
        .pathname;
      const command = Bun.spawn(
        [
          process.execPath,
          cli,
          "import",
          "--input",
          input,
          "--org",
          "synthetic-org",
          "--context",
          "synthetic-context",
          "--receipts",
          receipts,
        ],
        {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(await command.exited).toBe(1);
      expect(await new Response(command.stderr).text()).toContain(
        "Short or oversized"
      );
      expect(existsSync(receipts)).toBe(false);
      expect(existsSync(`${receipts}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
