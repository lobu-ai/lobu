/**
 * One-time operator maintenance, never an SDK operation.
 * Run after physical-merge writers and persisted callers have been retired.
 * Preview writes a private manifest; apply requires that exact manifest and a
 * durable backup. No events are deleted, and no survivor is revived or changed.
 * Execution briefly blocks writes to reference tables; schedule a maintenance
 * window. An old manifest, new dependency, or backup error aborts the transaction.
 * This standalone maintenance command requires explicit approval of the exact
 * historical reference-array changes in its manifest. It is not a runtime event
 * writer: event content and every other event field must remain unchanged.
 */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  getDb,
  pgBigintArray,
  type DbClient,
} from "../packages/server/src/db/client";

// The raw JSON text is authoritative: parsing arbitrary metadata would round
// PostgreSQL JSON numbers outside JavaScript's integer range.
type Row = { id: number; json: string };
const values = (row: Row): Record<string, unknown> => JSON.parse(row.json);
interface Reference {
  table_name: string;
  column_name: string;
  udt_name: string;
}
export interface MergeRetirementManifest {
  version: 1;
  organizationId: string;
  losers: Row[];
  survivors: Row[];
  ledgers: Row[];
  events: Row[];
  provenance: Row[];
  historicalReactions: Row[];
  references: Reference[];
  blockers: string[];
  digest: string;
}

const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const ids = (rows: Row[]) =>
  rows.map((row) => {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("Unsafe entity or event ID");
    return id;
  });
const unbox = (rows: Array<{ row: string }>): Row[] =>
  rows.map((value) => {
    const parsed = JSON.parse(value.row) as { id: number };
    if (!Number.isSafeInteger(parsed.id) || parsed.id < 1)
      throw new Error("Unsafe entity or event ID");
    return { id: parsed.id, json: value.row };
  });

async function referenceColumns(db: DbClient): Promise<Reference[]> {
  // Include actual foreign keys plus non-FK entity columns. A new reference is
  // automatically checked instead of silently inheriting ON DELETE CASCADE.
  return db<Reference>`SELECT DISTINCT c.table_name, c.column_name, c.udt_name
    FROM information_schema.columns c JOIN pg_tables t
      ON t.schemaname = c.table_schema AND t.tablename = c.table_name
    WHERE c.table_schema = 'public' AND ((c.udt_name IN ('int2', 'int4', 'int8', '_int2', '_int4', '_int8')
        AND (c.column_name LIKE '%entity_id%' OR c.column_name IN ('merged_into', 'parent_id')))
        OR EXISTS (SELECT 1 FROM pg_constraint k
          JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
          WHERE k.contype = 'f' AND k.confrelid = 'public.entities'::regclass
            AND k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
            AND a.attname = c.column_name)) ORDER BY 1, 2`;
}

export async function previewMergeRetirement(
  db: DbClient,
  organizationId: string
): Promise<MergeRetirementManifest> {
  if (!organizationId)
    throw new Error("An explicit organization ID is required");
  const references = await referenceColumns(db);
  const losers = unbox(
    await db<{ row: string }>`SELECT to_jsonb(e)::text AS row FROM entities e
    WHERE organization_id = ${organizationId} AND merged_into IS NOT NULL ORDER BY id`
  );
  if (losers.length > 1000)
    throw new Error("More than 1000 tombstones; prepare a bounded migration");
  const loserIds = ids(losers);
  const survivors = unbox(
    await db<{ row: string }>`SELECT to_jsonb(e)::text AS row FROM entities e
    WHERE id = ANY(${pgBigintArray(losers.map((row) => Number(values(row).merged_into)))}::bigint[]) ORDER BY id`
  );
  const byId = new Map(survivors.map((row) => [Number(row.id), values(row)]));
  const blockers: string[] = [];
  for (const snapshot of losers) {
    const loser = values(snapshot);
    const winner = byId.get(Number(loser.merged_into));
    if (
      !loser.deleted_at ||
      !winner ||
      winner.organization_id !== organizationId ||
      winner.entity_type_id !== loser.entity_type_id ||
      winner.merged_into != null
    ) {
      blockers.push("Invalid tombstone or survivor mapping");
      break;
    }
  }
  const eventRows = await db<{
    row: string;
  }>`SELECT to_jsonb(e)::text AS row FROM events e
    WHERE entity_ids && ${pgBigintArray(loserIds)}::bigint[] ORDER BY id LIMIT 10001`;
  if (eventRows.length > 10000)
    throw new Error(
      "More than 10000 affected event versions; prepare a bounded migration"
    );
  const ledgers = unbox(
    await db<{
      row: string;
    }>`SELECT to_jsonb(m)::text AS row FROM entity_merge_operations m
    WHERE loser_entity_id = ANY(${pgBigintArray(loserIds)}::bigint[])
      OR winner_entity_id = ANY(${pgBigintArray(loserIds)}::bigint[]) ORDER BY id`
  );
  if (
    ledgers.some(
      (row) =>
        values(row).organization_id !== organizationId ||
        loserIds.includes(Number(values(row).winner_entity_id))
    )
  ) {
    blockers.push("Unexpected merge ledger mapping");
  }
  const provenance = unbox(
    await db<{
      row: string;
    }>`SELECT to_jsonb(i)::text AS row FROM entity_identities i
    WHERE merged_from_entity_id = ANY(${pgBigintArray(loserIds)}::bigint[]) ORDER BY id`
  );
  const historicalReactions = unbox(
    await db<{
      row: string;
    }>`SELECT to_jsonb(r)::text AS row FROM automation_reactions r
    WHERE entity_id = ANY(${pgBigintArray(loserIds)}::bigint[]) ORDER BY id`
  );
  const handled = new Set([
    "events.entity_ids",
    "entity_merge_operations.loser_entity_id",
    "entity_merge_operations.winner_entity_id",
    "entity_identities.merged_from_entity_id",
    "automation_reactions.entity_id",
  ]);
  for (const ref of references) {
    const key = `${ref.table_name}.${ref.column_name}`;
    if (handled.has(key)) continue;
    const column = identifier(ref.column_name);
    const rows = await db.unsafe(
      `SELECT 1 FROM public.${identifier(ref.table_name)} WHERE ${column}
      ${ref.udt_name.startsWith("_") ? "&& $1::bigint[]" : "= ANY($1::bigint[])"} LIMIT 1`,
      [pgBigintArray(loserIds)]
    );
    if (rows.length) blockers.push(key);
  }
  const state = {
    version: 1 as const,
    organizationId,
    losers,
    survivors,
    ledgers,
    events: unbox(eventRows),
    provenance,
    historicalReactions,
    references,
    blockers,
  };
  return { ...state, digest: checksum(state) };
}

export async function applyMergeRetirement(
  db: ReturnType<typeof getDb>,
  manifest: MergeRetirementManifest,
  archive: (manifest: MergeRetirementManifest) => Promise<void>
): Promise<void> {
  const { digest, ...reviewedState } = manifest;
  if (manifest.version !== 1 || digest !== checksum(reviewedState))
    throw new Error("Invalid manifest checksum");
  if (manifest.blockers.length)
    throw new Error(`Unresolved dependencies: ${manifest.blockers.join(", ")}`);
  await db.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '60s'`;
    const refs = await referenceColumns(tx);
    const tables = [
      ...new Set([
        "entities",
        "entity_merge_operations",
        "events",
        "entity_identities",
        ...refs.map((ref) => ref.table_name),
      ]),
    ].sort();
    // Short maintenance exclusion covers non-FK arrays as well as FK writers.
    await tx.unsafe(
      `LOCK TABLE ${tables.map((table) => `public.${identifier(table)}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`
    );
    const current = await previewMergeRetirement(tx, manifest.organizationId);
    if (current.digest !== manifest.digest)
      throw new Error("Retirement manifest is stale; preview and review again");
    await archive(current);
    const loserIds = ids(current.losers);
    for (const event of current.events) {
      // Map only reviewed losers in PostgreSQL. Preserve unrelated bigint IDs
      // and NULLs exactly, deduplicating by first appearance.
      await tx`UPDATE events e SET entity_ids = ARRAY(
        SELECT mapped.id FROM (
          SELECT COALESCE(loser.merged_into, link.id) AS id, min(link.ordinality) AS first_seen
          FROM unnest(e.entity_ids) WITH ORDINALITY AS link(id, ordinality)
          LEFT JOIN entities loser ON loser.id = link.id AND loser.id = ANY(${pgBigintArray(loserIds)}::bigint[])
          GROUP BY COALESCE(loser.merged_into, link.id)
        ) mapped ORDER BY mapped.first_seen
      ) WHERE e.id = ${event.id}`;
      const [stored] = await tx<{
        unchanged: boolean;
      }>`SELECT (to_jsonb(e) - 'entity_ids') =
        (${event.json}::text::jsonb - 'entity_ids') AS unchanged FROM events e WHERE id = ${event.id}`;
      if (!stored.unchanged)
        throw new Error(
          "Unexpected event change; all retirement changes rolled back"
        );
    }
    await tx`DELETE FROM entity_merge_operations WHERE id = ANY(${pgBigintArray(ids(current.ledgers))}::bigint[])`;
    const removed =
      await tx`DELETE FROM entities WHERE organization_id = ${manifest.organizationId}
      AND id = ANY(${pgBigintArray(loserIds)}::bigint[]) AND deleted_at IS NOT NULL AND merged_into IS NOT NULL RETURNING id`;
    if (removed.length !== loserIds.length)
      throw new Error("Tombstone deletion count changed");
    const survivors = unbox(
      await tx<{ row: string }>`SELECT to_jsonb(e)::text AS row FROM entities e
      WHERE id = ANY(${pgBigintArray(ids(current.survivors))}::bigint[]) ORDER BY id`
    );
    const provenance = unbox(
      await tx<{
        row: string;
      }>`SELECT to_jsonb(i)::text AS row FROM entity_identities i
      WHERE merged_from_entity_id = ANY(${pgBigintArray(loserIds)}::bigint[]) ORDER BY id`
    );
    const reactions = unbox(
      await tx<{
        row: string;
      }>`SELECT to_jsonb(r)::text AS row FROM automation_reactions r
      WHERE entity_id = ANY(${pgBigintArray(loserIds)}::bigint[]) ORDER BY id`
    );
    if (
      checksum(survivors) !== checksum(current.survivors) ||
      checksum(provenance) !== checksum(current.provenance) ||
      checksum(reactions) !== checksum(current.historicalReactions)
    )
      throw new Error("Survivor or provenance changed");
  });
}

async function writePrivate(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(resolve(path)), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      org: { type: "string" },
      manifest: { type: "string" },
      backup: { type: "string" },
      execute: { type: "boolean" },
      "writers-retired": { type: "boolean" },
    },
  });
  if (!process.env.DATABASE_URL || !values.org || !values.manifest)
    throw new Error("Set DATABASE_URL and pass --org <id> --manifest <path>");
  const db = getDb();
  try {
    if (values.execute) {
      if (!values.backup || !values["writers-retired"])
        throw new Error(
          "Execution requires --backup <new-path> and --writers-retired after caller migration and maintenance shutdown"
        );
      const manifest = JSON.parse(
        await readFile(values.manifest, "utf8")
      ) as MergeRetirementManifest;
      if (manifest.organizationId !== values.org)
        throw new Error("Manifest belongs to another organization");
      await applyMergeRetirement(db, manifest, (value) =>
        writePrivate(values.backup!, value)
      );
      console.log(
        JSON.stringify({
          executed: true,
          deleted: manifest.losers.length,
          eventsRemapped: manifest.events.length,
          digest: manifest.digest,
        })
      );
    } else {
      const manifest = await db.begin(
        "isolation level repeatable read read only",
        (tx) => previewMergeRetirement(tx, values.org!)
      );
      await writePrivate(values.manifest, manifest);
      console.log(
        JSON.stringify({
          executed: false,
          obsolete: manifest.losers.length,
          survivors: manifest.survivors.length,
          events: manifest.events.length,
          provenance: manifest.provenance.length,
          blockers: manifest.blockers,
          digest: manifest.digest,
        })
      );
    }
  } finally {
    await db.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
