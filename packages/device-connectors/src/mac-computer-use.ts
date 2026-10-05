import type { DeviceConnectorSpec } from "@lobu/connector-sdk";

type Schema = Record<string, unknown>;
type Actions = NonNullable<DeviceConnectorSpec["actions"]>;

/** One optional presentation field across the native surface. Requester
 * identity is authenticated separately and must never come from this text. */
export function withComputerUseStatus(actions: Actions): Actions {
  return Object.fromEntries(
    Object.entries(actions).map(([key, action]) => [
      key,
      {
        ...action,
        inputSchema: {
          ...action.inputSchema,
          properties: {
            ...(action.inputSchema?.properties as Schema | undefined),
            status_message: {
              type: "string",
              maxLength: 160,
              description:
                "Optional agent-provided status shown on this Mac only while this operation runs. Describe the current task; do not include secrets or claim a requester identity.",
            },
          },
        },
      },
    ])
  );
}
const text = { type: "string" };
const number = { type: "number" };
const app = {
  ...text,
  description: "Application name, bundle id, or PID:<pid>.",
};
const element = {
  app,
  snapshot_id: { ...text, description: "Opaque snapshot_id from observe." },
  target: { ...text, description: "Exact element id from that observation." },
};
const position = { x: number, y: number };
const point = {
  type: "object",
  properties: position,
  required: ["x", "y"],
  additionalProperties: false,
};
const gesture = {
  from: point,
  to: point,
  duration_ms: { type: "integer", minimum: 1, maximum: 10000, default: 500 },
  steps: { type: "integer", minimum: 1, maximum: 1000, default: 30 },
  profile: { enum: ["linear", "human"], default: "linear" },
};

function action(
  key: string,
  description: string,
  properties: Schema,
  required: string[]
): Actions[string] {
  return {
    key,
    name: key.replaceAll("_", " "),
    description,
    kind: "write",
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
  };
}

/** Typed native adapters only. Browser, shell and agent execution remain in
 * their existing connectors; these operations never create another runtime. */
export const macComputerUseActions: Actions = Object.fromEntries(
  [
    action(
      "drag",
      "Drag between desktop points, releasing the button and modifiers on completion or failure.",
      {
        ...gesture,
        button: { enum: ["left", "right"], default: "left" },
        modifiers: text,
      },
      ["from", "to"]
    ),
    action(
      "set_value",
      "Set and verify an accessibility element value without typing.",
      { ...element, value: { type: ["string", "boolean", "number"] } },
      ["snapshot_id", "target", "value"]
    ),
    action(
      "perform_action",
      "Invoke a named accessibility action on an observed element, such as AXPress or AXRaise.",
      { ...element, action: text },
      ["snapshot_id", "target", "action"]
    ),
    action(
      "select_text",
      "Select literal text or place the cursor before/after it. Prefix and suffix disambiguate repeated text.",
      {
        ...element,
        text,
        prefix: text,
        suffix: text,
        selection_type: {
          enum: ["text", "cursor_before", "cursor_after"],
          default: "text",
        },
      },
      ["snapshot_id", "target", "text"]
    ),
  ].map((spec) => [spec.key, spec])
);
