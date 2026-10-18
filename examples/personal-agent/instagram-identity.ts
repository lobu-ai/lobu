/**
 * Instagram connector identity namespaces and normalization.
 *
 * Single source of truth for the Instagram identity vocabulary in the example
 * package. The takeout connector (instagram-takeout.connector.ts) imports from
 * here; a server wiring the example package would assemble `instagramIdentityModule`
 * into its ingest normalizer chain — mirroring x-identity.ts.
 *
 * Unlike X (immutable numeric `x_user_id`) or LinkedIn (member id from the live
 * Voyager feed), the Instagram TAKEOUT exposes NO stable numeric id anywhere —
 * every people-bearing surface (followers/following/blocked HTML) names a person
 * only by `instagram.com/<username>`. So `ig_username` is the only key available.
 * It is USER-CHANGEABLE, hence a soft key (NOT `primary`) — matched equal-weight,
 * exactly like `linkedin_slug`. This is deliberately an IG-INTERNAL dedup key: it
 * folds the same handle across the export's own feeds (a person who is BOTH a
 * follower and a following becomes ONE entity). There is no live Instagram
 * connector to fuse with, so the namespace string is scoped to this package.
 */

import type { ConnectorIdentityModule } from "./connector-identity-module.ts";

/** Connector-owned identity namespaces (not SDK-global). */
export const INSTAGRAM_IDENTITY = {
  /**
   * Instagram `@username` (handle), lowercased and stripped of the leading `@`.
   * The ONLY cross-referenceable person key a takeout gives. USER-CHANGEABLE, so
   * it is a soft key — NOT `primary` — matched equal-weight. Case-insensitive so
   * the same person never forks across the CASE-SENSITIVE `entity_identities`
   * UNIQUE index.
   */
  USERNAME: "ig_username",
} as const;

export type InstagramIdentityNamespace =
  (typeof INSTAGRAM_IDENTITY)[keyof typeof INSTAGRAM_IDENTITY];

/**
 * Normalize an Instagram username. Lowercase, strip a leading `@`, and require
 * the handle grammar (1–30 of [a-z0-9._]). Returns `null` for anything that is
 * not a plausible handle — which importantly rejects the non-profile paths that
 * appear as `instagram.com/<segment>` links (`p`, `reel`, `stories`, `explore`,
 * `accounts`), so a shared-post link never mints a "person".
 */
export function normalizeInstagramUsername(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!trimmed || !/^[a-z0-9._]{1,30}$/.test(trimmed)) return null;
  // Reserved non-profile path segments that show up as instagram.com/<seg>.
  // Includes the `_u`/`_n` app-deeplink markers: even though usernameFromProfileUrl
  // strips them upstream, rejecting them here is defense-in-depth so a raw `_u`
  // reaching normalization can NEVER become a person (which would mass-merge
  // every following row into one bogus entity).
  const RESERVED = new Set([
    "p",
    "reel",
    "reels",
    "stories",
    "explore",
    "accounts",
    "direct",
    "about",
    "developer",
    "legal",
    "_u",
    "_n",
  ]);
  if (RESERVED.has(trimmed)) return null;
  return trimmed;
}

/**
 * Pull a normalized username out of an `instagram.com/<username>` profile link.
 *
 * The takeout's `following.html` uses Instagram's app-deeplink form
 * `instagram.com/_u/<username>` (and `/_n/<username>`), where the REAL handle is
 * the segment AFTER the `_u`/`_n` prefix — the first segment is just the
 * deeplink marker. `followers_*.html` uses the plain `instagram.com/<username>`.
 * Grabbing the first segment blindly maps every following row to `_u` and
 * mass-merges them into one bogus person, so strip the prefix first.
 */
export function usernameFromProfileUrl(
  url: string | null | undefined
): string | null {
  if (typeof url !== "string") return null;
  const deep = url.match(/instagram\.com\/_[a-z]\/([^/?#]+)/i);
  if (deep) return normalizeInstagramUsername(deep[1]);
  const match = url.match(/instagram\.com\/([^/?#]+)/i);
  return match ? normalizeInstagramUsername(match[1]) : null;
}

/**
 * Normalize an Instagram identity namespace value. Returns `undefined` when the
 * namespace is not IG-owned (caller falls back to generic hygiene).
 */
export function normalizeInstagramIdentityValue(
  namespace: string,
  raw: string
): string | null | undefined {
  switch (namespace) {
    case INSTAGRAM_IDENTITY.USERNAME:
      return normalizeInstagramUsername(raw);
    default:
      return undefined;
  }
}

/** The Instagram connector's contribution to the server identity wiring. */
export const instagramIdentityModule: ConnectorIdentityModule = {
  key: "instagram",
  // No recall index for ig_username — it is a match/attribution key only, like
  // linkedin_slug (no idx_events_metadata_ig_username exists).
  recallNamespaces: [],
  normalize: normalizeInstagramIdentityValue,
};
