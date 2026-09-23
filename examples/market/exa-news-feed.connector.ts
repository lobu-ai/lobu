// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class ExaNewsFeedConnector extends ConnectorRuntime {
  readonly definition = {
    key: "exa-news-feed",
    name: "Exa news feed",
    version: "1.1.0",
    authSchema: { methods: [{ type: "env_keys" as const, fields: [{ key: "api_key", secret: true }] }] },
    feeds: { articles: { key: "articles", name: "Articles", sync: (ctx: SyncContext) => this.syncFeed(ctx) } },
  };

  private async syncFeed(ctx: SyncContext) {
    const seen = new Set<string>((ctx.checkpoint as any)?.seen_ids ?? []);
    const r = await fetch("https://api.exa.ai/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: ctx.config.query, numResults: ctx.config.num_results ?? 20 }) });
    const fresh: any[] = ((await r.json() as any).results ?? []).filter((x: any) => x.id && !seen.has(x.id));
    await ctx.commit(fresh.map((x) => ({
        origin_id: x.id,
        origin_type: "article_published",
        title: x.title ?? x.url,
        payload_text: x.text ?? x.title ?? x.url,
        author_name: x.author,
        source_url: x.url,
        occurred_at: x.publishedDate ? new Date(x.publishedDate) : new Date(),
      })), { seen_ids: [...seen, ...fresh.map((x) => x.id)].slice(-1000) });
    return { status: 'complete' as const };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
