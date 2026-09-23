import type {
  EventEnvelope,
  SyncContext,
  SyncResult,
} from "@lobu/connector-sdk";

/** A checkpoint as a test reads it back: each connector's own shape. */
type Checkpoint = any;

export interface SyncCommit {
  events: EventEnvelope[];
  checkpoint: Checkpoint;
}

export interface SyncRun extends SyncResult {
  /** Every committed event, in commit order. */
  events: EventEnvelope[];
  /** The last checkpoint a commit set, or null when none moved it. */
  checkpoint: Checkpoint;
  commits: SyncCommit[];
}

/** Any connector, whatever its checkpoint and config types. */
interface Syncable {
  sync(ctx: never): Promise<SyncResult>;
}

/**
 * Run a connector's sync the way the platform does and record what it
 * committed. `commits` keeps each call so a test can assert that a checkpoint
 * travelled with the page it covers.
 */
export async function runSync(
  connector: Syncable,
  ctx: Record<string, unknown> & { commit?: SyncContext["commit"] }
): Promise<SyncRun> {
  const commits: SyncCommit[] = [];
  const sync = connector.sync.bind(connector) as (
    ctx: SyncContext
  ) => Promise<SyncResult>;
  const result = await sync({
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
