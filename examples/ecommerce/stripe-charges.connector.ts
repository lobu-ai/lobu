// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type RuntimeConnectorDefinition, type EventEnvelope, type SyncContext, type SyncResult } from "@lobu/connector-sdk";

interface StripeCharge { id: string; amount: number; currency: string; created: number; refunded: boolean }
interface Checkpoint { last_created: number }

export default class StripeChargesConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "stripe-charges",
    name: "Stripe charges",
    version: "1.1.0",
    // Stripe secret key collected per connection; exposed to sync() as ctx.config.secret_key.
    authSchema: { methods: [{ type: "env_keys", fields: [{ key: "secret_key", label: "Stripe secret key", secret: true, required: true }] }] },
    feeds: { charges: { key: "charges", name: "Charges", sync: (ctx) => this.syncFeed(ctx) } },
  };

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const cursor = ((ctx.checkpoint ?? {}) as Partial<Checkpoint>).last_created ?? 0;
    const secretKey = String(ctx.config.secret_key ?? "");
    const r = await fetch(`https://api.stripe.com/v1/charges?limit=100&created[gt]=${cursor}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${await r.text()}`);
    const data = (((await r.json()) as { data?: StripeCharge[] }).data ?? []).sort((a, b) => a.created - b.created);
    const events: EventEnvelope[] = data.map((c) => ({
      origin_id: c.refunded ? `${c.id}:refund` : c.id,
      origin_type: c.refunded ? "charge_refunded" : "charge_succeeded",
      title: `${c.refunded ? "Refund" : "Charge"} — ${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()}`,
      payload_text: `${c.refunded ? "Refund" : "Charge"} of ${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} (stripe id ${c.id})`,
      source_url: `https://dashboard.stripe.com/payments/${c.id}`,
      occurred_at: new Date(c.created * 1000),
    }));
    await ctx.commit(events, { last_created: data.at(-1)?.created ?? cursor } satisfies Checkpoint);
    return { status: 'complete' };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
