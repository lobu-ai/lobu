/**
 * X (Twitter) connector identity namespaces and normalization.
 *
 * Single source of truth for the X identity vocabulary in the example package.
 * The takeout connector (twitter-takeout.connector.ts) imports from here, and a
 * server that wires the example package in would assemble `xIdentityModule` into
 * its ingest normalizer chain — mirroring @lobu/connectors/x-identity.ts.
 *
 * The namespace string values MUST match the built-in @lobu/connectors
 * x-identity.ts verbatim (`x_user_id`, `x_handle`): the resolver matches on the
 * namespace STRING, not the imported symbol, so a takeout event keyed on
 * `x_user_id` consolidates onto the same `person` the live X connector links —
 * even though the two connectors live in different packages and connections.
 *
 * `x_user_id` (immutable numeric id) is the PRIMARY key: it survives a @handle
 * change, so the same person never forks. `x_handle` is a mutable secondary
 * claim (not recall-indexed).
 */

import type { ConnectorIdentityModule } from "./connector-identity-module.ts";

/** Connector-owned identity namespaces (not SDK-global). */
export const X_IDENTITY = {
  /** Immutable X/Twitter numeric user id — primary namespace for attribution. */
  USER_ID: "x_user_id",
  /** Mutable/reusable @handle — secondary claim, not recall-indexed. */
  HANDLE: "x_handle",
} as const;

export type XIdentityNamespace = (typeof X_IDENTITY)[keyof typeof X_IDENTITY];

/** Immutable numeric X user id: digits only, leading zeros stripped. */
export function normalizeXUserId(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/, "");
}

/** Mutable @handle: strip leading @, lowercase, 1–15 [a-z0-9_]. */
export function normalizeXHandle(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!trimmed || !/^[a-z0-9_]{1,15}$/.test(trimmed)) return null;
  return trimmed;
}

// Single-segment routes that are shaped exactly like a profile link but are
// not one. The anchored pattern below cannot separate `twitter.com/home` from
// `twitter.com/jack` structurally — only a list can.
//
// Deliberately checked HERE and not in `normalizeXHandle`: a real @home or
// @intent account exists, and a handle that arrives from tweet metadata rather
// than from URL parsing must survive. Only the URL reading is ambiguous.
const RESERVED_X_ROUTES = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "settings",
  "compose",
  "search",
  "login",
  "logout",
  "signup",
  "privacy",
  "tos",
]);

/**
 * Pull a normalized @handle out of a direct `twitter.com/<handle>` profile
 * link.
 *
 * Returns null for the `/intent/user?user_id=<id>` form the takeout actually
 * emits — the archive carries no handle for a follow, and the caller already
 * holds the immutable `accountId`, which is the better identity anyway. Reading
 * the first path segment instead named 824 prod entities `intent`.
 *
 * The pattern is anchored to the whole URL so a nested route cannot match and
 * an unrelated host cannot smuggle one in (`example.com/twitter.com/jack`).
 */
export function handleFromUserLink(
  userLink: string | null | undefined
): string | null {
  if (typeof userLink !== "string") return null;
  const match = userLink.match(
    /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([^/?#]+)\/?(?:[?#].*)?$/i
  );
  if (!match) return null;
  const handle = normalizeXHandle(match[1]);
  return handle && RESERVED_X_ROUTES.has(handle) ? null : handle;
}

/**
 * Normalize an X identity namespace value. Returns `undefined` when the
 * namespace is not X-owned (caller falls back to generic hygiene).
 */
export function normalizeXIdentityValue(
  namespace: string,
  raw: string
): string | null | undefined {
  switch (namespace) {
    case X_IDENTITY.USER_ID:
      return normalizeXUserId(raw);
    case X_IDENTITY.HANDLE:
      return normalizeXHandle(raw);
    default:
      return undefined;
  }
}

/** The X connector's contribution to the server identity wiring. */
export const xIdentityModule: ConnectorIdentityModule = {
  key: "x",
  // Only the immutable user id is recall-indexed; x_handle is a mutable
  // secondary claim (see idx_events_metadata_x_user_id — no handle index).
  recallNamespaces: [X_IDENTITY.USER_ID],
  normalize: normalizeXIdentityValue,
};
