/**
 * Slack connector identity namespaces and normalization.
 *
 * Single source of truth for slack_user_id / slack_channel_id rules. The auth
 * sign-in path, channel ACL graph, transcript sender resolution, and server
 * entity-link ingestion all import from here — not from connector-sdk.
 * Connector-specific identity knowledge stays in the connector package so core
 * code never names Slack.
 */

import type {
  AccessResource,
  AclSourceDef,
  ChannelReadIdentity,
} from '@lobu/connector-sdk';
import type { ChatUserIdentity } from './chat-user-identity.js';
import type { ConnectorIdentityModule } from './connector-identity-module.js';

/** Connector-owned identity namespaces (not SDK-global). */
export const SLACK_IDENTITY = {
  /** Team-scoped user id `T…:U…` (upper-cased). Bare Slack user ids are unsafe. */
  USER_ID: 'slack_user_id',
  /** Team-scoped channel id `T…:C…` (upper-cased) — the ACL resource key. */
  CHANNEL_ID: 'slack_channel_id',
} as const;

export type SlackIdentityNamespace =
  (typeof SLACK_IDENTITY)[keyof typeof SLACK_IDENTITY];

/**
 * Slack user IDs aren't globally unique — two workspaces can both have
 * `U12345`. Prefix with the workspace (team) id so identities don't bleed
 * across orgs: `T0XYZ:U12345` (upper-cased).
 */
export function normalizeSlackUserId(
  teamId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (typeof teamId !== 'string' || typeof userId !== 'string') return null;
  const t = teamId.trim();
  const u = userId.trim();
  if (!t || !u) return null;
  if (!/^[a-z0-9_-]+$/i.test(t) || !/^[a-z0-9_-]+$/i.test(u)) return null;
  return `${t}:${u}`.toUpperCase();
}

/**
 * Canonicalize an already-combined team-scoped Slack id (`T0XYZ:U12345`).
 * Connectors/auth emit the team-prefixed form (build it with
 * `normalizeSlackUserId(teamId, userId)`); this is the single-value cleanup
 * pass the ingestion pipeline re-runs. Splits on the first colon and re-runs
 * the two-part validator so a malformed value (no team prefix, bad chars)
 * returns null rather than poisoning matching. Shared by user and channel ids
 * (both are `TEAM:ID` shaped).
 */
function normalizeTeamScopedId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const sep = trimmed.indexOf(':');
  if (sep <= 0 || sep === trimmed.length - 1) return null;
  return normalizeSlackUserId(trimmed.slice(0, sep), trimmed.slice(sep + 1));
}

/**
 * Normalize a Slack identity namespace value. Returns `undefined` when the
 * namespace is not Slack-owned (caller should fall back to generic hygiene).
 */
export function normalizeSlackIdentityValue(
  namespace: string,
  raw: string,
): string | null | undefined {
  switch (namespace) {
    case SLACK_IDENTITY.USER_ID:
    case SLACK_IDENTITY.CHANNEL_ID:
      return normalizeTeamScopedId(raw);
    default:
      return undefined;
  }
}

/** The Slack connector's contribution to the server identity wiring. */
export const slackIdentityModule: ConnectorIdentityModule = {
  key: 'slack',
  // slack_user_id is recall-indexed (idx_events_metadata_slack_user_id);
  // slack_channel_id is an ACL resource key, not an event-recall namespace.
  recallNamespaces: [SLACK_IDENTITY.USER_ID],
  normalize: normalizeSlackIdentityValue,
};

// ── ACL source ────────────────────────────────────────────────────────────
//
// Slack channel membership is a read ACL: a requester may recall a channel iff
// they are `member_of` it. The connector owns how a workspace's channels +
// members normalize into the generic engine's resource/audience shape; the
// server-side materializer (buildAccessGraph) does the IO.

/** The team-scoped channel key the gate matches on (`T…:C…`, upper-cased). */
export function slackChannelKey(teamId: string, channelId: string): string {
  return `${teamId.trim()}:${channelId.trim()}`.toUpperCase();
}

/**
 * Slack's read-gate identity model — how the per-channel visibility gate keys a
 * channel and a requester. The ONE place the gate learns Slack's team-scoped
 * `T…:C…` / `T…:U…` shape; the gate itself dispatches on `platform` and names no
 * connector. `channelKeySql` reproduces `buildChannelKey`'s construction as a
 * SQL expression for the message-visibility compiler (which keys inside a query,
 * so it can't call the TS builder). Both must stay byte-identical.
 */
export const slackChannelReadIdentity: ChannelReadIdentity = {
  platform: 'slack',
  channelNamespace: SLACK_IDENTITY.CHANNEL_ID,
  userNamespace: SLACK_IDENTITY.USER_ID,
  buildChannelKey(teamId, bareChannelId) {
    if (!teamId || !bareChannelId) return null;
    return slackChannelKey(teamId, bareChannelId);
  },
  buildUserKey(teamId, userId) {
    return normalizeSlackUserId(teamId, userId);
  },
  channelKeySql(teamColExpr, channelColExpr) {
    // Mirrors slackChannelKey: UPPER(team || ':' || channel). The team column
    // may be a COALESCE the compiler builds; the channel column is the bare id.
    return `UPPER(${teamColExpr} || ':' || ${channelColExpr})`;
  },
};

/**
 * Slack's chat-sender identity model — how an inbound message's sender maps to
 * the `slack_user_id` a Slack sign-in stamped. Shares `normalizeSlackUserId`
 * with the writer so the key matches byte-for-byte.
 *
 * The team id is REQUIRED: `buildUserKey` returns null without it rather than
 * falling back to a bare `U…`. Two workspaces can legitimately contain the same
 * bare id, and this link authorizes approvals and agent re-binding, so an
 * unscoped key would be a mis-grant.
 */
export const slackChatUserIdentity: ChatUserIdentity = {
  platform: 'slack',
  providerId: 'slack',
  namespace: SLACK_IDENTITY.USER_ID,
  buildUserKey(teamId, platformUserId) {
    return normalizeSlackUserId(teamId, platformUserId);
  },
  userKeyScope(teamId) {
    // No usable team = REFUSE, never "search the whole namespace". Two
    // workspaces can both hold `U12345`, so an unconstrained search here would
    // hand back an id from the wrong one. Validate exactly as
    // `normalizeSlackUserId` does so the prefix cannot disagree with the keys
    // it wrote.
    if (typeof teamId !== 'string') return null;
    const t = teamId.trim();
    if (!t || !/^[a-z0-9_-]+$/i.test(t)) return null;
    return { kind: 'team-prefix', prefix: `${t.toUpperCase()}:` };
  },
};

/** A Slack channel and the (bare `U…`) ids of its members. */
export interface SlackChannelInput {
  /** Bare Slack channel id (`C…` / `G…`). */
  channelId: string;
  name?: string;
  isPrivate?: boolean;
  /** Bare Slack user ids (`U…`) of the channel's members. */
  memberSlackUserIds: string[];
}

/** The Slack connector's ACL-source descriptor. */
export const slackAclSource: AclSourceDef = {
  key: 'slack',
  resourceNamespace: SLACK_IDENTITY.CHANNEL_ID,
  memberIdentities: [{ namespace: SLACK_IDENTITY.USER_ID, primary: true }],
};

/**
 * Normalize a Slack workspace's channels into engine resources: each channel a
 * team-scoped `T…:C…` key; each member resolved on the canonical team-scoped
 * `slack_user_id` namespace so a signed-in member collapses onto their entity.
 * Channels without an id, and members whose id doesn't team-scope, are dropped.
 */
export function slackChannelsToResources(
  teamId: string,
  channels: SlackChannelInput[],
): AccessResource[] {
  const resources: AccessResource[] = [];
  for (const c of channels) {
    if (!c.channelId) continue;
    const members: AccessResource['members'] = [];
    for (const u of c.memberSlackUserIds) {
      const combined = normalizeSlackUserId(teamId, u);
      if (!combined) continue;
      members.push({
        key: combined,
        name: combined,
        identities: [{ namespace: SLACK_IDENTITY.USER_ID, value: combined }],
      });
    }
    resources.push({
      key: slackChannelKey(teamId, c.channelId),
      name: c.name ?? c.channelId,
      members,
    });
  }
  return resources;
}
