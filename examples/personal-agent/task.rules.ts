import type { EntityWriteRule } from "@lobu/cli/config";

// A stale extraction or reply cannot silently undo a completed/dismissed task.
// The existing review path still lets a human explicitly reopen it.
const taskRules: EntityWriteRule = (row) => {
  if (!["done", "dismissed"].includes(String(row.committed.status))) return;
  const guardedFields: string[] = [];
  if (
    row.changed("status") &&
    !["done", "dismissed"].includes(String(row.next.status))
  )
    guardedFields.push("status");
  if (row.changed("agent_help") && row.next.agent_help != null)
    guardedFields.push("agent_help");
  if (guardedFields.length > 0) {
    row.escalate(
      guardedFields,
      "This task is closed. Reopening it or offering new agent work requires explicit review."
    );
  }
};

export default taskRules;
