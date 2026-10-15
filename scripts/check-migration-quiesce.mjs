#!/usr/bin/env node
/**
 * Every new migration declares its deploy window: `-- lobu:no-quiesce` or
 * `-- lobu:quiesce <reason>` (see docs/MIGRATIONS.md).
 *
 * Without a declaration the pre-upgrade hook quiesces, scaling prod's app and
 * worker to zero. Requiring an explicit choice helps authors avoid that
 * window when the old code can safely run against the new schema.
 *
 * Migrations before FIRST_DECLARED_VERSION predate the rule and are
 * immutable history, so they are not checked.
 *
 * Usage: node scripts/check-migration-quiesce.mjs [migrations-dir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_QUIESCE,
  QUIESCE,
  migrationUpSection,
  readQuiesceDeclarations,
} from "./migration-quiesce.mjs";

const FIRST_DECLARED_VERSION = "20261015120001";

const migrationsDir = process.argv[2] ?? join(process.cwd(), "db/migrations");

function migrationVersion(file) {
  const separator = file.indexOf("_");
  return separator > 0 ? file.slice(0, separator) : null;
}

function problemFor(file) {
  const declarations = readQuiesceDeclarations(
    migrationUpSection(readFileSync(join(migrationsDir, file), "utf-8"))
  );
  if (declarations.length === 0) {
    return `declares no deploy window; add \`-- ${NO_QUIESCE}\` if the code running before this deploy keeps working against the new schema, or \`-- ${QUIESCE} <reason>\` if it does not`;
  }
  if (declarations.length > 1) {
    return `declares ${declarations.length} deploy windows; keep exactly one`;
  }
  const [declaration] = declarations;
  if (declaration.marker === QUIESCE && declaration.reason === "") {
    return `\`-- ${QUIESCE}\` needs a reason: what in the running code breaks against the new schema`;
  }
  return null;
}

const problems = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .filter((file) => {
    const version = migrationVersion(file);
    return version !== null && version >= FIRST_DECLARED_VERSION;
  })
  .sort()
  .map((file) => ({ file, problem: problemFor(file) }))
  .filter(({ problem }) => problem !== null);

if (problems.length > 0) {
  for (const { file, problem } of problems) {
    console.error(`${file}: ${problem}`);
  }
  console.error('\nSee docs/MIGRATIONS.md, "The deploy window".');
  process.exit(1);
}
console.log("Every new migration declares its deploy window.");
