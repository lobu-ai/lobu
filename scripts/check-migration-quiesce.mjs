#!/usr/bin/env node
/**
 * Every new migration declares its deploy window: `-- lobu:no-quiesce` or
 * `-- lobu:quiesce <reason>` (see docs/MIGRATIONS.md).
 *
 * Without a declaration the pre-upgrade hook quiesces, scaling prod's app and
 * worker to zero for a pod restart. That default is the safe one, but an
 * omitted marker was choosing it silently: 19 of the 35 migrations in the 30
 * days before this check carried none, so each of those deploys answered 503
 * for about a minute whether or not the migration needed the window. Making
 * the choice explicit keeps the safe default available while ending the
 * accidental one.
 *
 * Migrations at or before FIRST_DECLARED_VERSION predate the rule and are
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
