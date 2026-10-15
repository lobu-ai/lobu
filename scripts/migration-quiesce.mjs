/**
 * The deploy-window declaration a migration's author makes in its up section.
 *
 *   -- lobu:no-quiesce  the code deployed before this migration keeps working
 *                       against the post-migration schema, so the old replicas
 *                       keep serving while it runs
 *   -- lobu:quiesce <reason>
 *                       it does not: the pre-upgrade hook scales the app and
 *                       worker to zero (a 503 window) for the migration
 *
 * scripts/migrate-up.mjs reads the declaration to decide whether the deploy may
 * skip the quiesce; scripts/check-migration-quiesce.mjs requires every new
 * migration to make one. Both read it here so the two cannot disagree about
 * what counts as a declaration.
 *
 * A declaration is its own comment line starting at column 0. Prose that
 * mentions a marker mid-line does not arm it.
 *
 * There is deliberately no SQL analysis behind this. Backward compatibility is
 * a property of sequencing relative to the running code, not of the DDL verbs:
 * a DROP COLUMN is safe once nothing reads it, and a widened CHECK constraint
 * is safe because it only ever accepts more. The SQL cannot express either, so
 * only the author can make the call -- which is why the check makes them make
 * it explicitly instead of letting a missing marker default to downtime.
 */

export const NO_QUIESCE = "lobu:no-quiesce";
export const QUIESCE = "lobu:quiesce";

const MIGRATE_DOWN = /^--\s*migrate:down.*$/m;

/** The up section: everything before the `-- migrate:down` directive. */
export function migrationUpSection(content) {
  return content.split(MIGRATE_DOWN)[0];
}

function isWordChar(char) {
  return char !== undefined && /\w/.test(char);
}

function declarationOnLine(line) {
  if (!line.startsWith("--")) return null;
  const body = line.slice(2).trimStart();
  for (const marker of [NO_QUIESCE, QUIESCE]) {
    if (body.startsWith(marker) && !isWordChar(body[marker.length])) {
      return { marker, reason: body.slice(marker.length).trim() };
    }
  }
  return null;
}

/** Every declaration in an up section, in file order. */
export function readQuiesceDeclarations(upSection) {
  return upSection
    .split("\n")
    .map(declarationOnLine)
    .filter((declaration) => declaration !== null);
}

/** True when the author declared that the old replicas may keep serving. */
export function declaresNoQuiesce(upSection) {
  return readQuiesceDeclarations(upSection).some(
    (declaration) => declaration.marker === NO_QUIESCE
  );
}
