import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

// ============================================
// Typebox Schema (union of per-action variants)
// ============================================
//
// The wire schema flattens this union into ONE MCP object and merges duplicate
// properties first-occurrence-wins, so a property carried by more than one
// variant must read true for every one of them.

const EntityId = Type.Number({
  description:
    "[create/list] Entity ID to scope classifiers (global if omitted)",
});
const ClassifierId = Type.Number({
  description: "[delete] Classifier ID",
});
const ClassifierSlug = Type.String({
  description: '[classify] Classifier slug (e.g., "sentiment", "bug-severity")',
});
const Confidence = Type.Union(
  [Type.Number({ minimum: 0, maximum: 1 }), Type.Null()],
  {
    description:
      "[classify] Confidence in the value, 0..1. Omitted or null: unscored for an 'llm' label, 1 for a 'user' label",
  }
);

export const CreateClassifierAction = Type.Object({
  action: Type.Literal("create", {
    description:
      "Create a classifier: the label schema that `classify` writes against.",
  }),
  entity_id: Type.Optional(EntityId),
  slug: Type.String({
    description: '[create] Unique identifier (e.g., "sentiment", "quality")',
  }),
  name: Type.String({ description: "[create] Display name" }),
  description: Type.Optional(
    Type.String({ description: "[create] Classifier description" })
  ),
  attribute_key: Type.String({
    description: '[create] Key in content classifications (e.g., "sentiment")',
  }),
  attribute_values: Type.Record(
    Type.String({ minLength: 1 }),
    Type.Object(
      {
        description: Type.String(),
        examples: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false }
    ),
    {
      minProperties: 1,
      description:
        "[create] Map of attribute values to descriptions and examples.",
    }
  ),
  created_by: Type.Optional(
    Type.String({ description: "[create] Creator identifier" })
  ),
});

export const ListClassifiersAction = Type.Object({
  action: Type.Literal("list", {
    description: "List classifiers with filters.",
  }),
  entity_id: Type.Optional(EntityId),
  status: Type.Optional(
    Type.String({
      description:
        "[list] Filter by status. Defaults to 'active' (deprecated classifiers are excluded). Pass 'deprecated' to see archived ones, or 'all' to list every classifier regardless of status.",
    })
  ),
});

export const DeleteClassifierAction = Type.Object({
  action: Type.Literal("delete", {
    description: "Archive a classifier (status -> deprecated).",
  }),
  classifier_id: ClassifierId,
});

export const ClassifyContentAction = Type.Object({
  action: Type.Literal("classify", {
    description:
      "Write labels (single or batch). The only way labels are written: an Automation labels events by calling this with source 'llm'. A null value removes your label for that content.",
  }),
  classifier_slug: ClassifierSlug,
  content_id: Type.Optional(
    Type.Number({
      description: "[classify] Content ID to update (single mode)",
    })
  ),
  value: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "[classify] Classification value for single update, or null to unset",
    })
  ),
  confidence: Type.Optional(Confidence),
  classifications: Type.Optional(
    Type.Array(
      Type.Object({
        content_id: Type.Number({ description: "Content ID" }),
        value: Type.Union([Type.String(), Type.Null()], {
          description: "Classification value, or null to unset",
        }),
        confidence: Type.Optional(Confidence),
        reasoning: Type.Optional(
          Type.String({
            description: "Reasoning/justification for this classification",
          })
        ),
      }),
      {
        description:
          "[classify] Array of classifications to update (batch mode)",
      }
    )
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("llm"), Type.Literal("user")], {
      description:
        '[classify] Classification source: "llm" (AI-generated) or "user" (manual). Defaults to "user" for a person and "llm" for an Automation or agent, which cannot write "user". Only "user" labels are manual, and they win over "llm" labels at read time.',
    })
  ),
  reasoning: Type.Optional(
    Type.String({
      description:
        "[classify] Reasoning/justification for the classification(s)",
    })
  ),
});

export const ManageClassifiersSchema = Type.Union([
  CreateClassifierAction,
  ListClassifiersAction,
  DeleteClassifierAction,
  ClassifyContentAction,
]);

export type ManageClassifiersArgs = Static<typeof ManageClassifiersSchema>;

export type ClassifierCreateInput = ActionInput<
  ManageClassifiersArgs,
  "create"
>;
export type ClassifierListInput = ActionInput<ManageClassifiersArgs, "list">;
export type ClassifierDeleteInput = ActionInput<
  ManageClassifiersArgs,
  "delete"
>;
export type ClassifierClassifyInput = ActionInput<
  ManageClassifiersArgs,
  "classify"
>;

/**
 * Result of `manage_classifiers`. TypeBox-first: `Static<>` derives the TS type
 * from the same schema exposed as the tool's `outputSchema`. `data` is an
 * arbitrary payload (varies by action) so it's honestly `unknown`.
 */
export const ManageClassifiersResultSchema = Type.Object({
  success: Type.Boolean(),
  action: Type.String(),
  message: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
});
export type ManageClassifiersResult = Static<
  typeof ManageClassifiersResultSchema
>;
