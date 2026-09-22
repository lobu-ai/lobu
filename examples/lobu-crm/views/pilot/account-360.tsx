/**
 * Dogfood view: pilot-customer account 360 for the team CRM.
 *
 * Overview card AND full tab on every `pilot` record: the account facts
 * (company, status, seats, MRR, start, success metric) plus the converted-from
 * lead when it resolves. Built for the agent loop: `open_view` returns the
 * frame resource in Claude and a link carrying params everywhere else, so an
 * agent renders this inline or drops it into chat.
 *
 * Reads go through the tool with an `outputSchema` (`manage_entity` get by
 * numeric id; `entity_id` is numeric-only on this contract). No actions: this
 * view is read-only account context.
 */
import {
  defineView,
  mountView,
  tool,
  useHost,
  useQuery,
  useScope,
} from "@lobu/views";

export const view = defineView({
  key: "account-360",
  attach: [
    { type: "pilot", placement: "overview" },
    { type: "pilot", placement: "tab" },
  ],
});

interface EntityRecord {
  id: number;
  name?: string | null;
  slug?: string | null;
  entity_type?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return String(v);
  return "—";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "4px 0",
        borderTop: "1px solid var(--border)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--muted)", minWidth: 110 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function Account360() {
  const scope = useScope();
  const { theme } = useHost();
  const entityId =
    typeof scope.entity === "number" ? scope.entity : Number(scope.entity);
  const scoped = Number.isFinite(entityId) && entityId > 0;

  const pilot = useQuery<{ entity?: EntityRecord }>(
    scoped
      ? tool("manage_entity", { action: "get", entity_id: entityId })
      : null
  );
  const record: EntityRecord | null = pilot.data?.entity ?? null;
  const meta = record?.metadata ?? {};
  const leadId = Number(meta.lead_id);
  const leadScoped = Number.isFinite(leadId) && leadId > 0;
  const lead = useQuery<{ entity?: EntityRecord }>(
    leadScoped
      ? tool("manage_entity", { action: "get", entity_id: leadId })
      : null
  );
  const leadRecord: EntityRecord | null = lead.data?.entity ?? null;

  return (
    <div data-testid="account-360" data-theme={theme} style={{ padding: 12 }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>
          {record ? String(record.name ?? "Account") : "Account 360"}
        </strong>
        <span style={{ color: "var(--muted)" }}>
          {scoped ? `pilot #${entityId}` : "no record in scope"}
        </span>
      </header>

      {!scoped && (
        <div style={{ color: "var(--muted)" }}>
          Open this view on a pilot record to see its account.
        </div>
      )}
      {pilot.loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
      {pilot.error && (
        <div data-testid="pilot-error" style={{ color: "var(--bad)" }}>
          {pilot.error}
        </div>
      )}
      {!pilot.loading && !pilot.error && scoped && !record && (
        <div style={{ color: "var(--muted)" }}>Pilot record not found.</div>
      )}
      {record && (
        <div data-testid="pilot-facts">
          <Fact label="Company" value={str(meta.company)} />
          <Fact label="Status" value={str(record.status ?? meta.status)} />
          <Fact label="Seats" value={str(meta.seats)} />
          <Fact label="MRR" value={str(meta.mrr)} />
          <Fact label="Started" value={str(meta.start_date)} />
          <Fact label="Success metric" value={str(meta.success_metric)} />
        </div>
      )}

      {leadScoped && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 4px" }}>Converted from</h3>
          {lead.loading && (
            <div style={{ color: "var(--muted)" }}>Loading…</div>
          )}
          {lead.error && (
            <div data-testid="lead-error" style={{ color: "var(--bad)" }}>
              {lead.error}
            </div>
          )}
          {!lead.loading && !lead.error && !leadRecord && (
            <div style={{ color: "var(--muted)" }}>
              Lead #{leadId} not found.
            </div>
          )}
          {leadRecord && (
            <div data-testid="lead-facts">
              <Fact
                label="Lead"
                value={String(leadRecord.name ?? `#${leadId}`)}
              />
              <Fact
                label="Status"
                value={str(leadRecord.status ?? leadRecord.metadata?.status)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

mountView(view, Account360);
