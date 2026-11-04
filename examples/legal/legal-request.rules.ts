import type { EntityWriteRow } from "@lobu/cli/config";

export default function requestRules(row: EntityWriteRow) {
  if (row.op === "create") {
    if (row.next.status !== "new")
      row.deny("New requests must enter intake first.");
    return;
  }
  if (
    ["counterparty_id", "contract_id"].some(
      (field) => Number(row.committed[field] ?? 0) > 0 && row.changed(field)
    )
  )
    row.deny("Use a new request for another counterparty or agreement.");
  if (
    row.changed("current_document_id") &&
    Number(row.committed.current_document_id ?? 0) > 0
  ) {
    if (
      row.next.status !== "new" ||
      Number(row.next.review_event_id ?? 0) !== 0
    ) {
      row.deny(
        "A new document must reopen intake and clear the current review."
      );
    }
  }
  if (
    ["review_event_id", "review_document_id"].some(row.changed) &&
    Number(row.next.review_event_id) > 0 &&
    row.next.review_document_id !== row.next.current_document_id
  ) {
    row.deny(
      "The document changed during review. Review its current revision again."
    );
  }
  if (
    ["last_decision_id", "decision_document_id", "decision_review_id"].some(
      row.changed
    ) &&
    Number(row.next.last_decision_id) > 0
  ) {
    if (
      row.next.decision_document_id !== row.committed.current_document_id ||
      row.next.decision_review_id !== row.committed.review_event_id
    ) {
      row.deny("This decision belongs to an older document or review.");
    }
  }
  if (
    row.changed("status") &&
    ["approved", "negotiating", "escalated"].includes(
      String(row.next.status)
    ) &&
    !row.changed("last_decision_id")
  ) {
    row.deny(
      "Apply a decision to the current review before changing its outcome."
    );
  }
}
