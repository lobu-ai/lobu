import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "bun";
import {
  buildManifest,
  type IdentityInput,
  type IdentityManifest,
} from "./identity-bootstrap.ts";
import {
  type ImportChunk,
  runIdentityChunk,
} from "./identity-import.script.ts";
import {
  extractParticipants,
  type ParticipantRow,
  type ParticipantSource,
} from "./identity-participants.ts";

export function chunks(manifest: IdentityManifest): ImportChunk[] {
  const result: ImportChunk[] = [];
  let next: ImportChunk = { items: [], aliases: [] };
  const append = (part: ImportChunk) => {
    const joined = {
      items: [...next.items, ...part.items],
      aliases: [...next.aliases, ...part.aliases],
    };
    if (
      Buffer.byteLength(JSON.stringify(joined), "utf8") > 40000 ||
      joined.items.length + joined.aliases.length > 20
    ) {
      if (next.items.length || next.aliases.length) result.push(next);
      next = part;
    } else next = joined;
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > 40000)
      throw new Error("An identity exceeds the bounded payload budget");
  };
  for (const item of manifest.items) {
    const refs = item.metadata.source_refs as unknown[];
    for (let start = 0; start < refs.length; start += 40) {
      append({
        items: [
          {
            ...item,
            metadata: {
              ...item.metadata,
              source_refs: refs.slice(start, start + 40),
            },
          },
        ],
        aliases: [],
      });
    }
  }
  if (next.items.length) result.push(next);
  next = { items: [], aliases: [] };
  for (const alias of manifest.aliases) append({ items: [], aliases: [alias] });
  if (next.aliases.length) result.push(next);
  return result;
}

export function sdkScript(chunk: ImportChunk, verify: boolean): string {
  return `export default async (_ctx, client) => (${runIdentityChunk.toString()})(client, ${JSON.stringify(chunk)}, ${JSON.stringify(verify)});`;
}

export function unwrapSdk(raw: unknown): ReturnType<typeof JSON.parse> {
  let current = raw;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      throw new Error("Malformed SDK envelope");
    const value = current as Record<string, any>;
    if (
      value.isError ||
      value.success === false ||
      value.error ||
      value.truncated ||
      value.approval_queued ||
      value.authorization_status === "pending_approval" ||
      value.status === "pending_approval"
    )
      throw new Error("SDK error or approval gate; no receipt accepted");
    if ("return_value" in value) {
      current = value.return_value;
      continue;
    }
    if (value.structuredContent) {
      current = value.structuredContent;
      continue;
    }
    if (Array.isArray(value.content)) {
      const text = value.content
        .filter((item: any) => item.type === "text")
        .map((item: any) => item.text)
        .join("\n");
      const json = text.match(/```json\s*([\s\S]*?)```/);
      current = JSON.parse(json ? json[1] : text);
      continue;
    }
    if (Array.isArray(value.records) && Array.isArray(value.edges))
      return value;
    throw new Error("Missing complete SDK result arrays");
  }
  throw new Error("SDK envelope nesting exceeded");
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (!["prepare", "import", "verify"].includes(mode))
    throw new Error(
      "Usage: bun identity-bootstrap.cli.ts prepare|import|verify --input metadata.json [--org WORKSPACE --context CONTEXT --receipts receipts.json]"
    );
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !["--input", "--org", "--context", "--receipts", "--output"].includes(
        rest[i]
      ) ||
      !rest[i + 1] ||
      rest[i + 1].startsWith("--") ||
      options[rest[i]]
    )
      throw new Error("Invalid or duplicate argument");
    options[rest[i]] = rest[i + 1];
  }
  if (!options["--input"]) throw new Error("Explicit --input required");
  const raw = JSON.parse(
    readFileSync(options["--input"], "utf8")
  ) as IdentityInput & {
    sources?: { source: ParticipantSource; rows: ParticipantRow[] }[];
  };
  const extracted = (raw.sources ?? []).map(({ source, rows }) =>
    extractParticipants(source, rows)
  );
  const input: IdentityInput = {
    observations: [
      ...(raw.observations ?? []),
      ...extracted.flatMap((r) => r.observations),
    ],
    aliases: [
      ...(raw.aliases ?? []),
      ...extracted.flatMap((r) => r.aliases ?? []),
    ],
  };
  const manifest = buildManifest(input);
  const work = chunks(manifest);
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  if (mode === "prepare") {
    if (options["--output"]) {
      if (options["--output"] === options["--input"])
        throw new Error("Output must not overwrite source input");
      writeFileSync(options["--output"], JSON.stringify(manifest, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    }
    return {
      manifest_digest: digest,
      identities: manifest.items.length,
      alias_pairs: manifest.aliases.length,
      chunks: work.length,
    };
  }
  const org = options["--org"],
    context = options["--context"],
    receipts = options["--receipts"];
  if (!org || !context || !receipts)
    throw new Error(
      "Explicit --org, --context and --receipts required; no default workspace or credentials"
    );
  const lock = `${receipts}.lock`;
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  const checkpoint = {
    org,
    context,
    manifest_digest: digest,
    mode,
    accepted_chunks: [] as unknown[],
  };
  try {
    if (existsSync(receipts)) {
      const saved = JSON.parse(readFileSync(receipts, "utf8"));
      if (
        saved.org !== org ||
        saved.context !== context ||
        saved.manifest_digest !== digest
      )
        throw new Error(
          "Receipt scope/input mismatch; use a new receipt file for a new input batch"
        );
    }
    const records = new Set<number>();
    const idsBySlug = new Map<string, number>();
    let changed = 0,
      linked = 0;
    // Reconcile every chunk even when a receipt exists. Receipts are evidence,
    // never authority to skip live readback after a lost response or grouping.
    for (const chunk of work) {
      const script = sdkScript(chunk, mode === "verify");
      const process = spawn(
        [
          "lobu",
          "memory",
          "run",
          mode === "verify" ? "query_sdk" : "run_sdk",
          JSON.stringify({ title: `Identity bootstrap ${mode}`, script }),
          "--org",
          org,
          "--context",
          context,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (code !== 0)
        throw new Error(
          `Lobu CLI failed (${code}); read back before resuming. ${stderr.slice(0, 300)}`
        );
      const result = unwrapSdk(JSON.parse(stdout));
      if (
        result.records.length !== chunk.items.length ||
        result.edges.length !==
          chunk.aliases.length +
            chunk.items.reduce(
              (count, item) => count + item.person_ids.length,
              0
            )
      )
        throw new Error(
          "Short or oversized SDK result; no checkpoint advanced"
        );
      result.records.forEach((record: any, index: number) => {
        if (
          record.slug !== chunk.items[index].slug ||
          !Number.isSafeInteger(record.id) ||
          record.id <= 0 ||
          (idsBySlug.has(record.slug) &&
            idsBySlug.get(record.slug) !== record.id) ||
          (mode === "verify" && record.action !== "adopted") ||
          !["created", "updated", "adopted"].includes(record.action)
        )
          throw new Error("Invalid identity receipt");
        records.add(record.id);
        idsBySlug.set(record.slug, record.id);
        if (record.action !== "adopted") changed++;
      });
      const expectedEdges = [
        ...chunk.items.flatMap((item) =>
          item.person_ids.map((id) => ({
            from: idsBySlug.get(item.slug),
            to: id,
            type: "matches_contact_field",
          }))
        ),
        ...chunk.aliases.map((alias) => ({
          from: idsBySlug.get(alias.from),
          to: idsBySlug.get(alias.to),
          type: "same_source_account",
        })),
      ];
      for (const [index, edge] of result.edges.entries()) {
        const expected = expectedEdges[index];
        if (
          !Number.isSafeInteger(edge.from) ||
          !Number.isSafeInteger(edge.to) ||
          edge.from !== expected.from ||
          edge.to !== expected.to ||
          edge.type !== expected.type ||
          (mode === "verify" && edge.action !== "adopted") ||
          !["linked", "adopted"].includes(edge.action)
        )
          throw new Error("Invalid edge receipt");
        if (edge.action === "linked") linked++;
      }
      checkpoint.accepted_chunks.push(result);
      writeFileSync(`${receipts}.tmp`, JSON.stringify(checkpoint), {
        mode: 0o600,
      });
      renameSync(`${receipts}.tmp`, receipts);
    }
    return {
      identities: records.size,
      changed_chunks: changed,
      new_edges: linked,
      manifest_digest: digest,
      verified_chunks: work.length,
    };
  } finally {
    unlinkSync(lock);
  }
}

if (import.meta.main)
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
