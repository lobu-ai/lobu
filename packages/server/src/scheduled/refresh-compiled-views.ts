/**
 * A server-compiled view stores its bundle at `views.set` time, and that
 * bundle inlines the `@lobu/views` runtime the server had then. Nothing else
 * rebuilds it, so a runtime fix (frame sizing, link handling, chart layout)
 * never reaches a view until someone saves it again. This job rebuilds the
 * views the server compiled itself, from their retained single index.tsx
 * module, with this process's runtime. `lobu apply` bundles are the CLI's own
 * build (its writes carry `last_writer = 'apply:<id>'`), and multi-file
 * projects cannot be rebuilt here; both are left alone.
 *
 * Only the bundle, its hash and the recorded runtime versions change. The
 * stored declaration (name, attach, params, actions) is kept as is: a source
 * written against an older declaration shape still gets the new runtime
 * rather than failing validation it passed when it was saved.
 */

import { createHash } from 'node:crypto';
import type { SourceFiles } from '@lobu/core/contracts/tools/source-files';
import { contentHash } from '@lobu/core/contracts/tools/view-content-hash';
import { getDb } from '../db/client';
import { emit } from '../events/emitter';
import logger from '../utils/logger';
import { compileView, viewSourceDependencies } from '../views/views';

interface RefreshResult {
  /** Views whose retained source is a single index.tsx module. */
  scanned: number;
  /** Views rewritten with a bundle built by this process. */
  refreshed: number;
  /** Views that failed to rebuild; their stored bundle is left in place. */
  errored: number;
}

interface ViewRow {
  organization_id: string;
  key: string;
  name: string;
  description: string;
  source_code: string;
  source_files: SourceFiles | null;
  attach: unknown;
  params: unknown;
  actions: unknown;
  content_hash: string;
  compiled_sha256: string;
}

/** A self-contained source module. This shape does not establish which
 * compiler produced the stored bundle: CLI projects can have it too. */
function hasSingleModuleSource(row: ViewRow): row is ViewRow & { source_files: SourceFiles } {
  const files = row.source_files;
  if (!files || files.entrypoint !== 'index.tsx') return false;
  const names = Object.keys(files.files);
  return names.length === 1 && files.files['index.tsx'] === row.source_code;
}

export async function refreshCompiledViews(): Promise<RefreshResult> {
  const sql = getDb();
  // The digest is computed in Postgres so the scan never pulls every bundle.
  // `lobu apply` is the only client that ships its own bundle, and every apply
  // write carries an `apply:` writer. If another client compiler appears, store
  // compiler provenance on the row instead, as connectors do with
  // `connector_versions.compile_config_hash`.
  const rows = (await sql`
    SELECT organization_id, key, name, description, source_code, source_files,
      attach, params, actions, content_hash,
      encode(sha256(convert_to(compiled_code, 'UTF8')), 'hex') AS compiled_sha256
    FROM views
    WHERE source_complete AND last_writer NOT LIKE 'apply:%'
  `) as unknown as ViewRow[];

  const result: RefreshResult = { scanned: 0, refreshed: 0, errored: 0 };
  const dependencies = viewSourceDependencies();

  for (const row of rows) {
    if (!hasSingleModuleSource(row)) continue;
    result.scanned += 1;
    try {
      const compiled = await compileView(row.source_code);
      const digest = createHash('sha256').update(compiled, 'utf8').digest('hex');
      if (digest === row.compiled_sha256) continue;
      const hash = contentHash(
        row.source_code,
        {
          name: row.name,
          description: row.description,
          attach: row.attach,
          params: row.params,
          actions: row.actions,
        },
        compiled,
        { sourceFiles: row.source_files, dependencies }
      );
      // Compare-and-set on the hash read above: a save that lands mid-scan
      // wins, and this pass leaves that row for the next one.
      const updated = await sql`
        UPDATE views
        SET compiled_code = ${compiled}, content_hash = ${hash},
          dependencies = ${sql.json(dependencies)}, updated_at = NOW()
        WHERE organization_id = ${row.organization_id} AND key = ${row.key}
          AND content_hash = ${row.content_hash}
      `;
      if (updated.count > 0) {
        result.refreshed += 1;
        emit(row.organization_id, { keys: [`view:${row.key}`] });
      }
    } catch (err) {
      result.errored += 1;
      logger.warn(
        { err, organizationId: row.organization_id, viewKey: row.key },
        '[refresh-compiled-views] View failed to rebuild; keeping its stored bundle',
      );
    }
  }
  return result;
}
