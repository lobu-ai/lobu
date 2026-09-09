/** Pi's session-file reader sees only the snapshot supplied for this turn. */
export const SESSION_PATH = '/session/current.jsonl';
let snapshot: string | undefined;

export function withSessionSnapshot<T>(jsonl: string, read: () => T): T {
  snapshot = jsonl;
  try {
    return read();
  } finally {
    snapshot = undefined;
  }
}

export function existsSync(path: string): boolean {
  if (path !== SESSION_PATH) throw new Error('Ambient filesystem access is unavailable in the agent isolate');
  return snapshot !== undefined;
}

export function readFileSync(path: string): string {
  if (!existsSync(path) || snapshot === undefined) throw new Error('No native session snapshot is available');
  return snapshot;
}
