// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

interface Checkpoint { last_modified: string }
interface Opportunity { Id: string; Name: string; StageName: string; LastModifiedDate: string }

export default class SalesforcePipelineConnector extends ConnectorRuntime<Checkpoint> {
  readonly definition = {
    key: "salesforce-pipeline",
    name: "Salesforce pipeline",
    version: "1.1.0",
    authSchema: { methods: [{ type: "oauth" as const, provider: "salesforce", requiredScopes: ["api", "refresh_token"] }] },
    feeds: { opportunities: { key: "opportunities", name: "Opportunities", sync: (ctx: SyncContext<Checkpoint>) => this.syncFeed(ctx) } },
  };

  private async syncFeed(ctx: SyncContext<Checkpoint>) {
    const since = ctx.checkpoint?.last_modified ?? "2000-01-01T00:00:00Z";
    const q = `SELECT Id,Name,StageName,LastModifiedDate FROM Opportunity WHERE LastModifiedDate > ${since} LIMIT 200`;
    const r = await fetch(`${ctx.config.instance_url}/services/data/v60.0/query?q=${encodeURIComponent(q)}`);
    const records = ((await r.json()) as { records?: Opportunity[] }).records ?? [];
    await ctx.commit(records.map((o) => ({
        origin_id: o.Id,
        origin_type: "opportunity_updated",
        title: `${o.Name} → ${o.StageName}`,
        payload_text: `${o.Name} moved to ${o.StageName}`,
        occurred_at: new Date(o.LastModifiedDate),
      })), { last_modified: records.at(-1)?.LastModifiedDate ?? since });
    return { status: 'complete' as const };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
