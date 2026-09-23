import {
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface Checkpoint {
  seq: number;
}

/**
 * Managed-connector e2e connector (runs on the LOCAL instance).
 *
 * Declares an `oauth` auth method (managedBy is only valid for OAuth
 * connectors). It holds NO local grant — at sync time the LOCAL instance's
 * `resolveExecutionAuth` detects the connection's `config.managedBy`, fetches a
 * fresh access token from the CLOUD via POST /oauth/connection-token, and hands
 * it to this connector as `ctx.credentials.accessToken`.
 *
 * `sync()` then calls the external mock DATA API with that bearer. The API
 * returns 401 without the exact expected token, so a successful sync that
 * emitted an event is proof the managed token was fetched from the cloud AND
 * actually used upstream. The data is written to the LOCAL Postgres only.
 */
export default class ManagedConnector extends ConnectorRuntime<Checkpoint> {
  readonly definition = {
    key: "managede2e-pulse",
    name: "Managed e2e pulse",
    version: "1.1.0",
    authSchema: {
      methods: [
        {
          type: "oauth" as const,
          provider: "demo",
          requiredScopes: ["read"],
          authorizationUrl: "https://demo.invalid/authorize",
          tokenUrl: "https://demo.invalid/token",
          clientIdKey: "DEMO_CLIENT_ID",
          clientSecretKey: "DEMO_CLIENT_SECRET",
        },
      ],
    },
    feeds: {
      pulse: { key: "pulse", name: "Pulse", sync: this.syncPulse },
    },
  };

  private async syncPulse(ctx: SyncContext<Checkpoint>): Promise<SyncResult> {
    const seq = (ctx.checkpoint?.seq ?? 0) + 1;

    // The managed access token the LOCAL resolver fetched from the cloud.
    const accessToken = ctx.credentials?.accessToken;
    if (!accessToken) {
      // No token resolved → the managed fetch failed. Fail loudly so the e2e
      // sees a failed run rather than a silent empty sync.
      throw new Error("MANAGED_E2E: no access token resolved from the cloud");
    }

    // The data endpoint is injected via the run process env (the forked
    // connector child inherits process.env) so the connector has no hardcoded
    // port. It returns 401 unless the bearer is the exact token the cloud was
    // seeded to mint.
    const dataUrl =
      process.env.MANAGED_E2E_DATA_URL ?? "http://127.0.0.1:8911/items";

    const res = await fetch(dataUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `MANAGED_E2E: data API returned ${res.status} (token rejected upstream)`
      );
    }
    const body = (await res.json()) as {
      items?: Array<{ id: string; text: string }>;
    };
    const items = body.items ?? [];

    await ctx.commit(
      items.map((item) => ({
        origin_id: `${item.id}-${seq}`,
        origin_type: "pulse",
        title: "Managed e2e pulse",
        payload_text: item.text,
        occurred_at: new Date(),
        metadata: { seq, token_prefix: accessToken.slice(0, 8) },
      })),
      { seq }
    );
    return { status: "complete" };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
