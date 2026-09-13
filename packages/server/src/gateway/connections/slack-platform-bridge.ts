import { createLogger } from "@lobu/core";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
import type { PlatformConnection } from "./types.js";
import { escapeSlackText, joinSectionLines } from "../../utils/slack-text";
import { cardToBlockKit } from "@chat-adapter/slack";
import {
	Actions,
	Card,
	type CardChild,
	CardText,
	Divider,
	LinkButton,
} from "chat";

const logger = createLogger("slack-platform-bridge");

const DEFAULT_SLACK_COMMAND = "/lobu";
const DEFAULT_SLACK_TEAM_JOIN_WELCOME =
  "Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands.";
const DEFAULT_SLACK_APP_NAME = "Lobu";

type SlackSlashEvent = {
  text?: string;
  raw?: Record<string, unknown>;
  user?: { userId?: string };
  channel?: { post: (content: any) => Promise<unknown> };
};

type SlackTeamJoinPayload = {
  type?: string;
  team_id?: string;
  event?: {
    type?: string;
    user?: {
      id?: string;
      is_bot?: boolean;
      deleted?: boolean;
      real_name?: string;
      profile?: {
        display_name?: string;
        real_name?: string;
      };
    };
  };
};

type SlackMemberLeftPayload = {
  type?: string;
  team_id?: string;
  event?: {
    type?: string;
    team?: string;
    user?: string;
    channel?: string;
  };
};

export type ParsedSlackTeamJoinEvent = {
  teamId: string;
  userId: string;
  displayName?: string;
};

export type ParsedSlackMemberLeftEvent = {
  teamId: string;
  userId: string;
  channelId: string;
};

function isSlackGroupChannel(channelId: string): boolean {
  return !channelId.startsWith("D");
}

function parseSlackCommandText(text: string | undefined): {
  commandName: string;
  commandArgs: string;
} {
  const trimmed = text?.trim() || "";
  if (!trimmed) {
    return { commandName: "help", commandArgs: "" };
  }

  const [firstToken = "", ...rest] = trimmed.split(/\s+/);
  return {
    commandName: firstToken.replace(/^\/+/, "").toLowerCase() || "help",
    commandArgs: rest.join(" ").trim(),
  };
}

export function registerSlackPlatformHandlers(
  chat: any,
  connection: PlatformConnection,
	commandDispatcher?: CommandDispatcher,
): void {
  if (connection.platform !== "slack" || !commandDispatcher) {
    return;
  }

  chat.onSlashCommand(DEFAULT_SLACK_COMMAND, async (event: SlackSlashEvent) => {
    const raw = event.raw || {};
    const rawChannelId =
      typeof raw.channel_id === "string" ? raw.channel_id : undefined;
    const teamId = typeof raw.team_id === "string" ? raw.team_id : undefined;
    const userId =
      event.user?.userId ||
      (typeof raw.user_id === "string" ? raw.user_id : undefined);

    if (!rawChannelId || !userId || !event.channel) {
      return;
    }

    // Slack hands slash commands the bare channel id (`C…`/`D…`), but inbound
    // messages reach the dispatcher with the Chat SDK's `slack:<id>` thread
    // channel id — and Automation channel subscriptions use that form. Use it
    // here too so `getBinding` lookups (and preview `/lobu link` bindings)
    // agree across both ingress paths.
    const channelId = `slack:${rawChannelId}`;

    const { commandName, commandArgs } = parseSlackCommandText(event.text);
    const reply = createChatReply(async (content) => {
      await event.channel!.post(content);
    });
    const handled = await commandDispatcher.tryHandle(
      commandName,
      commandArgs,
      {
        platform: "slack",
        userId,
        channelId,
        teamId,
        isGroup: isSlackGroupChannel(rawChannelId),
        connectionId: connection.id,
        organizationId: connection.organizationId,
        reply,
			},
    );

    if (!handled) {
      await reply(
				`Unknown /lobu subcommand: ${commandName}. Try \`/lobu help\`.`,
      );
    }
  });
}

/** Adapter surface used by the home tab — `publishHomeView` lives on the Slack adapter. */
type SlackHomeAdapter = {
  publishHomeView?: (
    userId: string,
		view: Record<string, unknown>,
  ) => Promise<void>;
};

type SlackAppHomeEvent = {
  userId: string;
  adapter?: SlackHomeAdapter;
};

/** A single "what's recent" row for the home tab, mirroring the web's recent feed. */
export interface SlackHomeRecentItem {
  /** Display title (event title, or a payload snippet, or a fallback). */
  title: string;
  /** Source label (connector key / platform), or null when unknown. */
  platform: string | null;
  /** Unix seconds of occurred_at|created_at — rendered via a Slack date token. */
  ts: number;
}

/** A single per-user notification row for the home tab. */
export interface SlackHomeNotification {
  /** Notification title. */
  title: string;
  /** Absolute deep link to the resource, or null when none. */
  url: string | null;
  /** Whether the user has already read it. */
  isRead: boolean;
}

/**
 * The viewing user's personal notification inbox (from `notification_targets`),
 * resolved by mapping their Slack user id → Lobu user id. Null when the user
 * hasn't linked an agent yet (no identity) — they see the setup prompt instead.
 */
export interface SlackHomeInbox {
  unreadCount: number;
  items: SlackHomeNotification[];
  /** The user's primary org slug, for deep-linking the setup button to their org home. */
  orgSlug: string | null;
}

/**
 * Glanceable, org-scoped context for the home tab's dashboard card. `events`
 * has no per-agent or per-user attribution column, so every count here is
 * organization-wide — never present it as "your" items.
 */
export interface SlackHomeContext {
  /** Org slug for the dashboard deep link, or null if it can't be resolved. */
  orgSlug: string | null;
  /** Non-deleted entities tracked in the org. */
  entitiesTracked: number;
  /** Events captured today (org-wide, local server day). */
  capturedToday: number;
  /** Most-recent org events (mirrors the web "recent" feed), newest first. */
  recent: SlackHomeRecentItem[];
}

/** Dependencies the App Home tab needs to render status and run OAuth. */
interface SlackAppHomeDeps {
  /**
   * The initialized Slack adapter — the one with the live `@slack/web-api`
   * client. The adapter handed to event handlers via `event.adapter` is the
   * webhook-dispatch instance and has no `client`, so `publishHomeView` must
   * go through this one.
   */
  adapter?: SlackHomeAdapter;
  /**
   * Public origin of the gateway — since the web SPA is served same-origin,
   * this is the base for the dashboard deep link and preview setup prompt.
   */
  publicGatewayUrl?: string;
  /**
   * Resolves the org dashboard slug + glanceable counts for the home tab.
   * Read-only; failures degrade gracefully to a slug-less dashboard link.
   */
  resolveHomeContext?: (
    organizationId: string,
  ) => Promise<SlackHomeContext | null>;
  /**
   * Resolves the viewing Slack user's personal notification inbox, or null when
   * they have no linked Lobu identity. `teamId` scopes the lookup to the
   * correct Slack workspace and is always a real workspace id — a connection
   * without one is not looked up at all, since a Slack `U…` is only unique
   * within a workspace. Read-only; failures degrade to no inbox.
   */
  resolveUserInbox?: (
    slackUserId: string,
    teamId: string,
  ) => Promise<SlackHomeInbox | null>;
}

/** Trim a trailing slash so we can append `/segment` cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Turn a connector key like `apple.screen_time` into `Apple Screen Time`. */
function humanizeSource(platform: string | null): string | null {
  if (!platform) return null;
  return platform.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) =>
    c.toUpperCase(),
  );
}

/** Escape Slack mrkdwn control chars so titles can't inject formatting. */
/** Render the "Recent activity" list as a single section, or `[]` if empty. */
function recentChildren(recent: SlackHomeRecentItem[]): CardChild[] {
  if (recent.length === 0) return [];
  const lines = recent.map((item) => {
    const title = escapeSlackText(item.title);
    const source = humanizeSource(item.platform);
    // `<!date^…>` renders in the viewer's own timezone; the pipe text is the
    // fallback Slack shows if it can't resolve the token.
    const when = `<!date^${item.ts}^{date_short_pretty}|recently>`;
    return source
      ? `• *${title}*  ·  ${escapeSlackText(source)}  ·  ${when}`
      : `• *${title}*  ·  ${when}`;
  });
  return [
    CardText(joinSectionLines(lines, { header: "*Recent activity*" }).text),
    Divider(),
  ];
}

/**
 * The dashboard card: a "Open dashboard" deep link into the web app plus a
 * context line of org-wide counts. Returns `[]` when there's nowhere to link
 * (no public URL), so the home tab still renders without it.
 */
function dashboardChildren(
  webBaseUrl: string | undefined,
  context: SlackHomeContext | null,
): CardChild[] {
  if (!webBaseUrl) return [];
  const base = trimTrailingSlash(webBaseUrl);
  const dashboardUrl = context?.orgSlug ? `${base}/${context.orgSlug}` : base;

  // The button was a section `accessory`; the card AST has no equivalent, so it
  // becomes its own actions row. Slightly taller, and the trade the AST buys:
  // one converter, one escaper, one set of platform limits.
  const children: CardChild[] = [
    CardText(
      "*Your dashboard*\nBrowse everything I've captured, review entities, and tune what I watch.",
    ),
    Actions([
      LinkButton({
        url: dashboardUrl,
        label: "Open dashboard ↗",
        style: "primary",
      }),
    ]),
  ];

  if (context && (context.entitiesTracked > 0 || context.capturedToday > 0)) {
    children.push(
      CardText(
        `:bar_chart: ${context.entitiesTracked.toLocaleString()} tracked  ·  ${context.capturedToday.toLocaleString()} captured today`,
        { style: "muted" },
      ),
    );
  }

  children.push(Divider());
  return children;
}

/**
 * The viewing user's notifications, newest first, each linking to its resource.
 * Relative `resource_url`s are made absolute against the web origin so Slack can
 * link them. Returns `[]` when the inbox is empty/absent.
 */
function notificationChildren(
  webBaseUrl: string | undefined,
  inbox: SlackHomeInbox | null,
): CardChild[] {
  if (!inbox || inbox.items.length === 0) return [];
  const base = webBaseUrl ? trimTrailingSlash(webBaseUrl) : undefined;
  const absolute = (url: string): string =>
    /^https?:\/\//.test(url) || !base
      ? url
      : `${base}/${url.replace(/^\/+/, "")}`;

  const lines = inbox.items.map((item) => {
    const dot = item.isRead ? ":white_circle:" : ":large_blue_circle:";
    const title = escapeSlackText(item.title);
    return item.url
      ? `${dot} <${absolute(item.url)}|${title}>`
      : `${dot} ${title}`;
  });
  const header =
    inbox.unreadCount > 0
      ? `*Notifications* · ${inbox.unreadCount} unread`
      : "*Notifications*";
  return [CardText(joinSectionLines(lines, { header }).text), Divider()];
}

/**
 * Preview-workspace onboarding: a button to set up an agent for this DM in the
 * web app, alongside the `/lobu link <code>` CLI path. Deep-links to the user's
 * org home `/{slug}` (the Builder — where agents are created/configured and a
 * channel is connected per agent) when we know their org, else the web root
 * (which logs them in and routes there). `/{slug}/agents` is intentionally NOT
 * used — it redirects to `/{slug}`. Returns `[]` with no web URL.
 */
function setupChildren(
  webBaseUrl: string | undefined,
  orgSlug: string | null,
): CardChild[] {
  if (!webBaseUrl) return [];
  const base = trimTrailingSlash(webBaseUrl);
  const setupUrl = orgSlug ? `${base}/${orgSlug}` : base;
  return [
    CardText(
      "*Set up your own agent*\nConnect an agent to this DM so I can answer from your own data.",
    ),
    Actions([
      LinkButton({ url: setupUrl, label: "Set up your agent ↗", style: "primary" }),
    ]),
    CardText(
      "Already have a code? Run `/lobu link <code>` here. Get a code from your dashboard or `lobu run`.",
      { style: "muted" },
    ),
    Divider(),
  ];
}

interface HomeViewParams {
  connection: PlatformConnection;
  deps: SlackAppHomeDeps;
  /** Slack user the home tab is being rendered for (credential scope key). */
  userId: string;
}

async function buildSlackHomeBlocks(
	params: HomeViewParams,
): Promise<unknown[]> {
  const { connection, deps, userId } = params;
  const botName =
    (typeof connection.metadata?.botUsername === "string" &&
      connection.metadata.botUsername) ||
    DEFAULT_SLACK_APP_NAME;
  const isPreview = connection.settings?.previewMode === true;

  // Built as card children and converted ONCE at the end. The App Home used to
  // hand-write Block Kit, which is how it grew its own escaper and its own
  // (missing) length limits; going through the AST means it inherits whatever
  // the message path already enforces.
  const children: CardChild[] = [
    CardText(
      `*${botName}* :wave:\n\nI watch your tools, build shared memory, and act on your goals. Mention me in any channel, or send me a DM, to start a thread.`,
    ),
    Divider(),
  ];

  // Personal notifications, for users who've linked a Lobu identity. Scoped by
  // teamId to prevent cross-workspace leaks when platform_user_id collides
  // across Slack workspaces — Slack `U…` ids are unique per workspace, not
  // globally. A connection with no team cannot be scoped, so it resolves no
  // inbox rather than an unscoped one. (This used to fall back to `''`, which
  // matched the rows preview-code redemption wrote with an empty team; that
  // writer is gone and identity is now always workspace-scoped.)
  const teamId =
    typeof connection.metadata?.teamId === "string"
      ? connection.metadata.teamId
      : null;
  let inbox: SlackHomeInbox | null = null;
  try {
    inbox = teamId ? ((await deps.resolveUserInbox?.(userId, teamId)) ?? null) : null;
  } catch (error) {
    logger.warn(
      { error, userId },
      "Failed to resolve Slack home notifications; rendering without them",
    );
  }
  children.push(...notificationChildren(deps.publicGatewayUrl, inbox));

  if (!isPreview && connection.organizationId) {
    let context: SlackHomeContext | null = null;
    try {
      context =
        (await deps.resolveHomeContext?.(connection.organizationId)) ?? null;
    } catch (error) {
      logger.warn(
        { error, organizationId: connection.organizationId },
        "Failed to resolve Slack home dashboard context; rendering link without counts",
      );
    }
    children.push(...dashboardChildren(deps.publicGatewayUrl, context));
    children.push(...recentChildren(context?.recent ?? []));
  }

  if (isPreview) {
    children.push(...setupChildren(deps.publicGatewayUrl, inbox?.orgSlug ?? null));
  }

  children.push(
    CardText(
      isPreview
        ? "Mention me in a channel or DM me to start a thread. `/lobu help` lists the commands."
        : "*Tips*\n• Mention me in a channel, or DM me directly.\n• `/lobu help` lists the built-in commands.\n• Integrations that need you to sign in will also prompt you with a button right in the thread.",
    ),
  );

  return cardToBlockKit(Card({ children }));
}

/** Extract something useful out of a Slack `WebAPIPlatformError` (or anything). */
function errorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const data = (error as { data?: unknown }).data;
    return {
      message: error.message,
      ...(data && typeof data === "object" ? { slack: data } : {}),
    };
  }
  return { message: String(error) };
}

const HOME_FALLBACK_BLOCKS: unknown[] = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Lobu* :wave:\n\nMention me in any channel, or send me a DM, to start a thread. Use `/lobu help` for the built-in commands.",
    },
  },
];

async function publishHome(
  adapter: SlackHomeAdapter | undefined,
	params: HomeViewParams,
): Promise<void> {
  if (typeof adapter?.publishHomeView !== "function") return;
  // Call `publishHomeView` AS A METHOD on the adapter. Extracting it into a
  // local (`const fn = adapter.publishHomeView; fn(...)`) drops the `this`
  // binding, so inside `@chat-adapter/slack` `this` is undefined and
  // `this.client.views.publish(...)` throws "Cannot read properties of
  // undefined (reading 'client')" — failing every publish, rich AND fallback,
  // which left the App Home tab frozen on its last-published view.
  try {
    const blocks = await buildSlackHomeBlocks(params);
    await adapter.publishHomeView(params.userId, { type: "home", blocks });
  } catch (error) {
    logger.warn(
      `Failed to publish Slack home tab (conn=${params.connection.id} user=${params.userId}); falling back: ${JSON.stringify(errorDetail(error))}`,
    );
    // The rich view failed. Don't leave the user staring at a stale cached
    // view — publish a plain text-only home tab.
    try {
      await adapter.publishHomeView(params.userId, {
        type: "home",
        blocks: HOME_FALLBACK_BLOCKS,
      });
    } catch (fallbackError) {
      logger.warn(
        `Failed to publish fallback Slack home tab (conn=${params.connection.id}): ${JSON.stringify(errorDetail(fallbackError))}`,
      );
    }
  }
}

/**
 * Publish the Slack App Home tab when a user opens it.
 *
 * The home view shows the bot intro, the user's personal notification inbox
 * (when they've linked a Lobu identity), the org dashboard card with recent
 * activity, and a preview-workspace setup prompt. It re-renders on every
 * `app_home_opened` event.
 */
export function registerSlackAppHome(
  chat: any,
  connection: PlatformConnection,
	deps: SlackAppHomeDeps = {},
): void {
  if (connection.platform !== "slack") {
    return;
  }

  chat.onAppHomeOpened(async (event: SlackAppHomeEvent) => {
    await publishHome(deps.adapter ?? event.adapter, {
      connection,
      deps,
      userId: event.userId,
    });
  });
}

export function parseSlackTeamJoinEvent(
  body: string,
	contentType: string,
): ParsedSlackTeamJoinEvent | null {
  if (!contentType.includes("application/json")) {
    return null;
  }

  let payload: SlackTeamJoinPayload;
  try {
    payload = JSON.parse(body) as SlackTeamJoinPayload;
  } catch {
    return null;
  }

  if (
    payload.type !== "event_callback" ||
    payload.event?.type !== "team_join"
  ) {
    return null;
  }

  const teamId = payload.team_id;
  const user = payload.event.user;
  if (!teamId || !user?.id || user.is_bot || user.deleted) {
    return null;
  }

  const displayName =
    user.profile?.display_name || user.profile?.real_name || user.real_name;

  return {
    teamId,
    userId: user.id,
    ...(displayName ? { displayName } : {}),
  };
}

export function parseSlackMemberLeftEvent(
  body: string,
  contentType: string,
): ParsedSlackMemberLeftEvent | null {
  if (!contentType.includes("application/json")) {
    return null;
  }

  let payload: SlackMemberLeftPayload;
  try {
    payload = JSON.parse(body) as SlackMemberLeftPayload;
  } catch {
    return null;
  }

  const event = payload.event;
  const teamId = payload.team_id || event?.team;
  if (
    payload.type !== "event_callback" ||
    event?.type !== "member_left_channel" ||
    !teamId ||
    !event.user ||
    !event.channel
  ) {
    return null;
  }

  return {
    teamId,
    userId: event.user,
    channelId: event.channel,
  };
}

export async function postSlackTeamJoinWelcome(
  chat: any,
	event: ParsedSlackTeamJoinEvent,
): Promise<void> {
  const thread = await chat.openDM(event.userId);
  const greeting = event.displayName
    ? `Welcome to Lobu, ${event.displayName}.`
    : "Welcome to Lobu.";
  await thread.post(`${greeting} ${DEFAULT_SLACK_TEAM_JOIN_WELCOME}`);
}
