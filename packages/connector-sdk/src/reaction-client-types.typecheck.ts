/**
 * @internal Compile-time fixtures pinning the published reaction-client input
 * types to the server schemas they forward to.
 *
 * These types must mirror the `read_knowledge` / `save_memory` /
 * `search_memory` schemas exactly, and the server's `validate-args` rejects
 * any unknown argument. So a field declared here that the schema does not
 * accept is a HARD error for the reaction author, and a schema filter omitted
 * here is a capability they cannot discover.
 *
 * This lives in `src/` rather than beside the tests on purpose: `tsconfig.json`
 * excludes `**\/__tests__/**`, and `bun test` only transpiles, so a compile-time
 * assert written in a test file is never actually checked.
 *
 * The read and search fixtures are keyed on `keyof`, not assignability: every
 * field there is optional, so a stray object structurally extends the type and
 * an accepts/rejects pair passes no matter what the interface declares. The
 * save union does carry required fields, so it is pinned both ways.
 */
import type { PublicGetContentArgs } from "@lobu/core/contracts/tools/read-knowledge";
import type { SaveContentArgs } from "@lobu/core/contracts/tools/save-memory";
import type { PublicSearchArgs } from "@lobu/core/contracts/tools/search-memory";
import type {
  KnowledgeReadInput,
  KnowledgeSaveInput,
  KnowledgeSearchInput,
  ReactionClient,
} from "./reaction-client-types";

type Assert<T extends true> = T;

type HasReadKey<K extends string> = K extends keyof KnowledgeReadInput ? true : false;
type HasSearchKey<K extends string> = K extends keyof KnowledgeSearchInput ? true : false;

export type ReactionKnowledgeReadContract = [
  Assert<HasReadKey<"semantic_type">>,
  Assert<HasReadKey<"entity_types">>,
  Assert<HasReadKey<"query">>,
  Assert<HasReadKey<"entity_id">>,
  Assert<HasReadKey<"before_occurred_at">>,
  Assert<HasReadKey<"before_id">>,
  // `getContent` reads `entity_ids` off the ROW, never off the input, so
  // filtering by it was an `unknown argument(s)` error, not a silent no-op.
  Assert<HasReadKey<"entity_ids"> extends false ? true : false>,
  // Accepted at the REST/tool boundary, never an SDK affordance.
  Assert<HasReadKey<"mcp_activity_id"> extends false ? true : false>,
];

export type ReactionKnowledgeSearchContract = [
  Assert<HasSearchKey<"title">>,
  Assert<HasSearchKey<"content_limit">>,
  Assert<HasSearchKey<"metadata_filter">>,
  Assert<HasSearchKey<"include_public_catalogs">>,
  Assert<HasSearchKey<"workspace">>,
  Assert<HasSearchKey<"parent_id">>,
  Assert<HasSearchKey<"market">>,
  Assert<HasSearchKey<"category">>,
  Assert<HasSearchKey<"include_connections">>,
  Assert<HasSearchKey<"include_content">>,
  // Accepted by the handler but never advertised: a pre-computed vector the
  // content layer re-derives, and the caller's bound agent, resolved from auth
  // context rather than asserted by a client.
  Assert<HasSearchKey<"query_embedding"> extends false ? true : false>,
  Assert<HasSearchKey<"agent_id"> extends false ? true : false>,
];

export type ReactionKnowledgeSaveContract = [
  // Contract fields reach every variant; the phantom `slug` of the old hand copy does not.
  Assert<"payload_data" extends keyof KnowledgeSaveInput ? true : false>,
  Assert<"supersedes_event_id" extends keyof KnowledgeSaveInput ? true : false>,
  Assert<"slug" extends keyof KnowledgeSaveInput ? false : true>,
  Assert<"payload_template" extends keyof KnowledgeSaveInput ? false : true>,
  Assert<{ semantic_type: "note"; payload_type: "json_template" } extends KnowledgeSaveInput ? false : true>,
  // `content` is required only for text/markdown; the old copy demanded it for every payload type.
  Assert<{ semantic_type: "note"; payload_type: "empty" } extends KnowledgeSaveInput ? true : false>,
  Assert<{ semantic_type: "note" } extends KnowledgeSaveInput ? false : true>,
];

/**
 * Exhaustive counterpart to the sampled asserts above. Those name the fields
 * whose loss caused a real defect and say why each matters; this one catches
 * ANY divergence, including a field added to a schema years from now.
 *
 * It needs no upkeep: while these types stay derived it holds by construction,
 * and it fails the moment someone replaces a derivation with a hand-written
 * interface — the regression this whole fixture exists to prevent.
 */
type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type ReactionKnowledgeKeysExhaustive = [
  Assert<ExactKeys<keyof KnowledgeReadInput, keyof PublicGetContentArgs>>,
  Assert<ExactKeys<keyof KnowledgeSearchInput, keyof PublicSearchArgs>>,
  // Every variant of the save union Picks the whole contract, so its `keyof`
  // is the contract's — an omitted field in any one variant fails here.
  Assert<ExactKeys<keyof KnowledgeSaveInput, keyof SaveContentArgs>>,
];

/**
 * The entity methods take the `manage_entity` contract's per-action inputs.
 * These pin the three shapes the hand-written predecessors got wrong:
 *  - `unlink`/`update_link` accept `relationship_id` alone. The triple the old
 *    declaration required does work, so this was undiscoverability, not a
 *    rejection.
 *  - `delete` takes the object form. The positional number the old declaration
 *    advertised was never accepted: the namespace spreads its single argument
 *    into the action payload, so a number arrived as `{}` and failed the
 *    validator on a missing `entity_id`.
 *  - `create` names the field `entity_type`, as the contract does. The runtime
 *    alias table still accepts `type` on the wire; the published type should
 *    not be the place that teaches the alias.
 */
type EntityInput<M extends keyof ReactionClient["entities"]> = Parameters<
  ReactionClient["entities"][M]
>[0];

export type ReactionEntityInputsContract = [
  Assert<{ relationship_id: number } extends EntityInput<"unlink"> ? true : false>,
  Assert<{ relationship_id: number; confidence: number } extends EntityInput<"updateLink"> ? true : false>,
  Assert<{ entity_id: number; dry_run: true } extends EntityInput<"delete"> ? true : false>,
  Assert<number extends EntityInput<"delete"> ? false : true>,
  Assert<{ type: string; name: string } extends EntityInput<"create"> ? false : true>,
  Assert<{ entity_type: string; name: string; domain: string } extends EntityInput<"create"> ? true : false>,
];
