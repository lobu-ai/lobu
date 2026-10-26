export interface CaptureSubscription {
  connector_key: string;
  connection_id: number;
  event_types: string[];
}

// Call automations.create with this input only AFTER discovery proves the
// source supports reference capture. No guessed event names or connections.
// This factory never calls trigger, claimNextWindow, feeds.trigger or an agent.
export function captureDefinition(input: {
  slug: string;
  principal: string;
  subscriptions: CaptureSubscription[];
}) {
  if (
    !/^[a-z0-9][a-z0-9-]+$/.test(input.slug) ||
    !input.principal ||
    !input.subscriptions.length
  )
    throw new Error(
      "Explicit capture slug, owning principal and discovered subscriptions required"
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
    slug: input.slug,
    name: "External identity source capture",
    managed_agent_id: input.principal,
    prompt:
      "Capture source references for external clients. Do not execute agents, infer human identities, or copy message bodies.",
    execution_config: { executor: { kind: "external" as const } },
    triggers,
    sources: [
      {
        name: "references",
        query:
          "SELECT id, connector_key, connection_id, origin_id, occurred_at, metadata->>'resource_ref' AS resource_ref, metadata->>'observation_id' AS observation_id FROM events",
      },
    ],
  };
}
