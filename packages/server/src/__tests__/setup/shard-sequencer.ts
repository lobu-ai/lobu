/**
 * Duration-balanced `--shard` for the server integration suite.
 *
 * Vitest's default shard sorts files by a hash of their path and cuts equal
 * file COUNTS, so a shard's wall time is whatever heavy files the hash happens
 * to drop into it. CI measured 280s / 470s / 690s for the three shards of the
 * same run, with the worst one pressing the job's 15-minute limit.
 *
 * This keeps Vitest's in-shard ordering and replaces only the split: files are
 * packed longest-first onto the least-loaded shard (LPT), weighted by the
 * measured durations in `shard-timings.json`. Files not listed there (short
 * ones, and anything new) weigh `defaultMs`, so a stale table degrades towards
 * a count split rather than failing.
 *
 * Every shard runs in its own job and computes its slice independently, so the
 * partition must be a pure function of the file list and the committed table:
 * ties break on path, and no per-runner state (Vitest's results cache, file
 * mtimes) is consulted. Refresh the table with
 * `node packages/server/scripts/update-shard-timings.mjs <vitest-report.json>...`.
 */
import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import timings from "./shard-timings.json";

const table: { defaultMs: number; files: Record<string, number> } = timings;

/** The table key for a spec: its path relative to the Vitest root, `/`-separated. */
function specKey(root: string, spec: TestSpecification): string {
  return relative(root, spec.moduleId).split(sep).join("/");
}

export class DurationShardSequencer extends BaseSequencer {
  override async shard(
    files: TestSpecification[]
  ): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weighted = files
      .map((spec) => {
        const key = specKey(root, spec);
        return { spec, key, weight: table.files[key] ?? table.defaultMs };
      })
      .sort(
        (a, b) =>
          b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      );
    const loads = new Array<number>(shard.count).fill(0);
    const mine: TestSpecification[] = [];
    for (const file of weighted) {
      let target = 0;
      for (let i = 1; i < loads.length; i++)
        if (loads[i] < loads[target]) target = i;
      loads[target] += file.weight;
      if (target === shard.index - 1) mine.push(file.spec);
    }
    return mine;
  }
}
