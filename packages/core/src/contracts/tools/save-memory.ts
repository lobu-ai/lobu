/**
 * Tool contract: `save_memory`.
 *
 * Lives in core because it crosses package boundaries: the server validates
 * against it, and `@lobu/connector-sdk` derives the `client.knowledge.save`
 * input it publishes to reaction authors. Both derive from this one
 * declaration so neither can drift from the schema the handler enforces.
 *
 * Typebox only — no `node:` imports and nothing from core's root index, so the
 * connector isolate lane can bundle it (`packages/connector-sdk/AGENTS.md`).
 */

import { type Static, Type } from "@sinclair/typebox";
import type { FlatActionInput } from "./action-input";

export const SaveContentSchema = Type.Object({
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Entity IDs to associate content with. Omit for org-scoped content.",
    })
  ),
  entity_refs: Type.Optional(
    Type.Array(Type.String({ minLength: 3, maxLength: 1024 }), {
      maxItems: 50,
      description:
        "Records of connection-backed (remote) entity types this content is about, as `<type>:<key>` refs (resolve_path returns `ref`). The content then appears in each record's activity. Stored records use entity_ids.",
    })
  ),
  content: Type.Optional(
    Type.String({
      description:
        "The text content to save. Required for text/markdown payload types.",
    })
  ),
  title: Type.Optional(Type.String({ description: "Short title or summary" })),
  author: Type.Optional(
    Type.String({ description: "Author name or identifier" })
  ),
  semantic_type: Type.Optional(
    Type.String({
      description:
        "Semantic type (e.g. note, summary, decision, identity, observation). Preferred.",
    })
  ),
  payload_type: Type.Optional(
    Type.Union(
      [
        Type.Literal("text"),
        Type.Literal("markdown"),
        Type.Literal("json_template"),
        Type.Literal("media"),
        Type.Literal("empty"),
      ],
      {
        description:
          "Content format. 'text' (default): plain text. 'markdown': rendered as rich text. 'json_template': rendered via payload_template + payload_data. 'media': media-focused display. 'empty': metadata only.",
      }
    )
  ),
  payload_data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "Structured data object. Used as template data for json_template, or structured metadata for media.",
    })
  ),
  payload_template: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "JSON template for rendering. Required when payload_type is json_template. Must have a { root: ... } structure.",
    })
  ),
  attachments: Type.Optional(
    Type.Array(Type.Record(Type.String(), Type.Any()), {
      description: "Array of attachment objects (e.g. files, images).",
    })
  ),
  source_url: Type.Optional(
    Type.String({ description: "URL of the original source for this content." })
  ),
  parent_event_id: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Event this content answers. The saved event is threaded under the source and inherits its source_url when one is not supplied.",
    })
  ),
  idempotency_key: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 300,
      description:
        "Stable producer key. Repeating a save with the same key returns the original event instead of appending a duplicate.",
    })
  ),
  occurred_at: Type.Optional(
    Type.String({
      description:
        "When the event actually happened (ISO 8601). Defaults to now if omitted.",
    })
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "Structured metadata, validated against the metadata schema for the selected event kind when non-empty. Omit when no structured metadata is needed; an absent value is treated as {}.",
    })
  ),
  supersedes_event_id: Type.Optional(
    Type.Number({
      description:
        "ID of an existing event this content replaces (e.g. updated preference, corrected fact). The old event is marked as superseded and excluded from future searches.",
    })
  ),
  automation_source: Type.Optional(
    Type.Object(
      {
        automation_id: Type.Number({
          description: "Automation that triggered this save",
        }),
        run_id: Type.Number({
          description: "Automation run that triggered this save",
        }),
      },
      {
        description:
          "Attribution source when save is triggered by an Automation reaction",
      }
    )
  ),
});

export type SaveContentArgs = Static<typeof SaveContentSchema>;

/**
 * `client.knowledge.save` input. The schema leaves every field optional
 * because `saveContent` resolves the requirement per `payload_type`:
 * `semantic_type` always, `content` for text/markdown, `payload_template`
 * for json_template. Stated here once, over the contract's own fields.
 */
type Save<R extends keyof SaveContentArgs = never> = FlatActionInput<
  SaveContentArgs,
  keyof SaveContentArgs,
  "semantic_type" | R
>;

export type SaveContentInput =
  | (Save<"content"> & { payload_type?: "text" | "markdown" })
  | (Save<"payload_template"> & { payload_type: "json_template" })
  | (Save & { payload_type: "media" | "empty" });
