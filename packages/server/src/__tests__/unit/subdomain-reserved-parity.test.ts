import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard against drift between the SPA copy of RESERVED_SUBDOMAINS in
 * `packages/owletto/src/lib/subdomain.ts` and the backend canonical
 * list in `packages/server/src/utils/public-origin.ts`. Divergence would
 * silently break subdomain → org resolution on one side.
 *
 * The SPA is a git submodule, so we read the file via fs and parse the
 * literal Set entries with a regex instead of importing the TS module
 * (CI may build the parent before the submodule is checked out).
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SPA_FILE = join(REPO_ROOT, 'packages/owletto/src/lib/subdomain.ts');
const BACKEND_FILE = join(REPO_ROOT, 'packages/server/src/utils/public-origin.ts');

function extractReservedSubdomains(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const match = source.match(/RESERVED_SUBDOMAINS\s*=\s*new Set\(\[([^\]]+)\]\)/);
  if (!match) {
    throw new Error(`Could not find RESERVED_SUBDOMAINS literal in ${filePath}`);
  }
  return [...match[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!).sort();
}

describe('RESERVED_SUBDOMAINS parity', () => {
  it('SPA and backend reserved-subdomain lists are identical', () => {
    // Skip when the submodule is a stub (no SPA file checked out).
    let spaList: string[];
    try {
      spaList = extractReservedSubdomains(SPA_FILE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
    const backendList = extractReservedSubdomains(BACKEND_FILE);
    expect(spaList).toEqual(backendList);
    expect(spaList.length).toBeGreaterThan(0);
  });
});
