// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class QuickBooksTransactionsConnector extends ConnectorRuntime {
  readonly definition = {
    key: "quickbooks-transactions",
    name: "QuickBooks transactions",
    version: "1.1.0",
    authSchema: { methods: [{ type: "oauth" as const, provider: "intuit", requiredScopes: ["com.intuit.quickbooks.accounting"] }] },
    feeds: { transactions: { key: "transactions", name: "Posted transactions", sync: (ctx: SyncContext) => this.syncFeed(ctx) } },
  };

  private async syncFeed(ctx: SyncContext) {
    const since = (ctx.checkpoint as any)?.last_txn_date ?? "1970-01-01";
    const q = `SELECT * FROM Transaction WHERE TxnDate > '${since}' ORDERBY TxnDate ASC MAXRESULTS 500`;
    const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${ctx.config.realm_id}/query?query=${encodeURIComponent(q)}`);
    const txns: any[] = (await r.json() as any).QueryResponse?.Transaction ?? [];
    await ctx.commit(txns.map((t) => ({
        origin_id: t.Id,
        origin_type: "transaction_posted",
        title: `${t.AccountRef?.name ?? "Bank"} — $${t.Amount.toFixed(2)}`,
        payload_text: `${t.AccountRef?.name ?? "Bank"} transaction for $${t.Amount.toFixed(2)} on ${t.TxnDate}`,
        occurred_at: new Date(`${t.TxnDate}T00:00:00Z`),
      })), { last_txn_date: txns.at(-1)?.TxnDate ?? since });
    return { status: 'complete' as const };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
