#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type BaseMessage, createLogger } from "@lobu/core";
import type {
  ApprovalAttribution,
  InteractionResourceKind,
} from "@lobu/core/contracts/interaction-envelope";

const logger = createLogger("interactions");

const SAFE_LINK_BUTTON_SCHEMES = new Set(["http:", "https:"]);

/**
 * Reject URLs whose scheme could be used to execute code in the user's
 * client (e.g. `javascript:`, `data:`, `vbscript:`, `file:`) when posted
 * as a link button. We only accept normal web URLs.
 */
export function assertSafeLinkButtonUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid link button URL: ${url}`);
  }
  if (!SAFE_LINK_BUTTON_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Refusing to post link button with unsafe scheme: ${parsed.protocol}`
    );
  }
}

/**
 * Refuse to post a chat-platform interaction event without a non-empty
 * `connectionId`.
 *
 * For chat platforms, `connectionId` is the routing key that prevents
 * cross-tenant / cross-connection event leakage: the interaction bridge's
 * `shouldHandle` filter would otherwise fall through when
 * `event.connectionId` is falsy. Fail closed at post-time so a missing
 * connection id surfaces as an error rather than silently routing to the
 * wrong tenant.
 *
 * `platform: "api"` is exempt: API sessions have no Chat SDK connection at
 * all — their cards are routed by `conversationId` through the API
 * platform's own `event.platform === "api"` subscriptions, and the bridge's
 * `shouldHandle` drops foreign-platform events (`event.platform` check), so
 * there is no bridge to leak through. Requiring a connectionId here is what
 * silently broke ask_user/tool-approval for every API/SPA session (#847).
 */
export function assertRoutableInteraction(
  connectionId: string | undefined,
  platform: string,
  kind: string
): void {
  if (platform === "api") return;
  if (!connectionId) {
    throw new Error(
      `Refusing to post ${kind}: connectionId is required to prevent cross-platform event leakage`
    );
  }
}

interface PostedInteraction extends BaseMessage {
  /** Request that produced this card; distinct from the interaction's own id. */
  turnMessageId?: string;
}

/**
 * Payload emitted on "question:created" — platform renderers listen for this.
 */
export interface PostedQuestion extends PostedInteraction {
  userId: string;
  platform: string;
  question: string;
  options: string[];
}

/**
 * Payload emitted on "suggestion:created" — platform renderers listen for this.
 *
 * Suggested follow-up actions rendered as tappable chips under a reply. Unlike
 * `PostedQuestion`, tapping one does NOT answer a blocked turn: nothing is
 * waiting on the click, and the chip's `message` is sent verbatim as a new user
 * turn. That is why each option carries both a short `title` (the button label)
 * and a full `message` (what actually gets sent) rather than a single string —
 * the label is a summary, not the payload.
 */
export interface PostedSuggestion extends PostedInteraction {
  organizationId: string;
  userId: string;
  platform: string;
  prompts: Array<{ title: string; message: string }>;
}

/**
 * Payload emitted on "link-button:created" — platform renderers listen for this.
 *
 * `body`: optional explanatory text shown above the button inside the card.
 * Leave undefined when the button label alone is self-explanatory — the
 * renderer will skip the card-body text entirely rather than duplicate the
 * button's own label.
 */
export interface PostedLinkButton extends PostedInteraction {
  userId: string;
  platform: string;
  url: string;
  label: string;
  body?: string;
  linkType: "settings" | "install" | "oauth";
}

/**
 * Payload emitted on "tool:approval-needed" — platform renderers listen for this.
 */
export interface PostedToolApproval extends PostedInteraction {
  agentId: string;
  userId: string;
  platform: string;
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
  grantPattern: string;
}

/**
 * Payload emitted on "tool:durable-approval-card" — a durable, runs/events-backed
 * approval (today: an agent's manage_agents create/update/delete gate).
 *
 * Distinct from `tool:approval-needed` (the pre-tool MCP grant): this card does
 * NOT block a worker tool call. The write is already a pending `runs` row;
 * Approve/Reject ride the durable runs/events primitive (manage_operations
 * approve/reject). Only the API platform renders it — the chat-platform bridge
 * intentionally does not subscribe (it would mis-handle this as an MCP grant).
 */
export interface PostedDurableApproval extends PostedInteraction {
  userId: string;
  platform: string;
  /** Pending run id; the SPA card's Approve/Reject target. */
  runId: number;
  /** create | update | delete. */
  cardAction: string;
  /** Proposed field values + the agent id (manage_agents). Null for entity_field_change. */
  proposal: Record<string, unknown> | null;
  /** Current agent row (null for create), for the proposed-vs-current diff. */
  current: Record<string, unknown> | null;
  /** entity_field_change diff: field_path -> proposed value. Null for manage_agents.
   *  The SPA routes on this (non-empty) to the entity-field-change card. */
  fields: Record<string, unknown> | null;
  /** Who proposed the entity_field_change: 'agent' | 'automation'. Null for manage_agents. */
  attribution: ApprovalAttribution | null;
  /** Discriminator for the SPA: "agent" | "automation" | "entity". */
  resourceKind: InteractionResourceKind | null;
  /** Headless-origin marker (parity with PostedQuestion/PostedToolApproval). */
  source?: string;
}

/**
 * Platform-agnostic interaction service (fire-and-forget).
 * Posts questions with buttons; no blocking, no state machine.
 * User clicks → platform converts to regular message → normal queue.
 */
export class InteractionService extends EventEmitter {
  private beforeCreateHook?: (
    userId: string,
    conversationId: string
  ) => Promise<void>;

  /**
   * Set a hook to run before creating interactions.
   * Used by platforms to stop streams before interaction messages appear.
   */
  setBeforeCreateHook(
    hook: (userId: string, conversationId: string) => Promise<void>
  ): void {
    this.beforeCreateHook = hook;
  }

  /**
   * Post a question with button options (non-blocking, fire-and-forget).
   * Emits "question:created" for platform renderers.
   */
  async postQuestion(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    question: string,
    options: string[],
    source?: string,
    turnMessageId?: string
  ): Promise<PostedQuestion> {
    assertRoutableInteraction(connectionId, platform, "question");
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedQuestion = {
      id: `q_${randomUUID()}`,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      question,
      options,
      source,
      turnMessageId,
    };

    logger.info(
      `Posted question ${posted.id} for conversation ${conversationId}`
    );

    this.emit("question:created", posted);
    return posted;
  }

  /**
   * Post suggested follow-up actions as chips (non-blocking, fire-and-forget).
   * Emits "suggestion:created" for platform renderers.
   *
   * Fire-and-forget in the strict sense: the tool call does not wait on a
   * click. Chat renderers stash a routing-only pending row (read, never claimed
   * — chips stay multi-clickable), unlike `postQuestion`, whose card gates a
   * suspended turn and must claim its row.
   */
  async postSuggestion(
    organizationId: string,
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    prompts: Array<{ title: string; message: string }>,
    source?: string,
    turnMessageId?: string
  ): Promise<PostedSuggestion> {
    assertRoutableInteraction(connectionId, platform, "suggestion");
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedSuggestion = {
      // Short id, deliberately: chat button action ids embed it as
      // `suggestion:<id>:<i>`, and Telegram's callback_data caps the whole
      // serialized envelope at 64 bytes — a full UUID blows that budget and
      // the card post throws. 12 hex chars keep the callback ~40 bytes with
      // ample collision headroom for a 24h-TTL routing id.
      id: `s_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      organizationId,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      prompts,
      source,
      turnMessageId,
    };

    logger.info(
      `Posted ${prompts.length} suggestion(s) ${posted.id} for conversation ${conversationId}`
    );

    this.emit("suggestion:created", posted);
    return posted;
  }

  /**
   * Post a tool approval request with duration buttons (non-blocking, fire-and-forget).
   * Emits "tool:approval-needed" for platform renderers.
   *
   * `requestId` MUST be the same value the MCP proxy used as the
   * `PendingToolStore` key. It's embedded into the button `actionId` so the
   * interaction bridge can look up the pending invocation on click.
   */
  async postToolApproval(
    requestId: string,
    agentId: string,
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    grantPattern: string,
    source?: string,
    turnMessageId?: string
  ): Promise<PostedToolApproval> {
    assertRoutableInteraction(connectionId, platform, "tool approval");
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedToolApproval = {
      id: requestId,
      agentId,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      mcpId,
      toolName,
      args,
      grantPattern,
      source,
      turnMessageId,
    };

    logger.info(
      `Posted tool approval ${posted.id} for ${mcpId}/${toolName} agent=${agentId}`
    );

    this.emit("tool:approval-needed", posted);
    return posted;
  }

  /**
   * Post a durable approval card (runs/events-backed; today: the builder
   * agent's manage_agents write gate). Fire-and-forget, like postQuestion.
   * Emits "tool:durable-approval-card" — only the API platform renders it,
   * so the chat-platform bridge never mistakes it for a pre-tool MCP grant.
   * Delivery is the SAME owner-gated thread_response path the other cards use.
   */
  async postDurableApprovalCard(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    runId: number,
    cardAction: string,
    proposal: Record<string, unknown> | null,
    current: Record<string, unknown> | null,
    source?: string,
    fields: Record<string, unknown> | null = null,
    attribution: ApprovalAttribution | null = null,
    resourceKind: InteractionResourceKind | null = null,
    turnMessageId?: string
  ): Promise<PostedDurableApproval> {
    assertRoutableInteraction(connectionId, platform, "approval card");
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedDurableApproval = {
      id: `appr_${randomUUID()}`,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      runId,
      cardAction,
      proposal,
      current,
      fields,
      attribution,
      resourceKind,
      source,
      turnMessageId,
    };

    logger.info(
      `Posted durable approval card ${posted.id} for run ${runId} (${cardAction})`
    );

    this.emit("tool:durable-approval-card", posted);
    return posted;
  }

  /**
   * Post a link button (non-blocking, fire-and-forget).
   * Emits "link-button:created" for platform renderers.
   */
  async postLinkButton(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    url: string,
    label: string,
    linkType: "settings" | "install" | "oauth",
    body?: string,
    source?: string,
    turnMessageId?: string
  ): Promise<PostedLinkButton> {
    assertRoutableInteraction(connectionId, platform, "link button");
    assertSafeLinkButtonUrl(url);
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedLinkButton = {
      id: `lb_${randomUUID()}`,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      url,
      label,
      body,
      linkType,
      source,
      turnMessageId,
    };

    logger.info(
      `Posted link button ${posted.id} for conversation ${conversationId} (${linkType})`
    );

    this.emit("link-button:created", posted);
    return posted;
  }
}
