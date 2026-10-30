/** Native Lobu identity nodes. IDs select permission-checked records; they are
 * never trusted display data. The JSON vocabulary remains surface-specific. */
export type ReferenceAppearance = "inline" | "row";

export interface ReferenceSnapshot {
  mode: "snapshot";
  label: string;
  description?: string;
  capturedAt?: string;
}

interface LiveReference {
  mode: "live";
  workspace: string;
  appearance?: ReferenceAppearance;
}

export type AutomationReferenceProps =
  | ReferenceSnapshot
  | (LiveReference & {
      automationId: string;
    });
export type ConnectorReferenceProps =
  | ReferenceSnapshot
  | (LiveReference & {
      connectorKey: string;
      connectionId?: number;
    });
export type AgentReferenceProps =
  | ReferenceSnapshot
  | (LiveReference & {
      agentId: string;
    });

export interface NativeReferenceProps {
  "automation-ref": AutomationReferenceProps;
  "connector-ref": ConnectorReferenceProps;
  "agent-ref": AgentReferenceProps;
}
export type NativeReferenceKind = keyof NativeReferenceProps;

function bounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

/** Validate AFTER template bindings resolve, copying only supported props.
 * Extra authored display labels, links, callbacks and statuses are discarded.
 * Invalid selectors fail closed without sending a request. */
export function parseNativeReference<K extends NativeReferenceKind>(
  kind: K,
  input: unknown
): NativeReferenceProps[K] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  if (p.mode === "snapshot") {
    if (
      !bounded(p.label, 256) ||
      (p.description !== undefined && !bounded(p.description, 2000)) ||
      (p.capturedAt !== undefined && !bounded(p.capturedAt, 128))
    )
      return null;
    return {
      mode: "snapshot",
      label: p.label,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.capturedAt !== undefined ? { capturedAt: p.capturedAt } : {}),
    } as NativeReferenceProps[K];
  }
  if (
    p.mode !== "live" ||
    !bounded(p.workspace, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(p.workspace) ||
    (p.appearance !== undefined &&
      p.appearance !== "inline" &&
      p.appearance !== "row")
  )
    return null;
  const common = {
    mode: "live" as const,
    workspace: p.workspace,
    appearance: (p.appearance ?? "row") as ReferenceAppearance,
  };
  if (kind === "automation-ref") {
    if (
      !bounded(p.automationId, 128) ||
      !/^[1-9][0-9]*$/.test(p.automationId) ||
      !Number.isSafeInteger(Number(p.automationId))
    )
      return null;
    return {
      ...common,
      automationId: p.automationId,
    } as NativeReferenceProps[K];
  }
  if (kind === "connector-ref") {
    if (
      !bounded(p.connectorKey, 128) ||
      (p.connectionId !== undefined &&
        (typeof p.connectionId !== "number" ||
          !Number.isSafeInteger(p.connectionId) ||
          p.connectionId <= 0))
    )
      return null;
    return {
      ...common,
      connectorKey: p.connectorKey,
      ...(p.connectionId !== undefined ? { connectionId: p.connectionId } : {}),
    } as NativeReferenceProps[K];
  }
  if (!bounded(p.agentId, 128)) return null;
  return { ...common, agentId: p.agentId } as NativeReferenceProps[K];
}
