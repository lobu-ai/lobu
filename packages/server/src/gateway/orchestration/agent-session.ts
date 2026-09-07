import type { SessionEntry } from '@lobu/core';
import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry as PiSessionEntry,
} from '@mariozechner/pi-coding-agent';

/** Pi owns replay; Lobu retains entry identities for compaction and flush state. */
export function replayAgentSession(entries: SessionEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    branch.unshift(entry);
  }
  const piEntries = branch as unknown as PiSessionEntry[];

  // Pi returns messages without source ids, and creates fresh objects for
  // summaries/custom messages. Build their keys with Pi as well, so this
  // adapter contains no second summary, bash, or custom-message converter.
  // Identical messages may occur more than once: consume ids newest-first,
  // matching the suffix retained by the latest compaction.
  const sourceIds = new Map<string, string[]>();
  for (const entry of piEntries) {
    const [message] = buildSessionContext([entry]).messages;
    if (!message) continue;
    const key = JSON.stringify(message);
    const ids = sourceIds.get(key) ?? [];
    ids.push(entry.id);
    sourceIds.set(key, ids);
  }
  const replayed = buildSessionContext(piEntries).messages.reverse().flatMap((message) => {
    const entryId = sourceIds.get(JSON.stringify(message))?.pop();
    if (!entryId) throw new Error('Pi session message has no source entry');
    return convertToLlm([message]).map((converted) => ({
      entryId,
      message: converted as unknown as Record<string, unknown> & { role: string },
    }));
  }).reverse();
  return { branch, replayed };
}
