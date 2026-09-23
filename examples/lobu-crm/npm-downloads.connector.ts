import {
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface NpmDownloadsCheckpoint {
  /** Period-end dates already emitted, so a re-poll of the same week is a no-op. */
  seen_periods: string[];
}

interface NpmDownloadsConfig {
  /** npm package name, e.g. "@lobu/cli". */
  package: string;
}

/**
 * npm-downloads connector — polls the public npm download-counts API
 * (`api.npmjs.org`, no auth) for `config.package` and emits one event per
 * new weekly period. Dedup via a rolling checkpoint of seen period-end dates.
 * Auto-discovered by `lobu apply` via `connectorFromFile`.
 *
 * A real, working `connectorFromFile` showcase: ConnectorRuntime<C, F> with a
 * typed checkpoint + config against a live public endpoint. Weekly npm pulls
 * are a top-of-funnel adoption signal — they belong in the CRM next to stars
 * and mentions.
 */
export default class NpmDownloadsConnector extends ConnectorRuntime<
  NpmDownloadsCheckpoint,
  NpmDownloadsConfig
> {
  readonly definition = {
    key: "npm-downloads",
    name: "npm downloads",
    version: "1.1.0",
    authSchema: { methods: [{ type: "none" as const }] },
    feeds: {
      weekly: {
        key: "weekly",
        name: "Weekly downloads",
        sync: (ctx: SyncContext<NpmDownloadsCheckpoint, NpmDownloadsConfig>) =>
          this.syncFeed(ctx),
      },
    },
  };

  private async syncFeed(
    ctx: SyncContext<NpmDownloadsCheckpoint, NpmDownloadsConfig>
  ): Promise<SyncResult> {
    const seen = new Set<string>(ctx.checkpoint?.seen_periods ?? []);
    const pkg = ctx.config.package;
    const res = await fetch(
      `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`
    );
    const point = (await res.json()) as {
      downloads?: number;
      start?: string;
      end?: string;
    };
    // One event per never-seen weekly period, keyed by the period end date.
    if (!point.end || seen.has(point.end)) {
      await ctx.commit([], { seen_periods: [...seen] });
      return { status: "complete" };
    }
    await ctx.commit(
      [
        {
          origin_id: `${pkg}@${point.end}`,
          origin_type: "npm_downloads_week",
          title: `${pkg}: ${point.downloads ?? 0} downloads (${point.start} → ${point.end})`,
          payload_text: `${point.downloads ?? 0} weekly npm downloads for ${pkg}.`,
          occurred_at: new Date(point.end),
          metadata: {
            package: pkg,
            downloads: point.downloads ?? 0,
            period_start: point.start,
            period_end: point.end,
          },
        },
      ],
      { seen_periods: [...seen, point.end].slice(-52) }
    );
    return { status: "complete" };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
