import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

export const ActionKeySchema = Type.String({
  pattern: "^[a-z][a-z0-9._-]{0,119}$",
  minLength: 1,
  maxLength: 120,
});

const RESERVED_ACTION_FIELDS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "name",
  "content",
  "slug",
  "parent_id",
]);
const ACTION_FIELD_PATTERN = `^(?!(?:${[...RESERVED_ACTION_FIELDS].join("|")})$)[A-Za-z][A-Za-z0-9_]{0,63}$`;

/** Actions patch declared metadata fields, never entity envelope columns. */
export function isActionFieldName(value: string): boolean {
  return (
    new RegExp(ACTION_FIELD_PATTERN).test(value) &&
    !RESERVED_ACTION_FIELDS.has(value)
  );
}

export const ActionFieldNameSchema = Type.String({
  pattern: ACTION_FIELD_PATTERN,
  not: { enum: [...RESERVED_ACTION_FIELDS] },
  maxLength: 64,
});

const ParamNameSchema = Type.String({
  pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$",
  maxLength: 64,
  not: { enum: ["__proto__", "prototype", "constructor"] },
});

type ActionJsonValue =
  | null
  | boolean
  | number
  | string
  | ActionJsonValue[]
  | { [key: string]: ActionJsonValue };
// Keep literal strings intact through the tool boundary's Value.Convert.
// The registry rejects non-JSON values and enforces size/depth before use.
const JsonValueSchema = Type.Unsafe<ActionJsonValue>(Type.Unknown());

export const ActionInputBindingSchema = Type.Union([
  Type.Object({ param: ParamNameSchema }, { additionalProperties: false }),
  Type.Object({ literal: JsonValueSchema }, { additionalProperties: false }),
  Type.Object(
    { server: Type.Literal("timestamp") },
    { additionalProperties: false }
  ),
]);

export const ActionValueBindingSchema = Type.Union([
  ...ActionInputBindingSchema.anyOf,
  Type.Object({ event: Type.Literal("id") }, { additionalProperties: false }),
]);
export type ActionValueBinding = Static<typeof ActionValueBindingSchema>;

export const ActionDefinitionSchema = Type.Object(
  {
    params: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "A bounded, noncoercing JSON Schema object with additionalProperties:false.",
    }),
    target: Type.Object(
      {
        entityType: Type.String({
          minLength: 1,
          maxLength: 120,
          pattern: "^[A-Za-z][A-Za-z0-9_-]{0,119}$",
        }),
        idParam: ParamNameSchema,
      },
      { additionalProperties: false }
    ),
    invokePermission: Type.Union([
      Type.Literal("write"),
      Type.Literal("admin"),
    ]),
    requiredExpected: Type.Optional(
      Type.Array(ActionFieldNameSchema, { maxItems: 50, uniqueItems: true })
    ),
    set: Type.Record(ActionFieldNameSchema, ActionValueBindingSchema, {
      minProperties: 1,
      maxProperties: 50,
      additionalProperties: false,
    }),
    transition: Type.Optional(
      Type.Object(
        {
          field: ActionFieldNameSchema,
          param: ParamNameSchema,
          allowed: Type.Array(
            Type.Object(
              {
                from: Type.Union([
                  Type.String({ maxLength: 256 }),
                  Type.Null(),
                ]),
                to: Type.Array(Type.String({ maxLength: 256 }), {
                  minItems: 1,
                  maxItems: 50,
                  uniqueItems: true,
                }),
              },
              { additionalProperties: false }
            ),
            { minItems: 1, maxItems: 50 }
          ),
        },
        { additionalProperties: false }
      )
    ),
    emits: Type.Object(
      {
        kind: Type.String({
          pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
          minLength: 1,
          maxLength: 128,
        }),
        schemaVersion: Type.Integer({ minimum: 1 }),
        payload: Type.Record(ParamNameSchema, ActionInputBindingSchema, {
          maxProperties: 50,
          additionalProperties: false,
        }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ActionDefinition = Static<typeof ActionDefinitionSchema>;

export const ActionApplyInputSchema = Type.Object(
  {
    key: ActionKeySchema,
    version: Type.Integer({ minimum: 1 }),
    params: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 50 }),
    expected: Type.Optional(
      Type.Record(ActionFieldNameSchema, Type.Unknown(), {
        maxProperties: 50,
        additionalProperties: false,
      })
    ),
    idempotency_key: Type.String({ minLength: 1, maxLength: 256 }),
    dry_run: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type ActionApplyInput = Static<typeof ActionApplyInputSchema>;

export const ListActionsAction = Type.Object(
  {
    action: Type.Literal("list", {
      description:
        "List registered action types and their current published revisions.",
    }),
  },
  { additionalProperties: false }
);
export const GetActionAction = Type.Object(
  {
    action: Type.Literal("get", {
      description:
        "Get an immutable action definition; omit version to select the current published revision.",
    }),
    key: ActionKeySchema,
    version: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false }
);
export const PublishActionAction = Type.Object(
  {
    action: Type.Literal("publish", {
      description:
        "Publish a new immutable revision of a declarative action definition. Requires workspace admin access.",
    }),
    key: ActionKeySchema,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    definition: ActionDefinitionSchema,
  },
  { additionalProperties: false }
);
export const SetActionEnabledAction = Type.Object(
  {
    action: Type.Literal("set_enabled", {
      description:
        "Enable or disable new invocations of an action type. Completed receipts remain replayable to authorized callers.",
    }),
    key: ActionKeySchema,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false }
);
export const ApplyActionAction = Type.Object(
  {
    action: Type.Literal("apply", {
      description:
        "Invoke a pinned action revision with params, expected metadata and an idempotency key; dry_run validates without committing.",
    }),
    ...ActionApplyInputSchema.properties,
  },
  { additionalProperties: false }
);
export const ValidateActionAction = Type.Object(
  {
    action: Type.Literal("validate", {
      description:
        "Validate a pinned action against current state and permissions, returning a preview without writes, events or receipts.",
    }),
    key: ActionKeySchema,
    version: Type.Integer({ minimum: 1 }),
    params: ActionApplyInputSchema.properties.params,
    expected: ActionApplyInputSchema.properties.expected,
  },
  { additionalProperties: false }
);
export const ManageActionsSchema = Type.Union([
  ListActionsAction,
  GetActionAction,
  PublishActionAction,
  SetActionEnabledAction,
  ApplyActionAction,
  ValidateActionAction,
]);
export type ManageActionsArgs = Static<typeof ManageActionsSchema>;
export type ActionGetInput = ActionInput<ManageActionsArgs, "get">;
export type ActionPublishInput = ActionInput<ManageActionsArgs, "publish">;
export type ActionSetEnabledInput = ActionInput<
  ManageActionsArgs,
  "set_enabled"
>;
export type ActionValidateInput = ActionInput<ManageActionsArgs, "validate">;

const ActionTypeSummarySchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    key: ActionKeySchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    current_version: Type.Integer({ minimum: 0 }),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false }
);

const PublishedActionVersionSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    version: Type.Integer({ minimum: 1 }),
    definition: ActionDefinitionSchema,
  },
  { additionalProperties: false }
);

const ActionResultIdentitySchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    key: ActionKeySchema,
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

// Apply returns only the receipt and declared writeback fields.
const CommittedActionResultSchema = Type.Object(
  {
    created: Type.Boolean(),
    replayed: Type.Boolean(),
    dry_run: Type.Literal(false),
    receipt_id: Type.Integer({ minimum: 1 }),
    action: ActionResultIdentitySchema,
    event_id: Type.Integer({ minimum: 1 }),
    event_type: ActionDefinitionSchema.properties.emits.properties.kind,
    entity: Type.Object(
      {
        id: Type.Integer({ minimum: 1 }),
        metadata: Type.Record(ActionFieldNameSchema, JsonValueSchema, {
          maxProperties: 50,
          additionalProperties: false,
        }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

// Both validate and apply(dry_run:true) return this rollback-only preview.
const ValidatedActionResultSchema = Type.Object(
  {
    dry_run: Type.Literal(true),
    valid: Type.Literal(true),
    action: ActionResultIdentitySchema,
    target_id: Type.Integer({ minimum: 1 }),
    changed_fields: Type.Array(ActionFieldNameSchema, {
      maxItems: 50,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const ManageActionsResultSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("list"),
      actions: Type.Array(ActionTypeSummarySchema),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("get"),
      action_type: ActionTypeSummarySchema,
      version: PublishedActionVersionSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("publish"),
      action_type: ActionTypeSummarySchema,
      version: PublishedActionVersionSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("set_enabled"),
      action_type: ActionTypeSummarySchema,
    },
    { additionalProperties: false }
  ),
  CommittedActionResultSchema,
  ValidatedActionResultSchema,
]);
