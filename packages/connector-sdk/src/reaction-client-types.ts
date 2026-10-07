/**
 * Type declarations for Automation reaction scripts.
 *
 * Reaction scripts run inside an isolated-vm sandbox where `client` is a
 * Proxy that dispatches calls to the host. You can't import real packages
 * at runtime, but you CAN use these types for editor autocompletion.
 *
 * Usage:
 *   import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
 *
 *   export default async (ctx: ReactionContext, client: ReactionClient) => {
 *     await client.knowledge.save({ content: "...", semantic_type: "digest" });
 *   };
 */
// Type-only imports: they erase at compile time, so nothing new enters the
// isolate bundle. Core SUBPATH imports are permitted here; the root is not
// (see AGENTS.md).
import type { DeleteContentArgs } from "@lobu/core/contracts/tools/delete-knowledge";
import type { ConnectionListInput } from "@lobu/core/contracts/tools/manage-connections";
import type {
  EntityCreateInput,
  EntityDeleteInput,
  EntityDiscoverDuplicatesInput,
  EntityDiscoverDuplicatesResult,
  EntityGetInput,
  EntityLinkInput,
  EntityListInput,
  EntityListLinksInput,
  EntityUnlinkInput,
  EntityUpdateInput,
  EntityUpdateLinkInput,
} from "@lobu/core/contracts/tools/manage-entity";
import type {
  OperationExecuteInput,
  OperationListAvailableInput,
  OperationListRunsInput,
} from "@lobu/core/contracts/tools/manage-operations";
import type { PublicGetContentArgs } from "@lobu/core/contracts/tools/read-knowledge";
import type { SaveContentInput } from "@lobu/core/contracts/tools/save-memory";
import type { PublicSearchArgs } from "@lobu/core/contracts/tools/search-memory";
import type {} from "./reaction-client-types.typecheck";

/**
 * A rich card for chat delivery, as a plain serializable object — a `chat`
 * `CardElement` built with the card primitives (`Card`, `Section`, `Field`,
 * `Actions`, `Button`, `Select`, …). Typed loosely here so the SDK's published
 * declarations don't force consumers to install `chat`; the gateway validates
 * and renders it to each platform's native format (Block Kit / Adaptive Cards /
 * Google Chat Cards).
 */
export type CardElement = Record<string, unknown>;

// ── Knowledge ────────────────────────────────────────────────────────────────

/**
 * Derived from the `search_memory` contract rather than re-declared: the
 * hand-written copy listed 6 of the 16 filters the handler accepts, so ten
 * were undiscoverable from the published types. Pinned by
 * `ReactionKnowledgeSearchContract` in `./reaction-client-types.typecheck`.
 */
export type KnowledgeSearchInput = PublicSearchArgs;

/**
 * The `save_memory` contract's own input, from core. The hand-written copy
 * lacked `payload_data`, `payload_template` and `attachments`, required
 * `content` for every payload type, and advertised a `slug` field the server
 * rejects as an unknown argument. Pinned by `ReactionKnowledgeSaveContract`
 * in `./reaction-client-types.typecheck`.
 */
export type KnowledgeSaveInput = SaveContentInput;

/** Tombstone by id, or by the `delete_knowledge` contract's `content_id(s)` + `reason`. */
export type KnowledgeDeleteInput = number | DeleteContentArgs;

/**
 * Derived from the `read_knowledge` contract rather than re-declared. The
 * hand-written copy named 6 of the 36 filters the handler accepts, hiding 30
 * (`semantic_type`, `entity_types`, `query`, `entity_id`, cursor pagination,
 * …), and its seventh field was `entity_ids`, which `getContent` only ever
 * reads off the ROW — never off the input — so filtering by it was a hard
 * `unknown argument(s)` error from the server's argument validator. Pinned by
 * `ReactionKnowledgeReadContract` in `./reaction-client-types.typecheck`.
 */
export type KnowledgeReadInput = PublicGetContentArgs;

export interface KnowledgeSaveResult {
  id: number;
  created: boolean;
  metadata: Record<string, unknown>;
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface NotificationsSendInput {
  /** Notification title (≤200 chars). */
  title: string;
  /** Body text (≤1000 chars). */
  body?: string;
  /**
   * Optional rich card built with the `chat` card primitives (`Card`,
   * `Section`, `Field`, `Actions`, `Button`, `Select`, …). When set,
   * bot-connection delivery posts this card — rendered to each platform's
   * native format (Slack Block Kit, Teams Adaptive Cards, Google Chat Cards) —
   * instead of the markdown body; the in-app inbox entry still uses title/body.
   */
  card?: CardElement;
  /**
   * Who to notify. `"admins"` (default): org admins/owners. `"all"`: every
   * member. Or an array of specific user IDs.
   */
  recipients?: "admins" | "all" | string[];
  /** Relative URL the notification links to (e.g. `/acme/entities`). */
  resource_url?: string;
  /** HTTP(S) page a browser-side notification action should open in the current user tab. */
  browser_url?: string;
  /** Page-activated operation run that will populate browser_url when visited. */
  browser_handoff_run_id?: number;
  /** Stable producer key used to collapse retried sends. */
  idempotency_key?: string;
  /** Deliver only through this specific bot connection (its id). */
  connection_id?: string;
  /**
   * Structured payload. With `semantic_type`, this becomes the event's render
   * data (bound to the kind's `jsonTemplate` in the Memory view) instead of
   * being appended to the body. Without `semantic_type`, it is stored in the
   * notification body as formatted JSON (legacy).
   */
  data?: Record<string, unknown>;
  /**
   * Event semantic type (kind) for the notification's content, validated
   * against the org's `$member.event_kinds`. When set, the notification
   * renders through the event-kind pipeline: `data` feeds the kind's
   * `jsonTemplate` in the Memory/Events view, and the inbox keeps the
   * markdown `body`. Mutually exclusive with `input_schema`.
   */
  semantic_type?: string;
  /** Attribution when sent from an automation reaction. */
  automation_source?: { automation_id: number; run_id: number };
  /**
   * Turn the notification into a human question on the existing approval rail.
   * `{}` is a binary Approve/Reject decision; a field-shaped schema renders a
   * form. Rejection can carry a reason through the standard reject action.
   */
  input_schema?: Record<string, unknown>;
}

export interface NotificationsSendResult {
  notified_count: number;
  /** Durable notification event, including on an idempotent replay. */
  event_id: number | null;
  /** Server-produced notification permalink. */
  url: string | null;
  /** Present for input_schema asks; poll/read this run for the answer. */
  run_id?: number;
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * The client object available in reaction scripts.
 *
 * `client.knowledge`     — read/write/search knowledge events
 * `client.entities`      — CRUD entities and relationships
 * `client.connections`   — list/get configured connections (server-computed device liveness)
 * `client.notifications` — push a notification to the org's inbox + bot connections (Slack/Telegram)
 * `client.query`         — raw SQL (results as JSON rows)
 * `client.log`           — structured logging (appears in Automation run logs)
 */
export interface ReactionClient {
  knowledge: {
    search(input: KnowledgeSearchInput): Promise<unknown>;
    save(input: KnowledgeSaveInput): Promise<KnowledgeSaveResult>;
    read(input: KnowledgeReadInput): Promise<unknown>;
    delete(input: KnowledgeDeleteInput): Promise<unknown>;
  };

  entities: {
    discoverDuplicates(input: EntityDiscoverDuplicatesInput): Promise<EntityDiscoverDuplicatesResult>;
    list(filter?: EntityListInput): Promise<unknown>;
    get(input: EntityGetInput): Promise<unknown>;
    create(input: EntityCreateInput): Promise<{ id: number }>;
    update(input: EntityUpdateInput): Promise<unknown>;
    delete(input: EntityDeleteInput): Promise<unknown>;
    link(input: EntityLinkInput): Promise<unknown>;
    unlink(input: EntityUnlinkInput): Promise<unknown>;
    updateLink(input: EntityUpdateLinkInput): Promise<unknown>;
    listLinks(input: EntityListLinksInput): Promise<unknown>;
    search(query: string, options?: { limit?: number }): Promise<unknown>;
  };

  connections: {
    /** List configured connections; `device_online` is computed server-side. */
    list(input?: ConnectionListInput): Promise<unknown>;
    get(connection_id: number): Promise<unknown>;
  };

  notifications: {
    /**
     * Send a notification: writes it to the org inbox and fans it out to the
     * org's active bot connections (Slack/Telegram). This is how a reaction
     * surfaces its digest to a chat channel.
     */
    send(input: NotificationsSendInput): Promise<NotificationsSendResult>;
  };

  /**
   * Run a connection's operations (connector actions / MCP tools) on demand.
   * Reactions run in the Automation's system context, so they may execute
   * operations the agent itself can't call in-turn — e.g. driving the paired
   * Owletto Chrome extension via a connector action. Pass `automation_source` for
   * run attribution back to the firing window.
   */
  operations: {
    /** List the operations available on a connection (or the whole org). */
    listAvailable(input?: OperationListAvailableInput): Promise<unknown>;
    /** Read operational runs, including questions and staged connector actions. */
    listRuns(input?: OperationListRunsInput): Promise<{
      runs: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    }>;
    /** Read one durable run and its completed answer/rejection state. */
    getRun(run_id: number): Promise<{ run: Record<string, unknown> }>;
    /** Execute one operation and wait for its result; device operations with `background: true` return the queued `run_id` instead. */
    execute(input: OperationExecuteInput): Promise<{
      status?:
        | "completed"
        | "failed"
        | "timeout"
        | "pending_approval"
        | "in_progress";
      output?: Record<string, unknown>;
      error_message?: string;
      run_id?: number;
    }>;
  };

  /** Run a read-only SQL query against the org's Postgres. */
  query(sql: string): Promise<unknown[]>;

  /** Structured log — appears in the Automation run output. */
  log(message: string, data?: Record<string, unknown>): void;
}
