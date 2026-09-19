/**
 * `lobu run` view reapply loop: re-apply the project when a view file, one of
 * its imports, or `lobu.config.ts` changes — so Claude Code in a checkout sees
 * the edited view locally within ~2 s of saving.
 *
 * The reapply set is exactly the listed view files + their import graph (from
 * the esbuild metafile, the same bundler apply uses) + the config file
 * (reloaded through jiti on every apply, so config edits take effect without
 * a restart). Per-file `fs.watch` calls: no recursive directory walk, no
 * editor-tempfile noise. Resolved fresh after every apply, so a new import
 * joins the set on the next save.
 */
import { statSync, watch } from "node:fs";
import { loadProjectConfig } from "./apply/desired-state.js";
import { collectViewWatchFiles } from "./view-bundler.js";

export interface ViewReapplySet {
  configPath: string;
  files: string[];
}

/**
 * Resolve the current reapply set for `cwd`: the config file plus every
 * listed view's entry and import graph. Throws the config loader's
 * ValidationError when `lobu.config.ts` is missing or malformed — the caller
 * treats that as "no reapply loop", never as fatal.
 */
export async function collectViewReapplySet(
  cwd: string
): Promise<ViewReapplySet> {
  const { project, configPath } = await loadProjectConfig(cwd);
  const files = new Set<string>([configPath]);
  for (const src of project.views ?? []) {
    const rel = src.path.trim();
    if (!rel || rel.startsWith("/") || rel.includes("\\")) continue;
    const { resolve } = await import("node:path");
    const abs = resolve(cwd, rel);
    for (const file of await collectViewWatchFiles(abs)) files.add(file);
  }
  return { configPath, files: [...files].sort() };
}

export interface ViewReapplyEvents {
  /** A reapply file changed (debounced): re-apply, then rebuild the set. */
  onChange: () => Promise<void>;
  /** Log line for operator-visible reapply state. */
  onLog?: (message: string) => void;
}

/**
 * Reapply `set.files` on change and call `onChange` after 750 ms quiet.
 * Returns `close` plus `update`.
 *
 * One coordinator lives for the whole loop: `update` replaces only the
 * native `fs.watch` subscriptions (so a new import joins the set after an
 * apply) and preserves the pending timer, the in-flight apply and the dirty
 * flag. Closing the coordinator on every apply instead would clear a timer
 * scheduled by a save that landed mid-apply, silently discarding it.
 * `close` is terminal: it clears the timer, drops the subscriptions, and
 * stops the finally handler from scheduling anything further.
 *
 * Concurrent change bursts collapse into one call; a change DURING a
 * re-apply schedules exactly one follow-up, so rapid saves never stack
 * applies. When `update` adds a file that was not watched before, one
 * follow-up is requested through the same dirty/schedule mechanism: a save
 * to that file may have landed after the apply read it but before its new
 * subscription existed, so no file subscription could have observed it. The
 * same holds when an existing path changes native file identity (an atomic
 * rename replaces the inode while the old Node per-file subscription stays
 * attached to the replaced file). The next
 * stable graph and unchanged identities add nothing and schedule nothing
 * further.
 *
 * Native file identity for a watched path (`dev:ino`). An atomic rename
 * replaces the inode at the same path while the old Node per-file
 * subscription stays attached to the replaced file, so path equality alone
 * cannot detect the swap. A missing file maps to null so a later reappearance
 * also reconciles.
 */
function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

export function startViewReapply(
  set: ViewReapplySet,
  events: ViewReapplyEvents
): { close: () => void; update: (next: ViewReapplySet) => void } {
  let subs: Array<ReturnType<typeof watch>> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let applying = false;
  let dirty = false;
  let closed = false;
  let watchedFiles = new Set(set.files);
  let watchedIdentities = new Map(
    set.files.map((file) => [file, fileIdentity(file)] as const)
  );

  const fire = () => {
    timer = null;
    if (closed) return;
    if (applying) {
      dirty = true;
      return;
    }
    applying = true;
    events
      .onChange()
      .catch((err: unknown) => {
        events.onLog?.(
          `view re-apply failed: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        applying = false;
        if (closed) return;
        if (dirty) {
          dirty = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(fire, 750);
  };
  const subscribe = (files: string[]) => {
    for (const sub of subs) sub.close();
    subs = [];
    for (const file of files) {
      try {
        subs.push(watch(file, { persistent: true }, schedule));
      } catch {
        // Tempfile/impl races (deleted between collect and reapply): the next
        // successful apply rebuilds the set; a missing file never kills `run`.
      }
    }
  };

  subscribe(set.files);
  return {
    update: (next: ViewReapplySet) => {
      if (closed) return;
      const nextIdentities = new Map(
        next.files.map((file) => [file, fileIdentity(file)] as const)
      );
      let reconcile = next.files.some((file) => !watchedFiles.has(file));
      if (!reconcile) {
        for (const file of next.files) {
          if (nextIdentities.get(file) !== watchedIdentities.get(file)) {
            reconcile = true;
            break;
          }
        }
      }
      watchedFiles = new Set(next.files);
      watchedIdentities = nextIdentities;
      subscribe(next.files);
      if (reconcile) {
        if (applying) dirty = true;
        else schedule();
      }
    },
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const sub of subs) sub.close();
      subs = [];
    },
  };
}
