import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

export const InferenceModalitySchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("image"),
  Type.Literal("stt"),
  Type.Literal("tts"),
]);
export const InferenceCapabilityBlockSchema = Type.Object(
  {
    base_url: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    models_endpoint: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export const InferenceCapabilitiesSchema = Type.Object(
  {
    text: Type.Optional(InferenceCapabilityBlockSchema),
    image: Type.Optional(InferenceCapabilityBlockSchema),
    stt: Type.Optional(InferenceCapabilityBlockSchema),
    tts: Type.Optional(InferenceCapabilityBlockSchema),
  },
  { additionalProperties: false }
);
export type InferenceModality = Static<typeof InferenceModalitySchema>;
export type InferenceCapabilityBlock = Static<
  typeof InferenceCapabilityBlockSchema
>;
export type InferenceCapabilities = Static<typeof InferenceCapabilitiesSchema>;

export const InferenceProviderSlugSchema = Type.String({
  pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
  description:
    "Provider slug: 1–63 lowercase letters, digits or hyphens; no leading/trailing hyphen.",
});
export const ListInferenceProvidersAction = Type.Object(
  {
    action: Type.Literal("list", {
      description:
        "List this organization's inference providers with health metadata; credentials are never returned.",
    }),
  },
  { additionalProperties: false }
);
export const CreateInferenceProviderAction = Type.Object(
  {
    action: Type.Literal("create", {
      description:
        "Add an org-shared API-key provider; the key is stored in the credential vault. OAuth providers sign in interactively instead.",
    }),
    slug: InferenceProviderSlugSchema,
    kind: Type.String({ minLength: 1 }),
    displayName: Type.Optional(Type.String()),
    apiKey: Type.String({ minLength: 1, writeOnly: true }),
    capabilities: Type.Optional(InferenceCapabilitiesSchema),
  },
  { additionalProperties: false }
);
export const UpdateInferenceProviderAction = Type.Object(
  {
    action: Type.Literal("update", {
      description: "Rename a provider; slug and kind are immutable.",
    }),
    slug: InferenceProviderSlugSchema,
    displayName: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export const SetDefaultInferenceProviderAction = Type.Object(
  {
    action: Type.Literal("set_default", {
      description:
        "Make this provider the organization default model source; it needs a text model and an org-shared API key.",
    }),
    slug: InferenceProviderSlugSchema,
  },
  { additionalProperties: false }
);
export const SetInferenceProviderCapabilityAction = Type.Object(
  {
    action: Type.Literal("set_capability", {
      description:
        "Replace one modality's capability block (base_url, model, models_endpoint); other modalities are kept.",
    }),
    slug: InferenceProviderSlugSchema,
    modality: InferenceModalitySchema,
    block: InferenceCapabilityBlockSchema,
  },
  { additionalProperties: false }
);
export const RotateInferenceProviderKeyAction = Type.Object(
  {
    action: Type.Literal("rotate_key", {
      description:
        "Replace the provider's API key in the vault; the value is never echoed or audited.",
    }),
    slug: InferenceProviderSlugSchema,
    value: Type.String({ minLength: 1, writeOnly: true }),
  },
  { additionalProperties: false }
);
export const DeleteInferenceProviderAction = Type.Object(
  {
    action: Type.Literal("delete", {
      description:
        "Soft-delete a provider; if it was the default, the oldest remaining runnable provider is promoted.",
    }),
    slug: InferenceProviderSlugSchema,
  },
  { additionalProperties: false }
);
export const ManageInferenceProvidersSchema = Type.Union([
  ListInferenceProvidersAction,
  CreateInferenceProviderAction,
  UpdateInferenceProviderAction,
  SetDefaultInferenceProviderAction,
  SetInferenceProviderCapabilityAction,
  RotateInferenceProviderKeyAction,
  DeleteInferenceProviderAction,
]);
export type ManageInferenceProvidersArgs = Static<
  typeof ManageInferenceProvidersSchema
>;
export type InferenceProviderCreateInput = ActionInput<
  ManageInferenceProvidersArgs,
  "create"
>;
export type InferenceProviderUpdateInput = ActionInput<
  ManageInferenceProvidersArgs,
  "update"
>;
export type InferenceProviderSetDefaultInput = ActionInput<
  ManageInferenceProvidersArgs,
  "set_default"
>;
export type InferenceProviderSetCapabilityInput = ActionInput<
  ManageInferenceProvidersArgs,
  "set_capability"
>;
export type InferenceProviderRotateKeyInput = ActionInput<
  ManageInferenceProvidersArgs,
  "rotate_key"
>;
export type InferenceProviderDeleteInput = ActionInput<
  ManageInferenceProvidersArgs,
  "delete"
>;

export const InferenceProviderSummarySchema = Type.Object({
  id: Type.Number(),
  slug: Type.String(),
  kind: Type.String(),
  displayName: Type.Union([Type.String(), Type.Null()]),
  capabilities: InferenceCapabilitiesSchema,
  hasCustomUpstream: Type.Boolean(),
  status: Type.String(),
  createdAt: Type.String(),
});
export const InferenceProviderListItemSchema = Type.Object({
  ...InferenceProviderSummarySchema.properties,
  errorMessage: Type.Union([Type.String(), Type.Null()], {
    description: "Most recent terminal provider failure, or null.",
  }),
  updatedAt: Type.String({
    description: "When provider configuration or health last changed.",
  }),
  isDefault: Type.Boolean({
    description: "Whether this row supplies the organization default model.",
  }),
});
export type InferenceProviderListItem = Static<
  typeof InferenceProviderListItemSchema
>;
export const InferenceProviderListResultSchema = Type.Object({
  providers: Type.Array(InferenceProviderListItemSchema),
});
export const InferenceProviderCreateResultSchema = Type.Object({
  provider: Type.Object({
    ...InferenceProviderSummarySchema.properties,
    isDefault: Type.Boolean(),
  }),
});
export const InferenceProviderUpdateResultSchema = Type.Object({
  provider: InferenceProviderSummarySchema,
});
export const InferenceProviderSuccessSchema = Type.Object({
  success: Type.Literal(true),
});
export const InferenceProviderDefaultResultSchema = Type.Object({
  success: Type.Literal(true),
  slug: Type.String(),
  isDefault: Type.Literal(true),
});
export const ManageInferenceProvidersResultSchema = Type.Union([
  InferenceProviderListResultSchema,
  InferenceProviderCreateResultSchema,
  InferenceProviderUpdateResultSchema,
  InferenceProviderDefaultResultSchema,
  InferenceProviderSuccessSchema,
]);
export type InferenceProviderListResult = Static<
  typeof InferenceProviderListResultSchema
>;
export type InferenceProviderCreateResult = Static<
  typeof InferenceProviderCreateResultSchema
>;
export type InferenceProviderUpdateResult = Static<
  typeof InferenceProviderUpdateResultSchema
>;
export type InferenceProviderDefaultResult = Static<
  typeof InferenceProviderDefaultResultSchema
>;
export type InferenceProviderSuccess = Static<
  typeof InferenceProviderSuccessSchema
>;
