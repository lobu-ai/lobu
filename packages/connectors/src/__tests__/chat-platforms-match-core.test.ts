/**
 * `CHAT_PLATFORMS` in `@lobu/core` must list exactly the connectors that declare
 * `x-lobu-chat-platform`.
 *
 * The core constant is what a CLIENT uses to decide whether a connection may be
 * `credentialMode: "hosted"` — the server cannot be consulted at config-validation
 * time. That makes it a hand-maintained mirror of the connector declarations,
 * and a hand-maintained mirror drifts: its predecessor said `["slack", "telegram"]`
 * long after Google Chat, Discord, Teams and WhatsApp connectors existed, which
 * made `lobu apply` reject a hosted Google Chat connection outright.
 *
 * Enumerates the CLASS by scanning the connector sources, so adding a chat
 * connector fails here until the constant is updated, rather than silently
 * excluding that platform from hosted chat.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_PLATFORMS } from '@lobu/core';
import { describe, expect, it } from 'vitest';

const CONNECTOR_SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/** Platform keys declared by the bundled connector sources. */
async function declaredChatPlatforms(): Promise<string[]> {
  const found: string[] = [];
  for (const file of await readdir(CONNECTOR_SRC)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const src = await readFile(join(CONNECTOR_SRC, file), 'utf8');
    const declared = /["']x-lobu-chat-platform["']\s*:\s*["']([^"']+)["']/.exec(src);
    if (declared?.[1]) found.push(declared[1]);
  }
  return found.sort();
}

describe('CHAT_PLATFORMS tracks the connector declarations', () => {
  it('lists exactly the connectors declaring x-lobu-chat-platform', async () => {
    const declared = await declaredChatPlatforms();
    // Guard the guard: an empty scan would make the comparison vacuous.
    expect(declared.length).toBeGreaterThanOrEqual(6);
    expect([...CHAT_PLATFORMS].sort()).toEqual(declared);
  });
});
