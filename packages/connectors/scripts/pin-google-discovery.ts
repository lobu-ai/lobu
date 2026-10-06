/**
 * Pin Google Discovery documents for the Google connectors.
 *
 * Usage: bun packages/connectors/scripts/pin-google-discovery.ts [--check]
 *
 * Fetches each API's Discovery document and writes a trimmed, minified copy to
 * `src/_google/discovery/<api>_<version>.json`. Connectors read these pinned
 * copies at runtime and never fetch Google's document live, so an upstream
 * change reaches users only through a reviewed diff of this directory.
 * `--check` writes nothing and exits 1 when any pinned copy is stale.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const APIS: Array<[string, string]> = [
  ['calendar', 'v3'],
  ['chat', 'v1'],
  ['docs', 'v1'],
  ['drive', 'v3'],
  ['gmail', 'v1'],
  ['people', 'v1'],
  ['sheets', 'v4'],
  ['tasks', 'v1'],
  ['youtube', 'v3'],
];

/** Everything else (icons, global parameters, documentation links) is dropped. */
const KEPT_KEYS = [
  'name',
  'version',
  'title',
  'revision',
  'rootUrl',
  'servicePath',
  'batchPath',
  'auth',
  'methods',
  'resources',
  'schemas',
];

const OUT_DIR = join(import.meta.dir, '..', 'src', '_google', 'discovery');
const check = process.argv.includes('--check');
let stale = 0;

for (const [api, version] of APIS) {
  const response = await fetch(`https://www.googleapis.com/discovery/v1/apis/${api}/${version}/rest`);
  if (!response.ok) throw new Error(`${api}/${version}: HTTP ${response.status}`);
  const doc = (await response.json()) as Record<string, unknown>;
  const pinned = Object.fromEntries(KEPT_KEYS.filter((key) => key in doc).map((key) => [key, doc[key]]));
  const text = `${JSON.stringify(pinned)}\n`;
  const path = join(OUT_DIR, `${api}_${version}.json`);
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current === text) continue;
  stale++;
  console.log(`${check ? 'stale' : 'updated'}: ${api}/${version} (revision ${String(doc.revision)})`);
  if (!check) await writeFile(path, text);
}

if (check && stale > 0) process.exit(1);
