/**
 * Tool contract: `search_memory`.
 *
 * Lives in core because it crosses package boundaries: the server validates
 * against it, and `@lobu/connector-sdk` derives the input type it publishes to
 * reaction authors. Both derive from this one declaration so neither can drift
 * from the schema the handler actually enforces.
 *
 * Typebox only — no `node:` imports and nothing from core's root index, so the
 * connector isolate lane can bundle it (`packages/connector-sdk/AGENTS.md`).
 */

import { type Static, Type } from "@sinclair/typebox";

export const SearchSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        'Optional human-friendly heading for this result (e.g. "What we know about Acme"). When set, the UI renders it above the search result.',
      maxLength: 200,
    })
  ),
  query: Type.Optional(
    Type.String({
      description:
        'Search saved memory by text or entity name. To open a known memory, event, or content ID, use query: "memory 1234" with include_content: true; do not pass that ID as entity_id. Required unless entity_id is provided.',
      minLength: 1,
    })
  ),
  entity_type: Type.Optional(
    Type.String({
      description:
        "Entity type filter. If not provided, searches all entities.",
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description:
        'Entity ID only, as returned in an entity result. Memory, event, and content IDs are different: use query: "memory 1234" with include_content: true to read those records.',
    })
  ),
  parent_id: Type.Optional(
    Type.Number({
      description: "Filter by parent entity ID.",
    })
  ),
  market: Type.Optional(
    Type.String({
      description: "Market/region code (ISO 3166-1 alpha-2)",
    })
  ),
  category: Type.Optional(
    Type.String({
      description: "Filter by category metadata field",
    })
  ),
  fuzzy: Type.Optional(
    Type.Boolean({
      description: "Enable fuzzy name matching",
      default: true,
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description:
        "Minimum similarity threshold (0.0-1.0) applied to BOTH fuzzy entity-name matching and recalled content. Raise it to cut weak matches, lower it to widen recall.",
      default: 0.3,
      minimum: 0,
      maximum: 1,
    })
  ),
  include_connections: Type.Optional(
    Type.Boolean({
      description:
        "Include connection details in response (max 20, active first)",
      default: true,
    })
  ),
  include_content: Type.Optional(
    Type.Boolean({
      description:
        "Include semantic content search results alongside entity matches (default: true). Uses the query for vector similarity search across all content in the organization.",
      default: true,
    })
  ),
  content_limit: Type.Optional(
    Type.Number({
      description:
        "Max content results when include_content is enabled (default: 5, max: 50)",
      default: 5,
      minimum: 1,
      maximum: 50,
    })
  ),
  query_embedding: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Embedding vector for semantic similarity search. When provided, results are ranked by cosine similarity.",
    })
  ),
  metadata_filter: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Filter entities by metadata key-value pairs (e.g. {"category": "preference"})',
    })
  ),
  agent_id: Type.Optional(
    Type.String({
      description:
        "Scope recalled CONTENT to memory written by this agent — filters events where `metadata.agent_id` matches the given id. Entity resolution is NOT filtered by it: entities are workspace nouns with no writing agent, so scoping them here would report an existing entity as not-found.",
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results (default: 5, max: 100)",
      minimum: 1,
      maximum: 100,
    })
  ),
  include_public_catalogs: Type.Optional(
    Type.Boolean({
      description:
        "Also search public-catalog orgs (visibility=public) — canonical world entities like HMRC, banks, currencies. Defaults to true so agents can discover entities to reference cross-org.",
      default: true,
    })
  ),
  workspace: Type.Optional(
    Type.String({
      description:
        "Narrow this read to one workspace granted to the connection. Omit it on a direct bare OAuth search to search every currently accessible granted workspace.",
      minLength: 1,
      maxLength: 200,
    })
  ),
});

/**
 * Accepted by the handler, but NOT advertised on `tools/list` (see
 * {@link PublicSearchSchema}): `query_embedding` is a pre-computed vector the
 * content-search layer re-derives itself when absent, and `agent_id` is the
 * caller's bound agent, resolved from auth context — a client asserting it
 * cross-agent within an org is a footgun, not an affordance.
 *
 * Naming them keeps the argument validator treating them as VALID while
 * omitting them from the "valid arguments are: …" text of an unknown-argument
 * error; otherwise a mistyped arg teaches an agent that they exist, which is
 * exactly the accepted-but-unadvertised trap this split closes. The server
 * stamps them onto the schema (`markAcceptedInternalFields`) — that call
 * belongs to the runtime validator and stays there. The field NAMES are
 * contract data and belong here, so every consumer subtracts the same set.
 */
export const PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS = [
  "query_embedding",
  "agent_id",
] as const;

/** Schema advertised on `tools/list`. See `ToolDefinition.publicInputSchema`. */
export const PublicSearchSchema = Type.Object(
  Object.fromEntries(
    Object.entries(SearchSchema.properties).filter(
      ([key]) =>
        !(PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS as readonly string[]).includes(
          key
        )
    )
  )
);

export type SearchArgs = Static<typeof SearchSchema>;

/**
 * The `search_memory` input an external caller may actually construct: every
 * declared filter minus the accepted-but-unadvertised internal fields. SDK
 * surfaces that forward straight to `search` derive their input type from this
 * so the declared shape cannot drift from the enforced schema.
 */
export type PublicSearchArgs = Omit<
  SearchArgs,
  (typeof PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS)[number]
>;
