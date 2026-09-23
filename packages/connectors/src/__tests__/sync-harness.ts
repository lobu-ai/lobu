import type { EventEnvelope, SyncContext, SyncResult } from '@lobu/connector-sdk';

export interface SyncCommit {
  events: EventEnvelope[];
  checkpoint: Record<string, unknown> | null;
}

export interface SyncRun extends SyncResult {
  /** Every committed event, in commit order. */
  events: EventEnvelope[];
  /** The last checkpoint a commit set, or null when none moved it. */
  checkpoint: Record<string, unknown> | null;
  commits: SyncCommit[];
}

interface Syncable {
  sync(ctx: SyncContext): Promise<SyncResult>;
}

/**
 * Run a connector's sync the way the platform does and record what it
 * committed. `commits` keeps each call so a test can assert that a checkpoint
 * travelled with the page it covers.
 */
export async function runSync(
  connector: Syncable,
  ctx: Omit<SyncContext, 'commit'> & Partial<Pick<SyncContext, 'commit'>>
): Promise<SyncRun> {
  const commits: SyncCommit[] = [];
  const result = await connector.sync({
    ...ctx,
    commit: async (events, checkpoint) => {
      commits.push({ events: [...events], checkpoint });
      await ctx.commit?.(events, checkpoint);
    },
  } as SyncContext);
  const moved = commits.filter((c) => c.checkpoint !== null);
  return {
    ...result,
    events: commits.flatMap((c) => c.events),
    checkpoint: moved.length > 0 ? moved[moved.length - 1].checkpoint : null,
    commits,
  };
}
