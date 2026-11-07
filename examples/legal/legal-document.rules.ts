import type { EntityWriteRow } from "@lobu/cli/config";

export default function documentRules(row: EntityWriteRow) {
  if (row.op === "create" || Number(row.committed.source_event_id ?? 0) === 0)
    return;
  if (
    [
      "version",
      "counterparty_id",
      "contract_id",
      "source_event_id",
      "available_at",
    ].some(row.changed)
  ) {
    row.deny(
      "An evidenced revision is immutable. Create a new document revision instead."
    );
  }
}
