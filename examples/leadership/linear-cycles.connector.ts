// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

const QUERY = `query($t:ID!,$a:DateTimeOrDuration!){issues(first:100,filter:{team:{id:{eq:$t}},updatedAt:{gt:$a},cycle:{isActive:{eq:true}}},orderBy:updatedAt){nodes{id identifier title url updatedAt state{name}}}}`;

export default class LinearCyclesConnector extends ConnectorRuntime {
  readonly definition = {
    key: "linear-cycles",
    name: "Linear cycles",
    version: "1.1.0",
    authSchema: { methods: [{ type: "oauth" as const, provider: "linear", requiredScopes: ["read"] }] },
    feeds: { cycle_issues: { key: "cycle_issues", name: "Cycle issues", sync: (ctx: SyncContext) => this.syncFeed(ctx) } },
  };

  private async syncFeed(ctx: SyncContext) {
    const since = (ctx.checkpoint as any)?.updated_at ?? "2000-01-01T00:00:00Z";
    const r = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: QUERY, variables: { t: ctx.config.team_id, a: since } }) });
    const issues: any[] = ((await r.json()) as any).data?.issues?.nodes ?? [];
    await ctx.commit(issues.map((i) => ({
        origin_id: `${i.id}:${i.state.name}`,
        origin_type: "issue_state_changed",
        title: `${i.identifier} ${i.title} → ${i.state.name}`,
        payload_text: `${i.identifier} ${i.title} is now ${i.state.name}`,
        source_url: i.url,
        occurred_at: new Date(i.updatedAt),
      })), { updated_at: issues.at(-1)?.updatedAt ?? since });
    return { status: 'complete' as const };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
