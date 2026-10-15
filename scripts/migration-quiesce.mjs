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
 * Backward compatibility depends on the running code, so the author makes the
 * declaration; this reader does not infer it from SQL.
 */

export const NO_QUIESCE = "lobu:no-quiesce";
export const QUIESCE = "lobu:quiesce";

const MIGRATE_DOWN = /^--\s*migrate:down.*$/m;
const DECLARATION = new RegExp(
  `^--[ \\t]*(${NO_QUIESCE}|${QUIESCE})\\b(.*)$`,
  "gm"
);

/** The up section: everything before the `-- migrate:down` directive. */
export function migrationUpSection(content) {
  return content.split(MIGRATE_DOWN)[0];
}

/** Every declaration in an up section, in file order. */
export function readQuiesceDeclarations(upSection) {
  return Array.from(upSection.matchAll(DECLARATION), ([, marker, reason]) => ({
    marker,
    reason: reason.trim(),
  }));
}

/** True when the author declared that the old replicas may keep serving. */
export function declaresNoQuiesce(upSection) {
  const declarations = readQuiesceDeclarations(upSection);
  return declarations.length === 1 && declarations[0].marker === NO_QUIESCE;
}
