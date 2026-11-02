/** Recognize accepted approvals without treating them as completed writes. */
export function isPendingToolApproval(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    result.status === "pending_approval" || result.approval_queued === true
  );
}

/** Interpret legacy application result values; protocol errors stay with their transport. */
export function getToolResultFailure(
  actionName: string,
  value: unknown
): { message: string; result: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const hasError = result.error !== undefined && result.error !== null;
  const summary =
    result.summary &&
    typeof result.summary === "object" &&
    !Array.isArray(result.summary)
      ? (result.summary as Record<string, unknown>)
      : null;
  const allAggregateItemsFailed =
    typeof summary?.failed === "number" &&
    summary.failed > 0 &&
    summary.successful === 0;
  // Some mutation policies return `success:false` while durably queueing an
  // approval. That is a non-terminal accepted outcome, not a business failure;
  // callers need its approval URL/run id to continue the workflow.
  const acceptedForApproval = isPendingToolApproval(result);
  const reportsFailure =
    !acceptedForApproval &&
    (result.success === false ||
      result.ok === false ||
      result.status === "failed" ||
      result.status === "error" ||
      result.status === "timeout" ||
      allAggregateItemsFailed);
  if (!hasError && !reportsFailure) return null;
  const failedItem = Array.isArray(result.results)
    ? result.results.find(
        (item): item is Record<string, unknown> =>
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).success === false
      )
    : undefined;

  const candidates = [
    result.error,
    result.error_message,
    result.message,
    result.reason,
    failedItem?.error,
    failedItem?.error_message,
    failedItem?.message,
    failedItem?.reason,
  ];
  const message = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0
  );
  return {
    message: message?.trim() ?? `Action '${actionName}' failed`,
    result,
  };
}
