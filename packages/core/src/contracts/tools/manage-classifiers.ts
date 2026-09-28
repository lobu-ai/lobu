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
  description: "[generate_embeddings/delete] Classifier ID",
});
const ClassifierSlug = Type.String({
  description:
    '[classify/apply] Classifier slug (e.g., "sentiment", "bug-severity")',
});
const EmbeddingModel = Type.String({
  description:
    "[create/generate_embeddings/apply] Embedding model to use. Defaults to this deployment's configured model; only set it to work in a different vector space. Label vectors and event vectors must share a model — a classifier embedded under one model matches nothing when applied under another, and `apply` will report every id as not_embedded until the events are embedded under the same model.",
});

export const CreateClassifierAction = Type.Object({
  action: Type.Literal("create", {
    description:
      "Create a classifier. Org-level by default; pass automation_id to scope it to one Automation.",
  }),
  entity_id: Type.Optional(EntityId),
  automation_id: Type.Optional(
    Type.String({
      description:
        "[create] Persisted Automation ID returned by manage_automations (numeric string). OMIT for an org-level classifier — only those are matched by `apply` and the reconciliation job. Pass it only to scope the classifier to a single Automation.",
    })
  ),
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
        examples: Type.Array(Type.String()),
        embedding: Type.Optional(
          Type.Union([Type.Array(Type.Number(), { minItems: 1 }), Type.Null()])
        ),
      },
      { additionalProperties: false }
    ),
    {
      minProperties: 1,
      description:
        "[create] Map of attribute values to descriptions, examples, and optional embeddings.",
    }
  ),
  engine: Type.Optional(
    Type.Union([Type.Literal("embedding"), Type.Literal("service")], {
      description:
        '[create] How `apply` labels content. "embedding" (default): cosine match between label and event vectors. "service": send the event text, label keys, and label descriptions/examples to the classification service at CLASSIFIER_SERVICE_URL (any POST /v1/classify server — classifier.dev, a local model, …). Service classifiers need no embeddings.',
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description:
        '[create] Minimum score to accept a label (default: 0.7). Cosine similarity for engine "embedding", provider confidence for engine "service".',
    })
  ),
  fallback_value: Type.Optional(
    Type.Any({
      description: "[create] Fallback value if no match (default: null)",
    })
  ),
  created_by: Type.Optional(
    Type.String({ description: "[create] Creator identifier" })
  ),
  embedding_model: Type.Optional(EmbeddingModel),
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

export const GenerateClassifierEmbeddingsAction = Type.Object({
  action: Type.Literal("generate_embeddings", {
    description: "Generate/regenerate attribute-value embeddings.",
  }),
  classifier_id: ClassifierId,
  force_regenerate: Type.Optional(
    Type.Boolean({
      description:
        "[generate_embeddings] Force regenerate existing embeddings (default: false)",
    })
  ),
  embedding_model: Type.Optional(EmbeddingModel),
});

export const DeleteClassifierAction = Type.Object({
  action: Type.Literal("delete", {
    description: "Archive a classifier (status -> deprecated).",
  }),
  classifier_id: ClassifierId,
});

export const ClassifyContentAction = Type.Object({
  action: Type.Literal("classify", {
    description: "Manual single/batch classification.",
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
  classifications: Type.Optional(
    Type.Array(
      Type.Object({
        content_id: Type.Number({ description: "Content ID" }),
        value: Type.Union([Type.String(), Type.Null()], {
          description: "Classification value, or null to unset",
        }),
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
        '[classify] Classification source: "llm" (AI-generated) or "user" (manual). Defaults to "user".',
    })
  ),
  reasoning: Type.Optional(
    Type.String({
      description:
        "[classify] Reasoning/justification for the classification(s)",
    })
  ),
});

export const ApplyClassifierAction = Type.Object({
  action: Type.Literal("apply", {
    description:
      "Run a classifier over specific content ids with its engine (embedding match, or the classification service). Re-running re-labels: it replaces the engine's prior results and never touches manual/LLM ones. After editing an embedding classifier, run generate_embeddings first.",
  }),
  classifier_slug: ClassifierSlug,
  content_ids: Type.Array(Type.Number(), {
    minItems: 1,
    maxItems: 2000,
    description:
      "[apply] Content ids to classify. Get them with a read-only SQL query first, then pass them here. Ids outside your organization, without an embedding (embedding engine), or without text (service engine) are skipped and reported — never silently dropped.",
  }),
  embedding_model: Type.Optional(EmbeddingModel),
});

export const ManageClassifiersSchema = Type.Union([
  CreateClassifierAction,
  ListClassifiersAction,
  GenerateClassifierEmbeddingsAction,
  DeleteClassifierAction,
  ClassifyContentAction,
  ApplyClassifierAction,
]);

export type ManageClassifiersArgs = Static<typeof ManageClassifiersSchema>;

export type ClassifierCreateInput = ActionInput<
  ManageClassifiersArgs,
  "create"
>;
export type ClassifierListInput = ActionInput<ManageClassifiersArgs, "list">;
export type ClassifierGenerateEmbeddingsInput = ActionInput<
  ManageClassifiersArgs,
  "generate_embeddings"
>;
export type ClassifierDeleteInput = ActionInput<
  ManageClassifiersArgs,
  "delete"
>;
export type ClassifierClassifyInput = ActionInput<
  ManageClassifiersArgs,
  "classify"
>;
export type ClassifierApplyInput = ActionInput<ManageClassifiersArgs, "apply">;

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
