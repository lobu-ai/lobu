export interface CaptureSubscription {
  connector_key: string;
  connection_id: number;
  event_types: string[];
}

// Update an installed legacy capture binding only after discovery and consent.
// New external authoring is retired; this helper cannot create a replacement.
// It never triggers work, claims a window or starts an agent.
export function captureDefinition(input: {
  existing: {
    automation_id: string;
    managed_agent_id?: string | null;
    execution_config?: { executor?: { kind?: string } } | null;
  };
  subscriptions: CaptureSubscription[];
}) {
  if (
    !Number.isSafeInteger(Number(input.existing.automation_id)) ||
    Number(input.existing.automation_id) <= 0 ||
    input.existing.execution_config?.executor?.kind !== "external" ||
    !input.existing.managed_agent_id ||
    !input.subscriptions.length
  )
    throw new Error(
      "An installed legacy capture binding, owning principal and discovered subscriptions are required"
    );
  const seen = new Set<string>();
  const triggers = input.subscriptions.map((source) => {
    if (
      !source.connector_key ||
      !Number.isSafeInteger(source.connection_id) ||
      source.connection_id <= 0 ||
      !source.event_types.length ||
      source.event_types.some((event) => !event.trim())
    )
      throw new Error("Invalid discovered subscription");
    const key = `${source.connector_key}:${source.connection_id}`;
    if (seen.has(key))
      throw new Error(
        "Duplicate source subscription; combine its discovered event names"
      );
    seen.add(key);
    return {
      kind: "event" as const,
      source: "connector" as const,
      connector_key: source.connector_key,
      connection_id: source.connection_id,
      event_types: [...new Set(source.event_types)],
      capture: "references" as const,
      output: "silent" as const,
    };
  });
  return {
    automation_id: input.existing.automation_id,
    managed_agent_id: input.existing.managed_agent_id,
    triggers,
  };
}
