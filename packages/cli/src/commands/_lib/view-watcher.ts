/**
 * `lobu run` view watcher: re-apply the project when a view file, one of its
 * imports, or `lobu.config.ts` changes — so Claude Code in a checkout sees the
 * edited view locally within ~2 s of saving.
 *
 * Watched set is exactly the listed view files + their import graph (from the
 * esbuild metafile, the same bundler apply uses) + the config file (reloaded
 * through jiti on every apply, so config edits take effect without a
 * restart). Per-file `fs.watch` calls: no recursive directory walk, no
 * editor-tempfile noise. Resolved fresh after every apply, so a new import
 * joins the set on the next save.
 */
import { watch, type FSWatcher } from "node:fs";
import { loadProjectConfig } from "./apply/desired-state.js";
import { collectViewWatchFiles } from "./view-bundler.js";

export interface ViewWatchSet {
  configPath: string;
  files: string[];
}

/**
 * Resolve the current watch set for `cwd`: the config file plus every listed
 * view's entry and import graph. Throws the config loader's ValidationError
 * when `lobu.config.ts` is missing or malformed — the caller treats that as
 * "no watcher", never as fatal.
 */
export async function collectViewWatchSet(cwd: string): Promise<ViewWatchSet> {
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

export interface ViewWatcherEvents {
  /** A watched file changed (debounced): re-apply, then rebuild the set. */
  onChange: () => Promise<void>;
  /** Log line for operator-visible watcher state. */
  onLog?: (message: string) => void;
}

/**
 * Watch `set.files` and call `onChange` after 750 ms quiet. Returns `close`.
 * Concurrent change bursts collapse into one call; a change DURING a re-apply
 * schedules exactly one follow-up, so rapid saves never stack applies.
 */
export function startViewWatcher(
  set: ViewWatchSet,
  events: ViewWatcherEvents
): { close: () => void } {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let applying = false;
  let dirty = false;

  const fire = () => {
    timer = null;
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
        if (dirty) {
          dirty = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(fire, 750);
  };

  for (const file of set.files) {
    try {
      watchers.push(watch(file, { persistent: true }, schedule));
    } catch {
      // Tempfile/impl races (deleted between collect and watch): the next
      // successful apply rebuilds the set; a missing file never kills `run`.
    }
  }
  return {
    close: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) w.close();
    },
  };
}
