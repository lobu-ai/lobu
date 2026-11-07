import type { EntityWriteRow } from "@lobu/cli/config";

export default function guidanceRules(row: EntityWriteRow) {
  const approved = row.next.status === "approved";
  if (
    approved &&
    (!Array.isArray(row.next.source_event_ids) ||
      row.next.source_event_ids.length === 0)
  ) {
    row.deny("Approved guidance needs source evidence.");
  }
  if (
    approved &&
    (row.op === "create" ||
      Object.keys({ ...row.committed, ...row.next }).some(row.changed))
  ) {
    row.escalate(
      "status",
      "Counsel must approve this exact guidance and its applicability before reuse."
    );
  }
}
