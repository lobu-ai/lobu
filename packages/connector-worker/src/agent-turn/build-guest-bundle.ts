/**
 * Build step: write the agent guest bundle next to the compiled `bundle.js`.
 *
 * Runs after `tsc` (see the package `build` script) so the bundle is produced
 * from the compiled entry and lands in `dist/`, which is what the package
 * ships. `bundle.ts` prefers this file when it exists; see the note there for
 * why the published package must carry it.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentGuest } from './bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'guest.bundle.js');
const code = await buildAgentGuest();
await writeFile(target, code, 'utf8');
console.log(`[agent-turn] wrote ${target} (${code.length} chars)`);
