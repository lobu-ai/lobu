/**
 * LinkedIn Connector
 *
 * Example-only — not bundled with Lobu. A single connector that spans BOTH:
 *
 *   • LIVE feeds (home_feed, company_updates, jobs) — scraped via the paired
 *     Owletto Chrome extension's network-intercept / content-script primitives.
 *     The extension runs inside the user's real Chrome session — no Playwright,
 *     no cookie cache, no `--remote-debugging-port` plumbing. We attach the CDP
 *     Network domain in the user's signed-in tab, drive scroll pagination, and
 *     parse the Voyager API responses the page emits. Auth is implicit: the user
 *     is already signed into linkedin.com in the paired Chrome. If no online
 *     Owletto extension is reachable in the connection's org, these syncs fail
 *     fast with a clear "no paired Owletto extension" error.
 *
 *   • TAKEOUT feeds (connections, messages, invitations, applied_jobs, profile,
 *     companies, learning, events, endorsements, media) — read from the user's
 *     local LinkedIn Data Export CSV files.
 *
 * Folding both into ONE connector (key "linkedin") means a single connection
 * dedups all people on the shared `linkedin_slug`/`email` identity: a person met
 * live and a person in the CSV export collapse to the same entity.
 *
 * Write handoff: `prepare_comment` waits for the user to open the exact post,
 * fills that page's comment composer, and stops. The human clicks Post
 * themselves — Lobu never submits the comment.
 *
 * Closed-loop (optional): `verify_staged_comment` re-opens the post and scrapes
 * comments to check whether the human actually posted the draft.
 * Staging ≠ verified posted.
 */

import {
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventAttributionRule,
  type EventEnvelope,
  extensionDomScrape,
  extensionNetworkSync,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  LINKEDIN_EMAIL_NAMESPACE,
  LINKEDIN_IDENTITY,
  normalizeLinkedInMemberId,
  normalizeLinkedInSlug,
} from "./linkedin-identity.ts";
import {
  readCompanyFollows,
  readConnections,
  readEndorsements,
  readEvents,
  readInvitations,
  readJobs,
  readLearning,
  readMessages,
  readProfile,
  readRichMedia,
  type TakeoutCsvReader,
} from "./linkedin-takeout.ts";
import {
  batchSize,
  type LocalTakeoutConfig,
  maxEventCursor,
  takeBatch,
} from "./takeout-utils.ts";

// ── Types ──────────────────────────────────────────────────────

/**
 * Merged checkpoint. Carries the live cursor fields (last_post_id / last_job_id
 * / last_timestamp) AND every takeout feed's `last_*_timestamp` cursor. The
 * takeout `jobs` feed was renamed to `applied_jobs`, so its cursor is
 * `last_applied_jobs_timestamp` (no ambiguity with the live `jobs` feed, which
 * checkpoints on last_job_id/last_timestamp). No production checkpoint exists,
 * so the rename is safe.
 */
interface LinkedInCheckpoint {
  // Live feed cursors.
  last_post_id?: string;
  last_job_id?: string;
  last_timestamp?: string;
  // Takeout feed cursors.
  last_messages_timestamp?: string;
  last_connections_timestamp?: string;
  last_invitations_timestamp?: string;
  last_applied_jobs_timestamp?: string;
  last_profile_timestamp?: string;
  last_companies_timestamp?: string;
  last_learning_timestamp?: string;
  last_events_timestamp?: string;
  last_endorsements_timestamp?: string;
  last_media_timestamp?: string;
}

/**
 * Merged config. Permissive superset of the live config (company_url,
 * max_scrolls) and the takeout config (takeout_dir, batch_size). A given feed
 * only reads the keys relevant to its source.
 */
interface LinkedInConfig extends LocalTakeoutConfig {
  company_url?: string;
  max_scrolls?: number;
  min_scrolls?: number;
}

interface LinkedInPost {
  id: string;
  text: string;
  author: string;
  authorHeadline?: string;
  /** Immutable `urn:li:fsd_profile:<id>` tail — primary identity when present. */
  authorMemberId?: string;
  /** Canonical `/in/<slug>` vanity id — soft identity, bridges to takeout. */
  authorSlug?: string;
  likes: number;
  comments: number;
  shares: number;
  publishedAt: Date;
}

interface LinkedInJob {
  id: string;
  title: string;
  location: string;
  postedAt: Date;
  url: string;
  description?: string;
}

function normalizeCheckpointPostId(postId?: string): string | undefined {
  if (!postId) return undefined;
  return postId.startsWith("li_post_")
    ? postId.slice("li_post_".length)
    : postId;
}

// ── Identity attributions ──────────────────────────────────────

/**
 * Link a `connection` event to the connected person via their canonical
 * `linkedin_slug` (extracted from the profile URL) plus their `email`. Neither
 * is `primary` — they match equal-weight cross-channel until a stable primary
 * id arrives from the live connector. The full URL is kept as a display trait,
 * not an identity (case/URL noise would fork the entity). Connections ARE the
 * user's network, so we mint (`autoCreate`) a person per row.
 */
const LINKEDIN_CONNECTION_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "author_name",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.linkedin_slug",
        },
        { namespace: LINKEDIN_EMAIL_NAMESPACE, eventPath: "metadata.email" },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.linkedin_url",
        mergeStrategy: "prefer_non_empty",
      },
      company: {
        eventPath: "metadata.company",
        mergeStrategy: "prefer_non_empty",
      },
      position: {
        eventPath: "metadata.position",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
];

/**
 * Link a `message` event to its sender (the counterparty) via the
 * `linkedin_slug` extracted from their profile URL, plus display name. Real
 * counterparties, so mint on no match.
 */
const LINKEDIN_MESSAGE_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.from",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.sender_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.sender_profile_url",
        mergeStrategy: "prefer_non_empty",
      },
      last_linkedin_message_at: {
        eventPath: "occurred_at",
        mergeStrategy: "overwrite",
      },
    },
  },
];

/**
 * Link a live `post` to its author. The Voyager feed (company_updates) exposes
 * the actor's immutable `urn:li:fsd_profile:<id>` as `author_member_id` plus the
 * `/in/<slug>`. Both are identities; NEITHER is `primary` — they match
 * EQUAL-WEIGHT (same as the connections/messages attributions).
 *
 * Why not primary member_id: takeout-ingested people already exist keyed on
 * `linkedin_slug` (no member id — the export has none). A `primary` member_id
 * would be authoritative: on a live post it would find no member-id match, mint
 * a NEW person, and fork the existing slug-person (the resolver does not fall
 * back to a secondary slug hit when a primary is present). Equal-weight instead
 * UNIONS the hits: the live post matches the existing person by slug AND
 * accretes the member_id onto them. Durability still holds — once the member_id
 * is on the person, a later vanity-URL change still resolves via that member_id
 * in the equal-weight union. Real authors, so mint on no match.
 */
const LINKEDIN_POST_AUTHOR_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "author_name",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.MEMBER_ID,
          eventPath: "metadata.author_member_id",
        },
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.author_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_headline: {
        eventPath: "metadata.author_headline",
        mergeStrategy: "prefer_non_empty",
      },
      last_linkedin_post_at: {
        eventPath: "occurred_at",
        mergeStrategy: "overwrite",
      },
    },
  },
];

/**
 * Attribute only people whose `linkedin_slug` was resolved from the row's
 * profile links. The engine skips rules with no resolved identity, so a card
 * that exposes no link for a member cannot create a name-only entity for them.
 * When an engagement card exposes links for both members, it carries both
 * slugs so the author can be minted instead of being dropped.
 */
const LINKEDIN_HOME_FEED_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    name: "author",
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "author_name",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.author_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.author_profile_url",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
  {
    name: "engager",
    role: "performed_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.social_actor",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.social_actor_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.social_actor_profile_url",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
];

/** A visible comment links its author to the author of the parent post. */
const LINKEDIN_HOME_COMMENT_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    name: "commenter",
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "author_name",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.author_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.author_profile_url",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
  {
    name: "post_author",
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.parent_author",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.parent_author_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.parent_author_profile_url",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
  {
    name: "parent_comment_author",
    role: "in_reply_to",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.parent_comment_author",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.parent_comment_author_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.parent_comment_author_profile_url",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
];

// ── Home-feed content-script scrape contract ────────────────────
//
// The personalized home feed (linkedin.com/feed/) is the ONE feed that can't
// be read via network capture: attaching the CDP debugger stops the feed from
// rendering, so the Voyager responses never arrive. Instead we drive the
// extension's `cs_scrape` op (a content script, no debugger) with a declarative
// selector config defined here. The extension runs a site-agnostic scrape
// engine — the LinkedIn selectors live in this connector, not the extension.

/** One profile/company anchor scraped from a home-feed card. */
interface HomeFeedLink {
  /** The `/in/<slug>` or `/company/<slug>` href. */
  href?: string;
  /**
   * The anchor's accessible name — LinkedIn renders these as `View <Name>'s
   * profile` (person) or `View company: <Name>` (company). Used to match an
   * anchor to the actor/author named elsewhere in the card, so identity never
   * depends on link order.
   */
  name?: string;
}

/** One media URL scraped from a feed card. */
interface HomeFeedMedia {
  url?: string;
  alt_text?: string;
}

/** A row produced by the extension's cs_scrape from HOME_FEED_SCRAPE_CONFIG. */
interface HomeFeedRow {
  /** The componentkey token (base64url-ish, NOT a numeric activity id). */
  id?: string;
  body?: string;
  author?: string;
  /**
   * The post-author's name, read from the card's control-menu button
   * (`aria-label="Open control menu for post by <Author>"`). LinkedIn names the
   * author here on the observed plain, engagement, promoted, and company card
   * shapes, regardless of link order. This is preferred over the body-text
   * heuristic when present.
   */
  author_control_label?: string;
  /**
   * Post permalink, when a row carries one. The scrape spec that fed this is
   * inert on current cards (see `post_url` in HOME_FEED_SCRAPE_CONFIG), so
   * treat it as best-effort and prefer `post_identity` for durable identity.
   */
  post_url?: string;
  /**
   * Rendered identifier carrying the stable post id: a readable shareId /
   * ugcPostId / activity URN, or the encoded comment-tools id that
   * `decodeHomeFeedPostIdentity` turns into a URN before ingestion.
   */
  post_identity?: string;
  /** Every profile/company anchor in the card, each with its accessible name. */
  links?: HomeFeedLink[];
  /** Media that belongs to a top-level post (nested comment media excluded). */
  post_media?: HomeFeedMedia[];
  /** Media that belongs to a visible comment row. */
  comment_media?: HomeFeedMedia[];
  /** Dedicated engagement-summary values, never inferred from post prose. */
  reaction_count_text?: string;
  reaction_count_label?: string;
  comment_count_text?: string;
  comment_count_label?: string;
  repost_count_text?: string;
  repost_count_label?: string;
  /** Explicit browser-runtime proof that the post's thread was fully expanded. */
  comment_coverage?: HomeFeedCommentCoverage;
  /** Durable identity of an enclosing comment when this row is a nested reply. */
  parent_comment_identity?: string;
}

interface HomeFeedCommentCoverage {
  expected: number;
  collected: number;
  complete: boolean;
  timedOut?: boolean;
}

/** LinkedIn origins the cs_scrape window is allowed to touch. */
const LINKEDIN_ALLOWED_ORIGINS = ["linkedin.com", "*.linkedin.com"];

const HOME_FEED_COMMENT_COUNT_TEXT_SELECTOR =
  ':scope:not([id^="replaceableComment_"]) div:has(+ hr + div button[aria-label="Open reactions menu"]):not([id^="replaceableComment_"] *) > div:last-child > div:first-child, .social-details-social-counts__comments, .social-details-social-counts__comments-count';
const HOME_FEED_COMMENT_COUNT_LABEL_SELECTOR =
  '.social-details-social-counts [aria-label*="comment" i], [aria-label$=" comment" i]:not([id^="replaceableComment_"] *), [aria-label$=" comments" i]:not([id^="replaceableComment_"] *)';
const HOME_FEED_POST_CONTROL_SELECTOR =
  '[role="button"]:not([id^="replaceableComment_"] *):not([componentkey^="commentsSectionContainer"] *), button:not([id^="replaceableComment_"] *):not([componentkey^="commentsSectionContainer"] *), a:not([id^="replaceableComment_"] *):not([componentkey^="commentsSectionContainer"] *)';
const HOME_FEED_POST_IDENTITY_SELECTOR =
  ':is([id*="shareId="], [id*="ugcPostId="], [id*="urn:li:activity:"], [id*="-replaceableCommentTools"]):not([id^="replaceableComment_"]):not([id^="replaceableComment_"] *)';

/** Current comment-tool ids encode a typed post URN, followed by the recycled
 * card key. Decode only the typed prefix: field 1 is activity, field 2 ugcPost;
 * each contains field 1 as a protobuf sint64 (ZigZag). Native comment URNs and
 * the corresponding live post URLs independently confirm those namespaces. */
function decodeHomeFeedPostIdentity(
  raw: string | undefined
): string | undefined {
  const marker = "-replaceableCommentTools";
  if (!raw?.includes(marker)) return raw;
  const invalid = () =>
    new Error(
      "LinkedIn returned an invalid encoded post identity. No home-feed events were persisted."
    );
  let bytes: string;
  try {
    bytes = atob(
      raw.slice(0, raw.indexOf(marker)).replace(/-/g, "+").replace(/_/g, "/")
    );
  } catch {
    throw invalid();
  }
  const tag = bytes.charCodeAt(0);
  if (
    (tag !== 10 && tag !== 18) ||
    bytes.length < 4 ||
    bytes.length > 13 ||
    bytes.charCodeAt(1) !== bytes.length - 2 ||
    bytes.charCodeAt(2) !== 8
  ) {
    throw invalid();
  }
  let encoded = 0n;
  for (let i = 3; i < bytes.length; i++) {
    const byte = bytes.charCodeAt(i);
    const isLast = i === bytes.length - 1;
    if (Boolean(byte & 128) === isLast) throw invalid();
    encoded |= BigInt(byte & 127) << BigInt(7 * (i - 3));
  }
  if ((encoded & 1n) !== 0n || encoded >= 1n << 64n || encoded < 200_000n) {
    throw invalid();
  }
  return `urn:li:${tag === 10 ? "activity" : "ugcPost"}:${encoded >> 1n}`;
}

/**
 * Selectors for the virtualized linkedin.com/feed/ DOM. Home-feed posts are
 * componentkey divs with no activity urn, so the row id is the componentkey
 * token (NOT numeric). These selectors live here, not in the extension.
 */
const HOME_FEED_SCRAPE_CONFIG = {
  scroll: { max: 8, stall: 3, waitMs: 1500 },
  loggedOutWhen: {
    pathRegex: "/(login|authwall|uas/login|checkpoint|signup)\\b",
  },
  rowSelector:
    'div[componentkey^="expanded"][componentkey*="FeedType_MAIN_FEED_RELEVANCE"], [id^="replaceableComment_urn:li:comment:"]',
  expandRows: {
    // Only actual post containers start with `expanded`; helper/component rows
    // share the FeedType suffix but must never drive another post's controls.
    rowSelector:
      'div[componentkey^="expanded"][componentkey*="FeedType_MAIN_FEED_RELEVANCE"]',
    // LinkedIn swaps the whole card for a fresh element mid-expansion (sorting
    // by "Most recent" is enough to trigger it). Without a row-local durable
    // id the extension cannot tell a replacement from a recycled slot, so it
    // abandons the thread. Same selector as post_identity below: the two must
    // resolve to the same post or expansion proof binds to the wrong row.
    identity: {
      selector: HOME_FEED_POST_IDENTITY_SELECTOR,
      take: "attr",
      attr: "id",
      // Exclude the recycled card-key suffix from expansion ownership.
      regex: "^(.*?)(?:-replaceableCommentTools|$)",
      group: 1,
    },
    expected: {
      // Keep this aligned with the post-level comment count fields below. The
      // count is not always interactive: LinkedIn also renders it as a plain
      // counter wrapper or an aria-labelled span.
      selector: `${HOME_FEED_COMMENT_COUNT_TEXT_SELECTOR}, ${HOME_FEED_COMMENT_COUNT_LABEL_SELECTOR}, ${HOME_FEED_POST_CONTROL_SELECTOR}`,
      textRegex: "^\\d[\\d,.]*(?:\\s*[kmb])?\\s+comments?",
      textRegexFlags: "i",
      regex: "(\\d[\\d,.]*(?:\\s*[kmb])?)\\s+comments?",
      regexFlags: "i",
    },
    items: {
      selector: '[id^="replaceableComment_urn:li:comment:"]',
      idAttr: "id",
    },
    open: {
      selector: '[role="button"], button, a',
      textRegex: "^\\d[\\d,.]*(?:\\s*[kmb])?\\s+comments?",
      textRegexFlags: "i",
    },
    sort: {
      triggerSelector: '[role="button"], button',
      triggerTextRegex: "^Most relevant$|^Most recent$",
      triggerTextRegexFlags: "i",
      selectedTextRegex: "^Most recent$",
      selectedTextRegexFlags: "i",
      optionSelector: '[role="menuitem"]',
      optionTextRegex: "^Most recent\\b",
      optionTextRegexFlags: "i",
      maxWaitMs: 1500,
    },
    more: {
      selector: '[role="button"], button, a',
      textRegex:
        "^(?:(?:See|Load|View)\\s+\\d[\\d,.]*\\s+(?:more\\s+)?comments?|(?:See|Load|View)\\s+(?:more|previous)\\s+(?:comments?|replies)|\\d[\\d,.]*\\s+replies)\\b",
      textRegexFlags: "i",
    },
    maxPasses: 40,
    // Return explicit incomplete coverage before the extension's 90-second
    // watchdog. This leaves time for row harvesting and guarantees that a
    // large thread cannot strand a content script in the user's tab.
    maxDurationMs: 55_000,
    // LinkedIn removes its controls before the requested comments finish
    // rendering. Allow a short control-free settling window; the shared
    // maxDurationMs budget still caps the whole expansion pass.
    stall: 12,
    waitMs: 350,
    outputField: "comment_coverage",
  },
  id: {
    source: "attr",
    // Posts identify themselves with componentkey; native comments use their
    // replaceableComment id. Selecting comments individually keeps two visible
    // comments (and their media) from collapsing into one container row.
    name: ["componentkey", "id"],
    // Post rows keep only the token before FeedType_. Comment ids have no
    // FeedType_ suffix, so the end-of-string alternative preserves the full
    // native comment identity.
    regex: "^(?:expanded)?(.+?)(?=FeedType_|$)",
    group: 1,
  },
  requireFields: ["body"],
  fields: {
    body: { take: "text" },
    author: {
      // LinkedIn obfuscates the actor classes, so the old
      // .update-components-actor__* selectors no longer match. Best-effort:
      // grab the visible name span inside the actor's profile/company link
      // when present. When this misses, buildHomeFeedEvents falls back to
      // parsing the author out of the row body text.
      selector:
        'a[href*="/in/"] span[aria-hidden="true"], a[href*="/company/"] span[aria-hidden="true"]',
      take: "text",
      firstLine: true,
    },
    author_control_label: {
      // The post's own control-menu button supplies the preferred author signal
      // independently of profile-link order — see HomeFeedRow.
      selector: 'button[aria-label*="control menu for post by"]',
      take: "attr",
      attr: "aria-label",
    },
    post_url: {
      // Current cards expose neither a permalink anchor nor a post URN. Their
      // control menu still has LinkedIn's own "Copy link to post" action, but
      // the extension does not click clipboard-writing actions. `post_url` is
      // therefore best-effort/empty; `post_identity` below is the durable key.
      take: "clipboardAction",
      triggerSelector: 'button[aria-label*="control menu for post by"]',
      actionSelector: '[role="menuitem"]',
      actionTextRegex: "^Copy link(?: to post)?$",
      actionTextRegexFlags: "i",
      maxWaitMs: 1500,
    },
    post_identity: {
      // Readable commentary URNs and encoded comment-tool ids both carry the
      // durable post identity. parseRows decodes the latter before ingestion.
      selector: HOME_FEED_POST_IDENTITY_SELECTOR,
      take: "attr",
      attr: "id",
    },
    links: {
      // Every profile/company anchor with its accessible name, so
      // buildHomeFeedEvents can match the author/engager by NAME rather than by
      // fragile DOM position. `aria` reads the anchor's own or descendant
      // aria-label ("View <Name>'s profile"); `alt` covers the avatar img on
      // company links ("View company: <Name>").
      selector: 'a[href*="/in/"], a[href*="/company/"]',
      take: "objectAll",
      parts: {
        href: { take: "attr", attr: "href" },
        name: { take: "aria" },
        nameAlt: { take: "alt" },
      },
    },
    post_media: {
      // Profile photos and company logos are identities, not post attachments.
      // The final :not keeps media inside a nested visible comment off the post.
      selector:
        ':scope:not([id^="replaceableComment_"]) img[src*="media.licdn.com/dms/image/"]:not([src*="profile-displayphoto"]):not([src*="company-logo"]):not([id^="replaceableComment_"] img)',
      take: "objectAll",
      parts: {
        url: { take: "attr", attr: "src" },
        alt_text: { take: "attr", attr: "alt" },
      },
    },
    comment_media: {
      selector:
        ':scope[id^="replaceableComment_"] img[src*="media.licdn.com/dms/image/"]:not([src*="profile-displayphoto"]):not([src*="company-logo"])',
      take: "objectAll",
      parts: {
        url: { take: "attr", attr: "src" },
        alt_text: { take: "attr", attr: "alt" },
      },
    },
    parent_comment_identity: {
      // Replies are nested beneath their parent comment on the current feed.
      // Starting the closest lookup at parentElement keeps top-level comments
      // empty while recording the enclosing durable comment id for replies.
      closestSelector: '[id^="replaceableComment_urn:li:comment:"]',
      take: "attr",
      attr: "id",
    },
    // Engagement comes only from LinkedIn's dedicated social-count controls.
    // Keep both visible text and accessible-label variants because the current
    // feed uses both shapes across post types and experiments.
    //
    // Row scoping matters here: a post row CONTAINS its visible comment rows,
    // and `querySelector` returns the first match in DOCUMENT order across the
    // whole comma list, not the first branch that matches. So every branch that
    // is not already anchored to `.social-details-social-counts` (the post's own
    // block) carries `:not([id^="replaceableComment_"] *)`, which excludes
    // elements inside a nested comment. The reaction fields then add a leading
    // `:scope[id^="replaceableComment_"]` branch so a comment row reads its OWN
    // reactions: the current feed puts the count beside an "Open reactions
    // menu" button using obfuscated classes, while permalink pages still use a
    // comment social-bar class with an experiment suffix (`--cr`). The semantic
    // sibling branch covers the feed and the prefix class match covers the
    // permalink shape. Current post cards put their count block immediately
    // before the divider and action bar; those semantic siblings avoid the
    // obfuscated classes. Comment and repost counts stay post-only — a
    // comment's reply count is a different quantity.
    reaction_count_text: {
      selector:
        ':scope:not([id^="replaceableComment_"]) div:has(+ hr + div button[aria-label="Open reactions menu"]):not([id^="replaceableComment_"] *) > a:first-child, :scope[id^="replaceableComment_"] div:has(> button[aria-label="Open reactions menu"]) > :first-child, :scope[id^="replaceableComment_"] [class*="comments-comment-social-bar__reactions-count"], .social-details-social-counts__reactions-count, .social-details-social-counts__reactions',
      take: "text",
    },
    reaction_count_label: {
      selector:
        ':scope[id^="replaceableComment_"] [aria-label*=" reaction on " i], :scope[id^="replaceableComment_"] [aria-label*=" reactions on " i], .social-details-social-counts [aria-label*="reaction" i], [aria-label$=" reaction" i]:not([aria-label^="Reaction button state:" i]):not([id^="replaceableComment_"] *), [aria-label$=" reactions" i]:not([aria-label^="Reaction button state:" i]):not([id^="replaceableComment_"] *)',
      take: "attr",
      attr: "aria-label",
    },
    comment_count_text: {
      selector: HOME_FEED_COMMENT_COUNT_TEXT_SELECTOR,
      take: "text",
    },
    comment_count_label: {
      selector: HOME_FEED_COMMENT_COUNT_LABEL_SELECTOR,
      take: "attr",
      attr: "aria-label",
    },
    repost_count_text: {
      selector:
        ':scope:not([id^="replaceableComment_"]) div:has(+ hr + div button[aria-label="Open reactions menu"]):not([id^="replaceableComment_"] *) > div:last-child > a:last-child, .social-details-social-counts__reposts, .social-details-social-counts__reposts-count',
      take: "text",
    },
    repost_count_label: {
      selector:
        '.social-details-social-counts [aria-label*="repost" i], [aria-label$=" repost" i]:not([id^="replaceableComment_"] *), [aria-label$=" reposts" i]:not([id^="replaceableComment_"] *)',
      take: "attr",
      attr: "aria-label",
    },
  },
} as const;

/**
 * Best-effort author extraction from a home-feed row's body text. Social
 * context appears before the post author in two shapes: actor banners name an
 * engaging member ("X likes this", "X commented", "X reposted this") and
 * actor-less banners are platform labels with no member ("Recommended for
 * you", "Voices worth following"). Stacked context can contain more than one
 * actor banner; the author follows the last one.
 */
const HOME_FEED_ACTOR_BANNER_RE =
  /\b(?:(?:likes?|loves?|celebrates?|supports?) this|finds? this (?:insightful|funny)|commented(?: on this)?|reposted this)\s*/gi;
const HOME_FEED_ACTORLESS_BANNER_RE =
  /^(?:recommended for you|voices worth following)\s+/i;

/** Normalize a matched actor-banner to a stable engagement verb. */
function normalizeSocialAction(banner: string): string {
  const b = banner.toLowerCase();
  if (b.includes("comment")) return "comment";
  if (b.includes("repost")) return "repost";
  if (b.includes("insightful")) return "insightful";
  if (b.includes("funny")) return "funny";
  if (b.includes("love")) return "love";
  if (b.includes("celebrate")) return "celebrate";
  if (b.includes("support")) return "support";
  return "like";
}

type HomeFeedBanner =
  | { kind: "actor"; actor: string; action: string }
  | { kind: "actorless" };

/** Strip relative-time tokens, fused CTAs, and leading emoji from a name. */
function cleanHomeFeedDisplayName(raw: string): string {
  let name = raw.trim();
  // A repost segment puts a relative-time token (e.g. "17h") right after the
  // original poster's name and before the marker — strip it so we keep just
  // the name.
  name = name.replace(/\s+\d+\s*[smhdwy]o?$/i, "").trim();
  // Feed cards sometimes fuse UI chrome into the name after a repost /
  // company author: "Sim Visit website", "Acme View job".
  name = name
    .replace(
      /\s+(?:Visit website|View (?:job|page|profile)|Apply now|Register now|Sign up)$/i,
      ""
    )
    .trim();
  // Leading emoji / symbol decorations on display names (e.g. "🦔 james").
  name = name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return name.slice(0, 60);
}

function parseHomeFeedAuthorDetails(body: string): {
  author: string;
  banner: HomeFeedBanner | null;
} {
  if (!body) return { author: "", banner: null };
  const text = body.replace(/^feed post\s+/i, "").trim();

  // Limit banner matching to the row header so post content cannot be mistaken
  // for social context.
  const sepIdx = text.indexOf(" • ");
  if (sepIdx === -1) {
    // Expanded-post cards can use "<Name> Author <headline>" without a degree
    // marker. Resolve that bounded prefix before scanning for banner phrases
    // so words in the post content cannot affect attribution.
    const badge = text.match(/^(.{1,60}?)\s+Author\b/);
    return {
      author: badge ? cleanHomeFeedDisplayName(badge[1]) : "",
      banner: null,
    };
  }
  let header = text.slice(0, sepIdx).trim();

  let banner: HomeFeedBanner | null = null;
  const actorless = header.match(HOME_FEED_ACTORLESS_BANNER_RE);
  if (actorless) {
    header = header.slice(actorless[0].length).trim();
    banner = { kind: "actorless" };
  }

  const matches = [...header.matchAll(HOME_FEED_ACTOR_BANNER_RE)];
  if (matches.length > 0) {
    const first = matches[0];
    const last = matches[matches.length - 1];
    const actorGroup = header.slice(0, first.index).trim();
    const pluralActors = actorGroup.match(/^(.*?)\s+and\s+\d+\s+others?$/i);
    // "A and 3 others" / "A, B and 22 others" use A's profile link. Preserve
    // commas in a single member's display name (for example, "A, MBA").
    const actor = cleanHomeFeedDisplayName(
      pluralActors ? pluralActors[1].split(",")[0] : actorGroup
    );
    banner = {
      kind: "actor",
      actor: actor.slice(0, 60),
      action: normalizeSocialAction(first[0]),
    };
    header = header.slice(last.index + last[0].length).trim();
  }

  let name = header;
  // A "<Name> Premium Profile <degree> <Name>" badge row repeats the name —
  // keep only the leading one.
  const premiumIdx = name.indexOf(" Premium Profile");
  if (premiumIdx !== -1) name = name.slice(0, premiumIdx);
  return { author: cleanHomeFeedDisplayName(name), banner };
}

export function parseHomeFeedAuthor(body: string): string {
  return parseHomeFeedAuthorDetails(body).author;
}

/**
 * Pull the post author's name out of the control-menu aria-label
 * ("Open control menu for post by <Author>"). Returns "" when the field is
 * missing (older cards / extensions) so callers fall back to the body parse.
 */
function parseAuthorControlLabel(label?: string): string {
  if (!label) return "";
  const m = label.match(/control menu for post by\s+(.+)$/i);
  return m ? cleanHomeFeedDisplayName(m[1]) : "";
}

/** A comparison key that ignores case, accents, and punctuation. */
function nameKey(name: string): string {
  return cleanHomeFeedDisplayName(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The accessible name LinkedIn renders on a profile/company anchor. */
function linkDisplayName(link: HomeFeedLink): string {
  const raw = link.name || "";
  // "View <Name>'s profile" / "View <Name>'s graphic" (person avatars) and
  // "View company: <Name>" (company avatars).
  const person = raw.match(/^View\s+(.+?)['’]s\s+(?:profile|graphic)/i);
  if (person) return cleanHomeFeedDisplayName(person[1]);
  const company = raw.match(/^View company:\s+(.+)$/i);
  if (company) return cleanHomeFeedDisplayName(company[1]);
  return cleanHomeFeedDisplayName(raw);
}

/**
 * Coerce the extension's `links` field into HomeFeedLink[]. The objectAll scrape
 * emits `{href, name, nameAlt}` per anchor (name = aria-label, nameAlt = img
 * alt); coalesce them into one accessible name. Guards a non-array value so a
 * malformed/absent field yields no links rather than a crash.
 */
function normalizeHomeFeedLinks(raw: unknown): HomeFeedLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => {
    const link = (l ?? {}) as {
      href?: string;
      name?: string;
      nameAlt?: string;
    };
    return { href: link.href, name: link.name || link.nameAlt || "" };
  });
}

/**
 * Whether the paired extension understood the `objectAll` scrape take. A build
 * that predates it ignores the take and returns the field as plain text, so
 * `row.links` arrives as a string rather than an array. Attribution still
 * degrades gracefully (events emit with author names, just no slugs), but the
 * caller surfaces this so a stale extension is observable rather than silent.
 * A card with genuinely no profile links yields `[]`, which is indistinguishable
 * from support — so support is inferred from ANY row producing an array.
 */
export function homeFeedObjectAllSupported(rows: HomeFeedRow[]): boolean {
  const withLinks = rows.filter((r) => r?.links !== undefined);
  if (withLinks.length === 0) return true; // no evidence either way — assume ok
  return withLinks.some((r) => Array.isArray(r.links));
}

/** Whether an href points at a `/company/` page rather than a member. */
function isCompanyHref(href?: string): boolean {
  return /\/company\//i.test(href ?? "");
}

/**
 * Resolve a member's `/in/<slug>` from the card's anchors by matching a target
 * display name to the anchor's accessible name. Matching by NAME (not DOM
 * position) makes attribution robust to link count and order.
 *
 * Attribution requires the name to resolve UNAMBIGUOUSLY to one member. It
 * returns undefined when:
 *  - a company anchor shares the name (the target is that company, e.g. a
 *    company author whose name also appears on a person mention), or
 *  - more than one distinct member slug matches the name.
 * This prevents a same-named person mention from being promoted to author when
 * the real author is a company or a different same-named person.
 */
function resolveMemberSlug(
  links: HomeFeedLink[],
  targetName: string
): string | undefined {
  const target = nameKey(targetName);
  if (!target) return undefined;
  const memberSlugs = new Set<string>();
  let companyMatch = false;
  for (const link of links) {
    if (nameKey(linkDisplayName(link)) !== target) continue;
    const slug = normalizeLinkedInSlug(link.href);
    if (slug) memberSlugs.add(slug);
    else if (isCompanyHref(link.href)) companyMatch = true;
  }
  if (companyMatch || memberSlugs.size !== 1) return undefined;
  return [...memberSlugs][0];
}

/**
 * The home feed mixes in ads, suggestions, and non-post noise. These never
 * become useful events, so drop them before emitting. Heuristic by necessity —
 * the home feed has no structured "is this an ad" field over the content-script
 * scrape.
 */
export function isHomeFeedNoise(
  body: string,
  signals: {
    authorControlLabel?: string;
    hasDurableIdentity?: boolean;
  } = {}
): boolean {
  if (!body || body.trim().length < 30) return true;
  if (/\bPromoted\b/i.test(body.slice(0, 130))) return true;
  if (/\bSuggested\b/i.test(body.slice(0, 30))) return true;
  // Current feed modules use the same outer componentkey shape and "Feed post"
  // prefix as posts, but have neither a post control nor an author/time header.
  // Real member/company cards expose at least one of those signals. Keeping the
  // header fallback makes a broken control-menu selector fail the durable-id
  // health check instead of silently dropping genuine posts.
  const text = body.replace(/^feed post\s+/i, "").trim();
  const hasMemberHeader = text.includes(" • ") || /^\S.+\s+Author\b/.test(text);
  const hasPostControl = Boolean(
    parseAuthorControlLabel(signals.authorControlLabel)
  );
  return !hasMemberHeader && !hasPostControl && !signals.hasDurableIdentity;
}

interface HomeFeedEngagement {
  reactions?: number;
  comments?: number;
  reposts?: number;
}

interface HomeFeedCommentIdentity {
  urn: string;
  parentNamespace: "activity" | "share" | "ugcPost";
  parentId: string;
  commentId: string;
}

interface HomeFeedRowContext {
  author: string;
  authorSlug?: string;
  postUrl?: string;
  metadata: Record<string, unknown>;
}

function homeFeedPostIdentityKey(
  row: HomeFeedRow,
  context: HomeFeedRowContext
): string | undefined {
  for (const raw of [context.postUrl, row.post_identity]) {
    if (!raw) continue;
    const match = raw.match(
      /(?:(shareId|ugcPostId)=|urn:li:(activity|share|ugcPost):)(\d{6,})/i
    );
    if (!match) continue;
    return `${linkedInUrnNamespace(match[1] ?? match[2] ?? "")}:${match[3]}`;
  }
  return undefined;
}

function homeFeedPostOriginId(identityKey: string): string {
  return `li_home_${identityKey.replace(":", "_")}`;
}

function parseHomeFeedCommentIdentity(
  raw: string | undefined
): HomeFeedCommentIdentity | undefined {
  if (!raw) return undefined;
  const match = raw.match(
    /(urn:li:comment:\(urn:li:(activity|share|ugcPost):(\d+),(\d+)\))/i
  );
  if (!match) return undefined;
  return {
    urn: match[1],
    parentNamespace: linkedInUrnNamespace(match[2]) as
      | "activity"
      | "share"
      | "ugcPost",
    parentId: match[3],
    commentId: match[4],
  };
}

function parseLinkedInCompactCount(raw: string): number {
  const match = raw.trim().match(/^(\d[\d,.]*)(?:\s*([kmb]))?$/i);
  if (!match) return 0;
  const base = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return 0;
  const multiplier =
    match[2]?.toLowerCase() === "b"
      ? 1_000_000_000
      : match[2]?.toLowerCase() === "m"
        ? 1_000_000
        : match[2]?.toLowerCase() === "k"
          ? 1_000
          : 1;
  return Math.round(base * multiplier);
}

function maxHomeFeedCounter(
  ...values: Array<string | undefined>
): number | undefined {
  let max = 0;
  for (const value of values) {
    if (!value) continue;
    for (const match of value.matchAll(/\b(\d[\d,.]*(?:\s*[kmb])?)\b/gi)) {
      max = Math.max(max, parseLinkedInCompactCount(match[1]));
    }
  }
  return max > 0 ? max : undefined;
}

function homeFeedReactionCount(row: HomeFeedRow): number | undefined {
  for (const value of [row.reaction_count_text, row.reaction_count_label]) {
    const others = value?.match(
      /\band\s+(\d[\d,.]*(?:\s*[kmb])?)\s+others?\s+reacted\b/i
    );
    if (others) return parseLinkedInCompactCount(others[1]) + 1;
  }

  const explicitTotal = maxHomeFeedCounter(row.reaction_count_text);
  if (explicitTotal !== undefined) return explicitTotal;

  const label = row.reaction_count_label;
  if (!label) return undefined;
  return maxHomeFeedCounter(label);
}

export function parseHomeFeedEngagement(row: HomeFeedRow): HomeFeedEngagement {
  return {
    reactions: homeFeedReactionCount(row),
    comments: maxHomeFeedCounter(
      row.comment_count_text,
      row.comment_count_label
    ),
    reposts: maxHomeFeedCounter(row.repost_count_text, row.repost_count_label),
  };
}

interface HomeFeedCommentCoverageSummary {
  threads: number;
  expected: number;
  collected: number;
  incomplete: number;
  unsupported: number;
  timedOut: number;
  details: string[];
}

/**
 * Prove completeness from the browser runtime's per-post expansion result.
 * The independently parsed LinkedIn counter is authoritative: a stale runtime
 * that omits coverage, or an expansion selector that reads a different count,
 * fails closed instead of silently persisting a visible-only comment subset.
 */
function summarizeHomeFeedCommentCoverage(
  rows: HomeFeedRow[]
): HomeFeedCommentCoverageSummary {
  const byPost = new Map<
    string,
    { advertised: number; coverage?: HomeFeedCommentCoverage }
  >();
  for (const row of rows) {
    if (!row?.id || parseHomeFeedCommentIdentity(row.id)) continue;
    const advertised = parseHomeFeedEngagement(row).comments ?? 0;
    const expected = Math.max(advertised, row.comment_coverage?.expected ?? 0);
    if (expected <= 0) continue;
    const context = buildHomeFeedRowContext(row);
    if (isHomeFeedRowNoise(row, context)) continue;
    const identityKey = homeFeedPostIdentityKey(row, context);
    if (!identityKey) continue;
    const existing = byPost.get(identityKey);
    if (!existing || (!existing.coverage && row.comment_coverage)) {
      byPost.set(identityKey, {
        advertised: expected,
        ...(row.comment_coverage ? { coverage: row.comment_coverage } : {}),
      });
    }
  }

  let expected = 0;
  let collected = 0;
  let incomplete = 0;
  let unsupported = 0;
  let timedOut = 0;
  const details: string[] = [];
  for (const thread of byPost.values()) {
    expected += thread.advertised;
    if (!thread.coverage) {
      unsupported++;
      incomplete++;
      details.push(`${thread.advertised}/unknown/unknown`);
      continue;
    }
    collected += Math.min(thread.coverage.collected, thread.advertised);
    if (
      !thread.coverage.complete ||
      thread.coverage.expected !== thread.advertised ||
      thread.coverage.collected < thread.advertised
    ) {
      incomplete++;
      if (thread.coverage.timedOut) timedOut++;
      details.push(
        `${thread.advertised}/${thread.coverage.expected}/${thread.coverage.collected}`
      );
    }
  }
  return {
    threads: byPost.size,
    expected,
    collected,
    incomplete,
    unsupported,
    timedOut,
    details,
  };
}

function homeFeedEngagementMetadata(
  counts: HomeFeedEngagement
): Record<string, number> {
  return {
    ...(counts.reactions ? { reactions: counts.reactions } : {}),
    ...(counts.comments ? { comments: counts.comments } : {}),
    ...(counts.reposts ? { reposts: counts.reposts } : {}),
  };
}

function homeFeedEngagementScore(counts: HomeFeedEngagement): number {
  return Math.min(
    (counts.reactions ?? 0) +
      (counts.comments ?? 0) * 2 +
      (counts.reposts ?? 0) * 3,
    100
  );
}

function normalizeHomeFeedMedia(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const attachments: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as HomeFeedMedia;
    if (!candidate.url) continue;
    let url: URL;
    try {
      url = new URL(candidate.url, "https://www.linkedin.com");
    } catch {
      continue;
    }
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "media.licdn.com" ||
        url.hostname.endsWith(".licdn.com")
      ) ||
      /(?:profile-displayphoto|company-logo)/i.test(url.pathname) ||
      seen.has(url.href)
    ) {
      continue;
    }
    seen.add(url.href);
    const altText = candidate.alt_text?.trim();
    attachments.push({
      kind: "image",
      url: url.href,
      ...(altText ? { alt_text: altText } : {}),
    });
  }
  return attachments;
}

function buildHomeFeedRowContext(row: HomeFeedRow): HomeFeedRowContext {
  const parsedAuthor = parseHomeFeedAuthorDetails(row.body ?? "");
  const domAuthor = cleanHomeFeedDisplayName(
    (row.author ?? "").trim().split(" • ")[0] ?? ""
  );
  const actorBanner =
    parsedAuthor.banner?.kind === "actor" ? parsedAuthor.banner : null;
  const controlAuthor = parseAuthorControlLabel(row.author_control_label);
  let banner = parsedAuthor.banner;
  if (actorBanner && controlAuthor) {
    if (nameKey(parsedAuthor.author) !== nameKey(controlAuthor)) banner = null;
  } else if (
    actorBanner &&
    domAuthor &&
    actorBanner.actor.localeCompare(domAuthor, undefined, {
      sensitivity: "accent",
    }) !== 0
  ) {
    banner = null;
  }
  const author =
    controlAuthor ||
    (banner ? parsedAuthor.author : "") ||
    domAuthor ||
    parsedAuthor.author;
  const links = normalizeHomeFeedLinks(row.links);
  const engagement = banner?.kind === "actor" ? banner : null;
  const authorSlug = resolveMemberSlug(links, author);
  const engagerSlug = engagement
    ? resolveMemberSlug(links, engagement.actor)
    : undefined;
  const profileUrlFor = (slug: string) => `https://www.linkedin.com/in/${slug}`;
  const counts = parseHomeFeedEngagement(row);
  const metadata: Record<string, unknown> = {
    author,
    ...homeFeedEngagementMetadata(counts),
  };
  if (engagement) {
    metadata.social_actor = engagement.actor;
    metadata.social_action = engagement.action;
    if (engagerSlug) {
      metadata.social_actor_slug = engagerSlug;
      metadata.social_actor_profile_url = profileUrlFor(engagerSlug);
    }
  }
  if (authorSlug) {
    metadata.author_linkedin_slug = authorSlug;
    metadata.author_profile_url = profileUrlFor(authorSlug);
  }

  const embeddedUrn = row.post_identity?.match(
    /(?:(shareId|ugcPostId)=|urn:li:(activity|share|ugcPost):)(\d{6,})/i
  );
  const embeddedId = embeddedUrn?.[3];
  const embeddedNamespace = linkedInUrnNamespace(
    embeddedUrn?.[1] ?? embeddedUrn?.[2] ?? ""
  );
  const postUrl = normalizeLinkedInPostUrl(
    row.post_url ??
      (embeddedId ? `urn:li:${embeddedNamespace}:${embeddedId}` : "")
  );
  return {
    author,
    authorSlug,
    postUrl: postUrl || undefined,
    metadata,
  };
}

function isHomeFeedRowNoise(
  row: HomeFeedRow,
  context: HomeFeedRowContext
): boolean {
  return isHomeFeedNoise(row.body ?? "", {
    authorControlLabel: row.author_control_label,
    hasDurableIdentity: Boolean(homeFeedPostIdentityKey(row, context)),
  });
}

/**
 * Map cs_scrape home-feed rows to event envelopes. A scraped permalink still
 * wins when a row carries one, but current cards expose none, so the canonical
 * post identity is normally the activity/share/ugcPost id embedded in
 * `post_identity`. The scrape-only componentkey never becomes an event origin,
 * and a post without either durable identity is not emitted. Native comments
 * carry their own durable id and point at the stable parent-post origin.
 * Home-feed posts expose no reliable timestamp, so the caller stamps
 * occurred_at with the sync time.
 */
export function buildHomeFeedEvents(
  rows: HomeFeedRow[],
  occurredAt: Date
): EventEnvelope[] {
  const seenOrigins = new Set<string>();
  const events: EventEnvelope[] = [];
  // Each row carries its own context: LinkedIn recycles the componentkey, so
  // keying per-row state on row.id would let one card's author and permalink
  // stand in for a different post that reused the key.
  const prepared: Array<{
    row: HomeFeedRow;
    body: string;
    context: HomeFeedRowContext;
    nativeIdentity?: HomeFeedCommentIdentity;
    parentCommentIdentity?: HomeFeedCommentIdentity;
  }> = [];
  const postContextsByIdentity = new Map<string, HomeFeedRowContext>();
  const commentContextsById = new Map<string, HomeFeedRowContext>();
  for (const row of rows) {
    if (!row?.id || !row.body) continue;
    const nativeIdentity = parseHomeFeedCommentIdentity(row.id);
    const enclosingCommentIdentity = parseHomeFeedCommentIdentity(
      row.parent_comment_identity
    );
    const parentCommentIdentity =
      enclosingCommentIdentity?.commentId !== nativeIdentity?.commentId
        ? enclosingCommentIdentity
        : undefined;
    const context = buildHomeFeedRowContext(row);
    if (!nativeIdentity && isHomeFeedRowNoise(row, context)) {
      continue;
    }
    prepared.push({
      row,
      body: row.body,
      context,
      ...(nativeIdentity ? { nativeIdentity } : {}),
      ...(parentCommentIdentity ? { parentCommentIdentity } : {}),
    });
    if (nativeIdentity) {
      commentContextsById.set(nativeIdentity.commentId, context);
    } else {
      const identityKey = homeFeedPostIdentityKey(row, context);
      if (identityKey && !postContextsByIdentity.has(identityKey)) {
        postContextsByIdentity.set(identityKey, context);
      }
    }
  }
  for (const {
    row,
    body,
    context,
    nativeIdentity,
    parentCommentIdentity,
  } of prepared) {
    if (nativeIdentity) {
      const originId = `li_comment_${nativeIdentity.commentId}`;
      if (seenOrigins.has(originId)) continue;
      seenOrigins.add(originId);
      const parentIdentityKey = `${nativeIdentity.parentNamespace}:${nativeIdentity.parentId}`;
      const parentOriginId = homeFeedPostOriginId(parentIdentityKey);
      const immediateParentOriginId = parentCommentIdentity
        ? `li_comment_${parentCommentIdentity.commentId}`
        : parentOriginId;
      const parent = postContextsByIdentity.get(parentIdentityKey);
      const parentComment = parentCommentIdentity
        ? commentContextsById.get(parentCommentIdentity.commentId)
        : undefined;
      const sourceUrl =
        parent?.postUrl ??
        normalizeLinkedInPostUrl(
          `urn:li:${nativeIdentity.parentNamespace}:${nativeIdentity.parentId}`
        );
      const counts = parseHomeFeedEngagement(row);
      const commentMetadata: Record<string, unknown> = {
        ...context.metadata,
        ...homeFeedEngagementMetadata(counts),
        parent_post_origin_id: parentOriginId,
        comment_urn: nativeIdentity.urn,
        comment_id: nativeIdentity.commentId,
        parent_activity_id: nativeIdentity.parentId,
        parent_activity_namespace: nativeIdentity.parentNamespace,
      };
      if (parentCommentIdentity) {
        commentMetadata.parent_comment_origin_id = immediateParentOriginId;
        commentMetadata.parent_comment_id = parentCommentIdentity.commentId;
        commentMetadata.is_reply = true;
        if (parentComment) {
          commentMetadata.parent_comment_author = parentComment.author;
          if (parentComment.authorSlug) {
            commentMetadata.parent_comment_author_linkedin_slug =
              parentComment.authorSlug;
            commentMetadata.parent_comment_author_profile_url = `https://www.linkedin.com/in/${parentComment.authorSlug}`;
          }
        }
      }
      if (parent) {
        commentMetadata.parent_author = parent.author;
        if (parent.authorSlug) {
          commentMetadata.parent_author_linkedin_slug = parent.authorSlug;
          commentMetadata.parent_author_profile_url = `https://www.linkedin.com/in/${parent.authorSlug}`;
        }
      }
      events.push({
        origin_id: originId,
        origin_parent_id: immediateParentOriginId,
        payload_text: body,
        attachments: normalizeHomeFeedMedia(row.comment_media),
        author_name: context.author,
        occurred_at: occurredAt,
        origin_type: "comment",
        ...(sourceUrl ? { source_url: sourceUrl } : {}),
        score: homeFeedEngagementScore(counts),
        metadata: commentMetadata,
      });
      continue;
    }

    const identityKey = homeFeedPostIdentityKey(row, context);
    if (!identityKey) continue;
    const originId = homeFeedPostOriginId(identityKey);
    if (seenOrigins.has(originId)) continue;
    seenOrigins.add(originId);
    const counts = parseHomeFeedEngagement(row);
    // The identity key already proved a durable post id, so a canonical URL is
    // always derivable. Deriving it from the key is the normal path now that
    // post_url comes back empty; it also covers a scraped permalink that did
    // not normalize (post_url holding the bare /feed/ surface).
    const sourceUrl =
      context.postUrl ?? normalizeLinkedInPostUrl(`urn:li:${identityKey}`);

    events.push({
      origin_id: originId,
      payload_text: body,
      attachments: normalizeHomeFeedMedia(row.post_media),
      author_name: context.author,
      // Feed posts expose no reliable timestamp; use the sync time.
      occurred_at: occurredAt,
      origin_type: "post",
      score: homeFeedEngagementScore(counts),
      // source_url is the durable post handle action callers (prepare_comment)
      // resolve directly.
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      metadata: context.metadata,
    });
  }
  return events;
}

/**
 * Pull the chrome action dispatcher from sessionState. The connector-worker
 * host splices a live `chrome_dispatcher` object
 * onto every sync's sessionState; the dispatcher's `dispatch()` rides an
 * IPC channel up to the daemon and out to the gateway's
 * /api/workers/dispatch-chrome-action bridge. When no paired Owletto
 * extension is online in the connection's org, the bridge returns the
 * `failed` status and the dispatcher throws — we surface that as the sync
 * failure verbatim.
 */
function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = (
    ctx.sessionState as Record<string, unknown> | null | undefined
  )?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "LinkedIn connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge."
    );
  }
  return handle;
}

// ── prepare_comment handoff (browser stage, human submits) ───────────

/** Interactive a11y node from chrome `get_accessibility_tree`. */
type A11yNode = {
  ref_id: number;
  role?: string;
  name?: string;
  tag?: string;
  href?: string;
};

type ElementRef = {
  document_epoch: number;
  ref_id: number;
};

type PrepareCommentResult = {
  prepared: boolean;
  tab_id: number;
  post_url: string;
  body: string;
  /** How the composer was filled: evaluate or the a11y type_ref fallback. */
  method: "type_ref" | "evaluate";
  /** Whether the in-page handoff banner was injected. */
  banner_shown?: boolean;
  /** Truncated reason shown on the banner (if any). */
  reason_preview?: string;
  message: string;
};

/**
 * Canonical casing for the LinkedIn URN namespace an id came from. share and
 * ugcPost ids live in different id spaces than activity ids, so the namespace
 * has to survive normalization; /feed/update/ resolves all three.
 */
function linkedInUrnNamespace(token: string): "activity" | "share" | "ugcPost" {
  const normalized = token.toLowerCase();
  if (normalized === "shareid" || normalized === "share") return "share";
  if (normalized === "ugcpostid" || normalized === "ugcpost") return "ugcPost";
  return "activity";
}

/**
 * Normalize a post URL or activity id into a linkedin.com update URL.
 * Accepts full URLs, `urn:li:activity:…` / `urn:li:share:…` /
 * `urn:li:ugcPost:…`, bare activity digits, or `/feed/update/…` paths.
 */
export function normalizeLinkedInPostUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // Bare activity id (digits only, possibly with li_post_ prefix from events).
  const bareId = raw.replace(/^li_post_/, "");
  if (/^\d{6,}$/.test(bareId)) {
    return `https://www.linkedin.com/feed/update/urn:li:activity:${bareId}`;
  }

  // urn:li:activity:123, urn:li:share:123, urn:li:ugcPost:123, or the bare
  // `activity:123` shorthand.
  const urnMatch = raw.match(/(?:urn:li:)?(activity|share|ugcPost):(\d{6,})/i);
  if (urnMatch && !raw.includes("://") && !raw.startsWith("/")) {
    const ns = linkedInUrnNamespace(urnMatch[1] ?? "");
    return `https://www.linkedin.com/feed/update/urn:li:${ns}:${urnMatch[2] ?? ""}`;
  }

  try {
    const withScheme = raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
        ? `https://www.linkedin.com${raw}`
        : raw.includes("://")
          ? raw
          : `https://${raw}`;
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.protocol = "https:";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) {
      return null;
    }
    // Prefer canonical feed/update URLs when we can extract a post id, keeping
    // whichever URN namespace the source URL used.
    const urnInUrl = `${u.pathname}${u.search}`.match(
      /(?:urn(?::|%3A)li(?::|%3A))?(activity|share|ugcPost)(?::|%3A|-)(\d{6,})/i
    );
    if (urnInUrl) {
      const ns = linkedInUrnNamespace(urnInUrl[1] ?? "");
      return `https://www.linkedin.com/feed/update/urn:li:${ns}:${urnInUrl[2] ?? ""}`;
    }
    return null;
  } catch {
    return null;
  }
}

function isLinkedInShortPostUrl(input: string | undefined): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      url.hostname === "lnkd.in" &&
      url.pathname.startsWith("/p/")
    );
  } catch {
    return false;
  }
}

/** Resolve LinkedIn's Copy-link short URL to its durable post URN URL. */
export async function resolveLinkedInShortPostUrl(
  input: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  let shortUrl: URL;
  try {
    shortUrl = new URL(input);
  } catch {
    return null;
  }
  if (!isLinkedInShortPostUrl(shortUrl.href)) return null;

  try {
    const response = await fetchImpl(shortUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const location = response.headers.get("location");
    if (!location) return normalizeLinkedInPostUrl(response.url);
    return normalizeLinkedInPostUrl(new URL(location, shortUrl).href);
  } catch {
    return null;
  }
}

export async function resolveHomeFeedPostUrls(
  rows: HomeFeedRow[],
  fetchImpl: typeof fetch = fetch
): Promise<HomeFeedRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      const postUrl = row.post_url?.trim();
      if (!postUrl || normalizeLinkedInPostUrl(postUrl)) return row;
      const resolved = await resolveLinkedInShortPostUrl(postUrl, fetchImpl);
      return resolved ? { ...row, post_url: resolved } : row;
    })
  );
}

function unresolvedHomeFeedPostCount(rows: HomeFeedRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (!row?.id || !row.body) continue;
    const context = buildHomeFeedRowContext(row);
    if (
      parseHomeFeedCommentIdentity(row.id) ||
      isHomeFeedRowNoise(row, context)
    ) {
      continue;
    }
    if (!homeFeedPostIdentityKey(row, context)) count += 1;
  }
  return count;
}

function unresolvedHomeFeedShortUrlCount(rows: HomeFeedRow[]): number {
  return rows.filter((row) => {
    if (!row?.id || !row.body || parseHomeFeedCommentIdentity(row.id)) {
      return false;
    }
    const context = buildHomeFeedRowContext(row);
    return (
      !isHomeFeedRowNoise(row, context) && isLinkedInShortPostUrl(row.post_url)
    );
  }).length;
}

/** True when navigate landed on login / authwall rather than the post. */
export function isLinkedInAuthWall(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("/login") ||
    lower.includes("/authwall") ||
    lower.includes("/checkpoint") ||
    lower.includes("uas/login")
  );
}

function nameMatches(name: string | undefined, patterns: RegExp[]): boolean {
  if (!name) return false;
  const n = name.trim();
  return patterns.some((re) => re.test(n));
}

/**
 * Labels that would *submit* a comment/post. prepare_comment must never click
 * these — only the human hits Post.
 */
export function isCommentSubmitLabel(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = name.replace(/\s+/g, " ").trim();
  if (/^(post|submit|send|publish|share)$/i.test(n)) return true;
  if (/^(post|submit|send)\s+(comment|reply)$/i.test(n)) return true;
  return false;
}

/** Labels that open the composer (not submit). */
export function isCommentOpenLabel(name: string | undefined | null): boolean {
  if (!name) return false;
  if (isCommentSubmitLabel(name)) return false;
  const n = name.replace(/\s+/g, " ").trim();
  return (
    /^comment$/i.test(n) ||
    /^comments$/i.test(n) ||
    /^comment on /i.test(n) ||
    /^leave a comment/i.test(n) ||
    /^post a comment/i.test(n)
  );
}

/**
 * Prefer the social-action "Comment" control (not "Add a comment…" textbox,
 * not "Post" submit). Names vary by locale; this path is English-first.
 */
export function pickCommentButtonRef(
  tree: A11yNode[],
  documentEpoch: number
): ElementRef | null {
  // Prefer explicit buttons over links/generics.
  const ranked = [...tree].sort((a, b) => {
    const score = (n: A11yNode) =>
      n.role === "button" || n.tag === "button" ? 0 : 1;
    return score(a) - score(b);
  });
  for (const node of ranked) {
    if (!isCommentOpenLabel(node.name)) continue;
    // Skip textboxes that happen to have "comment" in the name.
    if (node.role === "textbox" || node.tag === "textarea") continue;
    return { document_epoch: documentEpoch, ref_id: node.ref_id };
  }
  return null;
}

/**
 * Find the comment composer textbox. LinkedIn uses contenteditable/Quill
 * editors that surface as role=textbox with names like "Add a comment…".
 */
export function pickCommentTextboxRef(
  tree: A11yNode[],
  documentEpoch: number
): ElementRef | null {
  const goodName = [
    /add a comment/i,
    /write a comment/i,
    /leave a comment/i,
    /^comment$/i,
    /text editor/i,
  ];
  const candidates = tree.filter((n) => n.role === "textbox");
  for (const node of candidates) {
    if (nameMatches(node.name, goodName)) {
      return { document_epoch: documentEpoch, ref_id: node.ref_id };
    }
  }
  // Any textbox whose name mentions comment.
  for (const node of candidates) {
    if (node.name && /comment/i.test(node.name)) {
      return { document_epoch: documentEpoch, ref_id: node.ref_id };
    }
  }
  // Last resort: empty-named textboxes are common once the composer is open.
  const emptyTextboxes = candidates.filter((n) => !n.name?.trim());
  if (emptyTextboxes.length === 1) {
    return {
      document_epoch: documentEpoch,
      ref_id: emptyTextboxes[0]!.ref_id,
    };
  }
  return null;
}

function chromeOriginsInput(): { allowed_origins: string[] } {
  return { allowed_origins: LINKEDIN_ALLOWED_ORIGINS };
}

type TreeSnapshot = {
  document_epoch: number;
  tree: A11yNode[];
  current_url?: string;
};

async function snapshotTree(
  dispatcher: ChromeActionDispatcher,
  tabId: number
): Promise<TreeSnapshot> {
  const out = await dispatcher.dispatch<TreeSnapshot & Record<string, unknown>>(
    "get_accessibility_tree",
    {
      tab_id: tabId,
      filter: "interactive",
      ...chromeOriginsInput(),
    }
  );
  const tree = Array.isArray(out.tree) ? (out.tree as A11yNode[]) : [];
  const document_epoch =
    typeof out.document_epoch === "number" ? out.document_epoch : 0;
  return {
    document_epoch,
    tree,
    current_url:
      typeof out.current_url === "string" ? out.current_url : undefined,
  };
}

/** Cap the explanation shown in the in-page banner. */
export function truncateHandoffReason(
  reason: string | undefined | null,
  maxLen = 120
): string | undefined {
  if (reason == null) return undefined;
  const t = reason.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/**
 * JS expression: inject a small Lobu handoff banner on the page.
 * The banner points the user to the side panel for the run details.
 * Best-effort; LinkedIn re-renders may remove it.
 */
export function buildInjectHandoffBannerExpression(opts: {
  reason?: string;
  title?: string;
}): string {
  const title = opts.title ?? "Lobu staged this comment";
  const reason = truncateHandoffReason(opts.reason);
  const titleLit = JSON.stringify(title);
  const reasonLit = JSON.stringify(reason ?? null);
  return `(async()=>{
  const TITLE = ${titleLit};
  const REASON = ${reasonLit};
  const ID = 'lobu-handoff-banner';
  try {
    const prev = document.getElementById(ID);
    if (prev) prev.remove();
  } catch (_) {}

  const root = document.createElement('div');
  root.id = ID;
  root.setAttribute('role', 'status');
  root.setAttribute('data-lobu', 'handoff-banner');
  // Keep styles self-contained; avoid LinkedIn class collisions.
  root.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483646',
    'max-width:min(520px,calc(100vw - 24px))',
    'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
    'color:#0f172a',
    'background:#fff',
    'border:1px solid #cbd5e1',
    'border-left:4px solid #0ea5e9',
    'border-radius:10px',
    'box-shadow:0 8px 28px rgba(15,23,42,.18)',
    'padding:10px 12px',
    'display:flex',
    'gap:10px',
    'align-items:flex-start',
    'pointer-events:auto',
  ].join(';');

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0';

  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;margin:0 0 2px;color:#0c4a6e';
  head.textContent = TITLE;

  const line = document.createElement('div');
  line.style.cssText = 'color:#334155;margin:0 0 2px';
  line.textContent = 'Review the draft and click Post yourself — Lobu did not submit.';

  body.appendChild(head);
  body.appendChild(line);

  if (REASON) {
    const why = document.createElement('div');
    why.style.cssText = 'color:#64748b;margin:4px 0 0;font-size:12px';
    why.textContent = 'Why: ' + REASON;
    body.appendChild(why);
  }

  const foot = document.createElement('div');
  foot.style.cssText = 'color:#64748b;margin:4px 0 0;font-size:12px';
  foot.textContent = 'After posting or editing, record the outcome in Lobu Activity. You can also reject it with a reason.';
  body.appendChild(foot);

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.style.cssText = [
    'flex:none',
    'border:0',
    'background:transparent',
    'color:#64748b',
    'font:20px/1 sans-serif',
    'cursor:pointer',
    'padding:0 2px',
  ].join(';');
  close.onclick = function () { try { root.remove(); } catch (_) {} };

  root.appendChild(body);
  root.appendChild(close);

  // Prefer anchoring near the comment composer when we can find it.
  let anchored = false;
  try {
    const composer =
      document.querySelector('.comments-comment-box-comment__text-editor .ql-editor') ||
      document.querySelector('.comments-comment-box__form .ql-editor') ||
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (composer) {
      const host =
        composer.closest('.comments-comment-box') ||
        composer.closest('form') ||
        composer.parentElement;
      if (host && host.parentElement) {
        root.style.position = 'relative';
        root.style.top = '0';
        root.style.left = '0';
        root.style.transform = 'none';
        root.style.margin = '8px 0 12px';
        root.style.maxWidth = '100%';
        host.parentElement.insertBefore(root, host);
        anchored = true;
      }
    }
  } catch (_) {}

  if (!anchored) {
    (document.body || document.documentElement).appendChild(root);
  }

  // No auto-dismiss: the draft lives in the user's page, so its context should
  // still be present when the user returns later. The dismiss button remains.

  return { ok: true, anchored: anchored, has_reason: !!REASON };
})()`;
}

/** JS expression: open the comment composer if collapsed, then fill it. */
export function buildFillCommentExpression(body: string): string {
  // JSON.stringify for safe embedding of the draft text.
  const textLit = JSON.stringify(body);
  return `(async()=>{
  const text = ${textLit};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findComposer() {
    const selectors = [
      '.comments-comment-box-comment__text-editor .ql-editor',
      '.comments-comment-box__form .ql-editor',
      'form.comments-comment-box__form div.ql-editor',
      'div.comments-comment-texteditor .ql-editor',
      'div.ql-editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="comment" i]',
      'div[contenteditable="true"][data-placeholder*="comment" i]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && visible(el)) return el;
      } catch (_) {}
    }
    // Broader: any visible contenteditable textbox in a comments region.
    const regions = document.querySelectorAll(
      '.comments-comment-box, .feed-shared-update-v2__comments-container, [class*="comments-comment"]'
    );
    for (const region of regions) {
      const el = region.querySelector('[contenteditable="true"]');
      if (el && visible(el)) return el;
    }
    return null;
  }

  // SAFETY: never click submit controls. Only the human posts.
  function isSubmitLabel(label) {
    const n = String(label || '').replace(/\\s+/g, ' ').trim();
    if (/^(post|submit|send|publish|share)$/i.test(n)) return true;
    if (/^(post|submit|send)\\s+(comment|reply)$/i.test(n)) return true;
    return false;
  }
  function isOpenLabel(label) {
    if (isSubmitLabel(label)) return false;
    const n = String(label || '').replace(/\\s+/g, ' ').trim();
    return (
      /^comment$/i.test(n) ||
      /^comments$/i.test(n) ||
      /^comment on /i.test(n) ||
      /^leave a comment/i.test(n) ||
      /^post a comment/i.test(n)
    );
  }

  function openComposer() {
    if (findComposer()) return true;
    const nodes = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );
    for (const el of nodes) {
      if (!visible(el)) continue;
      const label = (
        el.getAttribute('aria-label') ||
        el.innerText ||
        el.textContent ||
        ''
      )
        .replace(/\\s+/g, ' ')
        .trim();
      if (isSubmitLabel(label)) continue;
      if (isOpenLabel(label)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  openComposer();
  await sleep(600);
  let composer = findComposer();
  if (!composer) {
    openComposer();
    await sleep(800);
    composer = findComposer();
  }
  if (!composer) {
    return { ok: false, reason: 'composer_not_found' };
  }

  composer.focus();
  try {
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
  } catch (_) {
    composer.textContent = '';
  }
  // insertText only — never Enter / Cmd+Enter (those can submit on LinkedIn).
  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }
  await sleep(100);
  const got = (composer.innerText || composer.textContent || '').trim();
  // Scroll composer into view so the human sees the draft. Do NOT click Post.
  try { composer.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
  return {
    ok: got.length > 0,
    reason: got.length > 0 ? 'typed' : 'empty_after_type',
    preview: got.slice(0, 120),
    used_insert_text: !!inserted,
    submitted: false,
  };
})()`;
}

/**
 * Stage a LinkedIn comment in the exact user-opened page: activate → fill
 * composer. The ordinary Lobu notification is created by the calling Automation.
 *
 * HARD RULE — never auto-post:
 *  - never click Post / Submit / Send
 *  - never press Enter / Cmd+Enter after typing
 *  - only open the composer (Comment) + type draft text
 * The human must click Post themselves.
 */
export async function prepareLinkedInComment(
  dispatcher: ChromeActionDispatcher,
  opts: {
    postUrl: string;
    body: string;
    /** Short explanation for the in-page banner. */
    reason?: string;
    /** Inject in-page handoff banner (default true). */
    banner?: boolean;
  }
): Promise<PrepareCommentResult> {
  const body = opts.body.trim();
  if (!body) {
    throw new Error("prepare_comment: body must be non-empty");
  }
  const postUrl = normalizeLinkedInPostUrl(opts.postUrl);
  if (!postUrl) {
    throw new Error(
      `prepare_comment: invalid post_url / activity_id: ${JSON.stringify(opts.postUrl)}`
    );
  }
  const banner = opts.banner !== false;
  const reasonPreview = truncateHandoffReason(opts.reason);

  // Refuse accidental submit clicks through the chrome dispatcher.
  const safeDispatch: ChromeActionDispatcher = {
    dispatch: async (action_key, action_input) => {
      if (action_key === "click_ref") {
        if (action_input.allowed_click !== "comment_open") {
          throw new Error(
            "prepare_comment: blocked click_ref — only comment-open is allowed (never Post/submit)"
          );
        }
      }
      const input = { ...action_input };
      delete input.allowed_click;
      return dispatcher.dispatch(action_key, input);
    },
  };

  const nav = await safeDispatch.dispatch<{
    tab_id?: number;
    current_url?: string;
    title?: string;
  }>("navigate", {
    url: postUrl,
    require_page_activation: true,
    ...chromeOriginsInput(),
  });
  const tabId = nav.tab_id;
  if (typeof tabId !== "number") {
    throw new Error("prepare_comment: navigate did not return tab_id");
  }
  if (isLinkedInAuthWall(nav.current_url)) {
    throw new Error(
      `Not logged into LinkedIn (landed on ${nav.current_url}). Sign in in the paired Chrome profile, then retry.`
    );
  }

  // Give the post chrome a beat to hydrate the social-action bar.
  try {
    await safeDispatch.dispatch("wait_for_selector", {
      tab_id: tabId,
      selector:
        'button, [role="button"], .feed-shared-social-action-bar, .comments-comment-box',
      timeout_ms: 8000,
      ...chromeOriginsInput(),
    });
  } catch {
    // Non-fatal — page may still be usable; fall through to a11y/evaluate.
  }

  let method: "type_ref" | "evaluate" = "evaluate";
  let typed = false;

  // LinkedIn's current feed/post UI rarely exposes the
  // Quill composer as an a11y textbox after clicking Comment, so evaluate
  // (contenteditable/ql-editor selectors + insertText) is the primary path.
  // type_ref remains a secondary attempt when the tree does surface a textbox.
  {
    let evalOut:
      | {
          value?: {
            ok?: boolean;
            reason?: string;
            preview?: string;
            submitted?: boolean;
          };
          exception?: string;
        }
      | undefined;
    try {
      evalOut = await safeDispatch.dispatch<{
        value?: {
          ok?: boolean;
          reason?: string;
          preview?: string;
          submitted?: boolean;
        };
        exception?: string;
      }>("evaluate", {
        tab_id: tabId,
        expression: buildFillCommentExpression(body),
        await_promise: true,
        ...chromeOriginsInput(),
      });
    } catch {
      // The a11y path below can still stage the draft when evaluate is blocked.
    }
    const value = evalOut?.value;
    if (value?.submitted === true) {
      throw new Error(
        "prepare_comment: fill expression reported submitted=true — aborting (must never auto-post)"
      );
    }
    if (!evalOut?.exception && value?.ok) {
      method = "evaluate";
      typed = true;
    }
  }

  // Path B: a11y type_ref when evaluate missed the composer.
  // Only click "Comment" open controls; never Post/submit.
  if (!typed) {
    try {
      let snap = await snapshotTree(safeDispatch, tabId);
      if (isLinkedInAuthWall(snap.current_url)) {
        throw new Error(
          `Not logged into LinkedIn (landed on ${snap.current_url}). Sign in in the paired Chrome profile, then retry.`
        );
      }

      let textbox = pickCommentTextboxRef(snap.tree, snap.document_epoch);
      if (!textbox) {
        const commentBtn = pickCommentButtonRef(snap.tree, snap.document_epoch);
        if (commentBtn) {
          await safeDispatch.dispatch("click_ref", {
            tab_id: tabId,
            ref: commentBtn,
            allowed_click: "comment_open",
            ...chromeOriginsInput(),
          });
          snap = await snapshotTree(safeDispatch, tabId);
          textbox = pickCommentTextboxRef(snap.tree, snap.document_epoch);
        }
      }

      if (textbox) {
        await safeDispatch.dispatch("type_ref", {
          tab_id: tabId,
          ref: textbox,
          text: body,
          clear_first: true,
          ...chromeOriginsInput(),
        });
        method = "type_ref";
        typed = true;
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("Not logged into LinkedIn") ||
          err.message.includes("blocked click_ref"))
      ) {
        throw err;
      }
    }
  }

  if (!typed) {
    throw new Error(
      "prepare_comment: could not fill comment composer (evaluate + a11y both missed it). Is the post still available and commentable?"
    );
  }

  let bannerShown = false;
  if (banner) {
    try {
      const bannerOut = await safeDispatch.dispatch<{
        value?: { ok?: boolean; anchored?: boolean };
        exception?: string;
      }>("evaluate", {
        tab_id: tabId,
        expression: buildInjectHandoffBannerExpression({
          reason: reasonPreview,
        }),
        await_promise: true,
        ...chromeOriginsInput(),
      });
      bannerShown = bannerOut.value?.ok === true && !bannerOut.exception;
    } catch {
      // Banner is best-effort; draft is already staged.
    }
  }

  return {
    prepared: true,
    tab_id: tabId,
    post_url: postUrl,
    body,
    method,
    banner_shown: bannerShown,
    reason_preview: reasonPreview,
    message:
      "Comment staged in your browser. Review the draft and click Post yourself — Lobu did not submit.",
  };
}

// ── verify_staged_comment (read: did the human Post?) ────────────────

export type ScrapedComment = {
  author?: string;
  text: string;
};

export type VerifyStagedCommentResult = {
  /** True when a visible comment matches the expected body. */
  verified: boolean;
  post_url: string;
  body: string;
  tab_id?: number;
  comments_scanned: number;
  match?: {
    author?: string;
    text_preview: string;
    match_kind: "exact" | "prefix" | "contains";
  };
  /** Why verification failed or was inconclusive. */
  reason?: string;
  message: string;
};

/** Collapse whitespace / case for comment body comparison. */
export function normalizeCommentMatchText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Match staged draft text against a scraped comment body.
 * Allows LinkedIn "…more" truncation and longer surrounding blocks.
 */
export function commentBodiesMatch(
  expected: string,
  actual: string
): { ok: true; kind: "exact" | "prefix" | "contains" } | { ok: false } {
  const e = normalizeCommentMatchText(expected);
  const a = normalizeCommentMatchText(actual);
  if (!e || !a) return { ok: false };
  if (a === e) return { ok: true, kind: "exact" };
  // Partial matches must be distinctive enough not to verify common phrases.
  if (Math.min(e.length, a.length) < 24) return { ok: false };
  // LinkedIn may truncate the visible comment before its "See more" control.
  if (e.startsWith(a)) return { ok: true, kind: "prefix" };
  // Some DOM variants wrap the comment body in a longer text block.
  if (a.includes(e)) return { ok: true, kind: "contains" };
  return { ok: false };
}

/**
 * JS expression: scrape visible comments on a LinkedIn post/permalink page.
 * Best-effort DOM selectors — LinkedIn class names churn.
 */
export function buildScrapeCommentsExpression(): string {
  return `(() => {
  const roots = [
    ...document.querySelectorAll('article.comments-comment-item'),
    ...document.querySelectorAll('.comments-comment-item'),
    ...document.querySelectorAll('.comments-comment-entity'),
    ...document.querySelectorAll('[class*="comments-comment-item"]'),
  ];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    if (seen.has(root)) continue;
    seen.add(root);
    const textEl =
      root.querySelector('.update-components-text') ||
      root.querySelector('.comments-comment-item__main-content') ||
      root.querySelector('[class*="comment-item__main"]') ||
      root.querySelector('.feed-shared-inline-show-more-text') ||
      root.querySelector('[data-test-id="main-feed-activity-card"] span[dir="ltr"]') ||
      root.querySelector('span[dir="ltr"]');
    let text = (textEl?.innerText || textEl?.textContent || '').replace(/\\s+/g, ' ').trim();
    // Drop "See more" / "…more" chrome.
    text = text.replace(/\\s*…?\\s*see more\\s*$/i, '').replace(/\\s*…more\\s*$/i, '').trim();
    if (!text || text.length < 2) continue;
    const authorEl =
      root.querySelector('.comments-post-meta__name-text') ||
      root.querySelector('.comments-comment-meta__description-title') ||
      root.querySelector('a[href*="/in/"] span[aria-hidden="true"]') ||
      root.querySelector('a[href*="/in/"]');
    const author = (authorEl?.textContent || '').replace(/\\s+/g, ' ').trim() || undefined;
    out.push({ author, text: text.slice(0, 2000) });
    if (out.length >= 80) break;
  }
  return { ok: true, comments: out, count: out.length, url: location.href };
})()`;
}

/**
 * Re-open a LinkedIn post and check whether a comment matching `body` is visible.
 * Read-only — never types or submits. Matching is best-effort DOM scrape.
 */
export async function verifyLinkedInStagedComment(
  dispatcher: ChromeActionDispatcher,
  opts: {
    postUrl: string;
    body: string;
    /** Require the author's display name to include this (case-insensitive). */
    author_hint?: string;
    focus?: boolean;
  }
): Promise<VerifyStagedCommentResult> {
  const body = opts.body.trim();
  if (!body) {
    throw new Error("verify_staged_comment: body must be non-empty");
  }
  const postUrl = normalizeLinkedInPostUrl(opts.postUrl);
  if (!postUrl) {
    throw new Error(
      `verify_staged_comment: invalid post_url / activity_id: ${JSON.stringify(opts.postUrl)}`
    );
  }
  const authorHint = opts.author_hint?.trim().toLowerCase() || undefined;
  const focus = opts.focus !== false;

  const nav = await dispatcher.dispatch<{
    tab_id?: number;
    current_url?: string;
  }>("navigate", {
    url: postUrl,
    open_in_new_tab: true,
    wait_for_load: true,
    ...chromeOriginsInput(),
  });
  const tabId = nav.tab_id;
  if (typeof tabId !== "number") {
    throw new Error("verify_staged_comment: navigate did not return tab_id");
  }
  if (isLinkedInAuthWall(nav.current_url)) {
    throw new Error(
      `Not logged into LinkedIn (landed on ${nav.current_url}). Sign in in the paired Chrome profile, then retry.`
    );
  }

  try {
    await dispatcher.dispatch("wait_for_selector", {
      tab_id: tabId,
      selector:
        ".comments-comment-item, .comments-comment-entity, .feed-shared-update-v2, article",
      timeout_ms: 8000,
      ...chromeOriginsInput(),
    });
  } catch {
    // Non-fatal — page may still expose comments.
  }

  // Best-effort: expand the comments section / load more (never Post).
  try {
    await dispatcher.dispatch("evaluate", {
      tab_id: tabId,
      expression: `(() => {
        const labels = [/^(load|show|view) more comments/i, /^\\d+\\s+comments?$/i, /^comments$/i];
        const clickables = [
          ...document.querySelectorAll('button, [role="button"], a'),
        ];
        const control = clickables.find((el) => {
          const n = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          return n && labels.some((re) => re.test(n));
        });
        if (control) {
          try { control.click(); } catch (_) {}
        }
        return !!control;
      })()`,
      await_promise: false,
      ...chromeOriginsInput(),
    });
  } catch {
    // Expand is optional.
  }

  try {
    await dispatcher.dispatch("wait_for_selector", {
      tab_id: tabId,
      selector: ".comments-comment-item, .comments-comment-entity",
      timeout_ms: 3000,
      ...chromeOriginsInput(),
    });
  } catch {
    // A post can legitimately have no comments.
  }

  if (focus) {
    try {
      await dispatcher.dispatch("focus_tab", {
        tab_id: tabId,
        draw_attention: true,
        ...chromeOriginsInput(),
      });
    } catch {
      // Focus is best-effort.
    }
  }

  let comments: ScrapedComment[] = [];
  try {
    const scrape = await dispatcher.dispatch<{
      value?: { comments?: unknown; count?: number };
      exception?: string;
    }>("evaluate", {
      tab_id: tabId,
      expression: buildScrapeCommentsExpression(),
      await_promise: true,
      ...chromeOriginsInput(),
    });
    if (scrape.exception) {
      return {
        verified: false,
        post_url: postUrl,
        body,
        tab_id: tabId,
        comments_scanned: 0,
        reason: `scrape_exception: ${scrape.exception}`,
        message:
          "Could not scrape comments on the page. Open the post in Chrome and confirm the comment is visible.",
      };
    }
    const raw = scrape.value?.comments;
    if (Array.isArray(raw)) {
      comments = raw.filter(
        (c): c is ScrapedComment =>
          !!c &&
          typeof c === "object" &&
          typeof c.text === "string" &&
          c.text.trim().length > 0 &&
          (c.author === undefined || typeof c.author === "string")
      );
    }
  } catch (err) {
    return {
      verified: false,
      post_url: postUrl,
      body,
      tab_id: tabId,
      comments_scanned: 0,
      reason: err instanceof Error ? err.message : String(err),
      message: "Comment scrape failed (extension evaluate error).",
    };
  }

  const candidates = authorHint
    ? comments.filter((c) =>
        (c.author ?? "").toLowerCase().includes(authorHint)
      )
    : comments;

  for (const c of candidates) {
    const m = commentBodiesMatch(body, c.text);
    if (!m.ok) continue;
    return {
      verified: true,
      post_url: postUrl,
      body,
      tab_id: tabId,
      comments_scanned: comments.length,
      match: {
        author: c.author,
        text_preview: c.text.slice(0, 160),
        match_kind: m.kind,
      },
      message: `Verified: a visible comment matches the staged draft${
        c.author ? ` (author: ${c.author})` : ""
      }.`,
    };
  }

  return {
    verified: false,
    post_url: postUrl,
    body,
    tab_id: tabId,
    comments_scanned: comments.length,
    reason:
      comments.length === 0
        ? "no_comments_visible"
        : authorHint
          ? "no_matching_comment_for_author"
          : "no_matching_comment",
    message:
      comments.length === 0
        ? "No comments visible on the post yet. The human may not have posted, comments may be collapsed, or the DOM selectors missed them."
        : "Comments are visible but none matched the staged draft body. The human may have edited the text before posting.",
  };
}

export function filterPostsSinceCheckpoint(
  posts: LinkedInPost[],
  checkpoint: LinkedInCheckpoint
): LinkedInPost[] {
  const seenIds = new Set<string>();
  const checkpointPostId = normalizeCheckpointPostId(checkpoint.last_post_id);
  const checkpointTimestamp = checkpoint.last_timestamp
    ? new Date(checkpoint.last_timestamp).getTime()
    : null;

  const filtered: LinkedInPost[] = [];
  for (const post of posts) {
    if (!post.id || !post.text || seenIds.has(post.id)) continue;
    seenIds.add(post.id);

    if (checkpointPostId && post.id === checkpointPostId) break;
    if (
      checkpointTimestamp !== null &&
      post.publishedAt.getTime() <= checkpointTimestamp
    ) {
      continue;
    }

    filtered.push(post);
  }

  return filtered;
}

// ── Voyager API Response Parsers ──────────────────────────────

export function parseCompanyUpdates(
  _url: string,
  json: unknown
): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  const data = json as any;

  // Build URN lookup from `included` array (LinkedIn GraphQL uses references)
  const included: any[] = data?.included ?? [];
  const byUrn: Record<string, any> = {};
  for (const item of included) {
    const urn = item.entityUrn || item.$id;
    if (urn) byUrn[urn] = item;
  }

  // Find feed elements - LinkedIn nests under data.data with a long key
  const feedRoot = data?.data?.data ?? data?.data ?? data;
  let elements: any[] = [];
  for (const key of Object.keys(feedRoot)) {
    const val = feedRoot[key];
    if (val?.["*elements"] && Array.isArray(val["*elements"])) {
      elements = val["*elements"];
      break;
    }
    if (val?.elements && Array.isArray(val.elements)) {
      elements = val.elements;
      break;
    }
  }

  const resolve = (ref: any) =>
    (typeof ref === "string" ? byUrn[ref] : ref) ?? {};

  for (const ref of elements) {
    const el = resolve(ref);

    // Get commentary text (may be a reference)
    const commentaryObj = resolve(el["*commentary"] ?? el.commentary);
    const textObj = commentaryObj?.text ?? commentaryObj;
    const text = textObj?.text ?? textObj?.attributedText?.text ?? "";
    if (!text) continue;

    // Get actor
    const actorObj = resolve(el["*actor"] ?? el.actor);
    const authorName = actorObj?.name?.text ?? actorObj?.name ?? "Unknown";
    const authorDesc =
      actorObj?.description?.text ?? actorObj?.description ?? undefined;

    // Actor identity: the member's immutable `urn:li:fsd_profile:<id>` and the
    // vanity `/in/<slug>`. Voyager threads the profile urn through several
    // shapes — the actor may be a ref into `included`, and the urn hides under
    // `*miniProfile` (a bare urn string OR a ref to resolve), `miniProfile` (a
    // bare urn string OR an object with `entityUrn`), `urn`, or `entityUrn`.
    // normalizeLinkedInMemberId returns null for a non-person urn (e.g. a
    // company actor's `urn:li:fsd_company:…`), so a company-authored post yields
    // no member id and its attribution match-only-gates off (createWhen).
    const authorUrn: string =
      (typeof actorObj?.["*miniProfile"] === "string"
        ? actorObj["*miniProfile"]
        : resolve(actorObj?.["*miniProfile"])?.entityUrn) ??
      (typeof actorObj?.miniProfile === "string"
        ? actorObj.miniProfile
        : actorObj?.miniProfile?.entityUrn) ??
      actorObj?.urn ??
      actorObj?.entityUrn ??
      "";
    const authorMemberId = normalizeLinkedInMemberId(authorUrn) ?? undefined;
    const authorProfileUrl: string =
      actorObj?.navigationContext?.actionTarget ??
      actorObj?.navigationUrl ??
      resolve(actorObj?.["*miniProfile"])?.publicIdentifier ??
      "";
    // normalizeLinkedInSlug pulls the `/in/<slug>` segment from a full URL (and
    // returns null for a company `/company/…` URL or anything slug-invalid).
    const authorSlug = normalizeLinkedInSlug(authorProfileUrl);

    // Get social counts
    const socialRef = el["*socialDetail"] ?? el.socialDetail;
    const social = resolve(socialRef);
    const counts =
      social?.totalSocialActivityCounts ??
      social?.socialActivityCountsInsight?.totalSocialActivityCounts ??
      {};

    // Get URN for ID
    const urn = el.entityUrn ?? el["*backendUrn"] ?? "";
    const urnParts = urn.split(":");
    const id =
      urnParts[urnParts.length - 1] ||
      `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get timestamp
    const metadata = resolve(el["*metadata"] ?? el.metadata);
    const publishedAt = metadata?.publishedAt ?? el.createdAt ?? Date.now();

    posts.push({
      id,
      text,
      author: authorName,
      authorHeadline: typeof authorDesc === "string" ? authorDesc : undefined,
      authorMemberId: authorMemberId || undefined,
      authorSlug: authorSlug ?? undefined,
      likes: counts.numLikes ?? 0,
      comments: counts.numComments ?? 0,
      shares: counts.numShares ?? 0,
      publishedAt: new Date(publishedAt),
    });
  }

  return posts;
}

function parseJobListings(_url: string, json: unknown): LinkedInJob[] {
  const jobs: LinkedInJob[] = [];
  const data = json as any;

  const elements = data?.elements ?? data?.data?.elements ?? [];

  for (const element of elements) {
    const jobPosting = element?.jobPosting ?? element;
    const title = jobPosting?.title ?? element?.title ?? "";
    if (!title) continue;

    const urnParts = (
      jobPosting?.entityUrn ??
      element?.dashEntityUrn ??
      ""
    ).split(":");
    const id =
      urnParts[urnParts.length - 1] ||
      `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    jobs.push({
      id,
      title,
      location: jobPosting?.formattedLocation ?? jobPosting?.location ?? "",
      postedAt: new Date(
        jobPosting?.listedAt ?? element?.createdAt ?? Date.now()
      ),
      url: `https://www.linkedin.com/jobs/view/${id}`,
      description: jobPosting?.description?.text ?? undefined,
    });
  }

  return jobs;
}

// ── Config Schemas ────────────────────────────────────────────

const companyUpdatesConfigSchema = {
  type: "object",
  required: ["company_url"],
  properties: {
    company_url: {
      type: "string",
      description:
        'LinkedIn company page URL (e.g., "https://www.linkedin.com/company/openai")',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum scroll iterations for pagination (default: 5)",
    },
  },
};

const homeFeedConfigSchema = {
  type: "object",
  properties: {
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      default: 8,
      description:
        "Maximum scroll iterations for the home feed (default: 8). Upper end of the range when min_scrolls is set.",
    },
    min_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      description:
        "Optional lower bound. When set below max_scrolls, each sync picks a uniform random scroll count in [min_scrolls, max_scrolls].",
    },
  },
};

/** Per-run scroll budget: fixed max_scrolls, or uniform [min_scrolls, max_scrolls]. */
function readHomeScrollBudget(config: {
  max_scrolls?: number;
  min_scrolls?: number;
}): number {
  const max = Math.max(1, Math.min(30, Number(config.max_scrolls ?? 8) || 8));
  if (config.min_scrolls === undefined || config.min_scrolls === null) {
    return max;
  }
  const min = Math.max(1, Math.min(max, Number(config.min_scrolls) || 1));
  if (min >= max) return max;
  return min + Math.floor(Math.random() * (max - min + 1));
}

const jobsConfigSchema = {
  type: "object",
  required: ["company_url"],
  properties: {
    company_url: {
      type: "string",
      description:
        'LinkedIn company page URL (e.g., "https://www.linkedin.com/company/openai")',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      default: 3,
      description: "Maximum scroll iterations for job listings (default: 3)",
    },
  },
};

function localTakeoutSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      takeout_dir: { type: "string", description },
      batch_size: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        default: 1000,
        description: "Maximum events to emit per sync run.",
      },
    },
  };
}

// ── Connector ─────────────────────────────────────────────────

/**
 * True when a raw post reference is a LinkedIn HOME-FEED surface with no
 * specific post identity (e.g. `https://www.linkedin.com/feed/`, the feed
 * root, `/feed/hashtag/…`, or a bare `/feed/update` with no id). Such a URL
 * addresses the whole feed, not a post — prepare_comment must never treat it
 * as a durable post id (it would enqueue a doomed navigate and fail). Only
 * consulted after normalizeLinkedInPostUrl returned null, so any input that
 * resolves to a durable post URL is already handled.
 */
export function isGenericLinkedInFeedUrl(raw: string): boolean {
  try {
    const withScheme = raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
        ? `https://www.linkedin.com${raw}`
        : raw.includes("://")
          ? raw
          : `https://${raw}`;
    const u = new URL(withScheme);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) {
      return false;
    }
    const path = u.pathname.replace(/\/+$/, "");
    // A URL that carries a durable post identity (urn:li:…) is not the bare
    // feed surface, even though it lives under /feed/ — it resolves to a real
    // post. Only paths with NO embedded identity are "generic feed".
    if (/urn(?::|%3A)li(?::|%3A)(?:activity|share|ugcPost)/i.test(path)) {
      return false;
    }
    // Any other /feed/ path is a feed surface once no durable post id
    // resolved — the feed root, /feed/hashtag/<tag>, /feed/trending, and a
    // bare /feed/update (no urn). Nothing that normalizes to a real post URL
    // reaches here, so a prefix match is safe and complete.
    return path === "/feed" || path.startsWith("/feed/");
  } catch {
    return false;
  }
}

/**
 * Non-failing result for a post reference that is not a supported durable
 * identifier. `success: true` so the action completes WITHOUT a failed
 * operational run — a not_actionable input is not a Lobu infrastructure
 * incident. `output.status` lets callers distinguish this from a real stage.
 */
function notActionableMissingPostId(postUrlRaw: string): ActionResult {
  return {
    success: true,
    output: {
      status: "not_actionable",
      reason: "missing_durable_post_id",
      post_url: postUrlRaw,
      message:
        "A durable LinkedIn post identifier is required (e.g. urn:li:activity:…, a /feed/update/urn:li:… URL, or the canonical post URL from a synced post event). The provided reference addresses the LinkedIn home feed, not a specific post.",
    },
  };
}

/**
 * The ten LinkedIn Data Export feeds: checkpoint cursor and pure reader per
 * feed key. This table replaces a chain of ten near-identical `if (feedKey ===
 * …)` blocks; the mapping it encodes is unchanged.
 *
 * Feed keys and cursor names are the persisted contract — a feed row keys on
 * the feed key and a checkpoint on the cursor name — so both are copied over
 * verbatim rather than tidied (see {@link LinkedInCheckpoint} on why the
 * takeout `jobs` cursor is `last_applied_jobs_timestamp`).
 */
const LINKEDIN_TAKEOUT_FEEDS: Record<
  string,
  {
    cursor: keyof LinkedInCheckpoint;
    read: (readCsv: TakeoutCsvReader) => EventEnvelope[];
  }
> = {
  messages: { cursor: "last_messages_timestamp", read: readMessages },
  connections: { cursor: "last_connections_timestamp", read: readConnections },
  invitations: { cursor: "last_invitations_timestamp", read: readInvitations },
  applied_jobs: { cursor: "last_applied_jobs_timestamp", read: readJobs },
  profile: { cursor: "last_profile_timestamp", read: readProfile },
  companies: { cursor: "last_companies_timestamp", read: readCompanyFollows },
  learning: { cursor: "last_learning_timestamp", read: readLearning },
  events: { cursor: "last_events_timestamp", read: readEvents },
  endorsements: {
    cursor: "last_endorsements_timestamp",
    read: readEndorsements,
  },
  media: { cursor: "last_media_timestamp", read: readRichMedia },
};

/**
 * The configured export directory, or a thrown error naming what is missing.
 *
 * Only checks that the value is SET; it cannot stat the path, because this runs
 * inside the isolate, which has no filesystem. An injected host reader must
 * validate its directory before reading; the platform does not provide one.
 */
function assertTakeoutDir(config: LinkedInConfig): string {
  const dir = config.takeout_dir;
  if (!dir) throw new Error("Missing takeout_dir for LinkedIn.");
  return dir;
}

export default class LinkedInConnector extends ConnectorRuntime<
  LinkedInCheckpoint,
  LinkedInConfig
> {
  private readonly fetchImpl: typeof fetch;
  /**
   * Builds a CSV reader rooted at the export directory, or `undefined` when the
   * host has no filesystem — which is the case in the isolate every platform
   * run uses. Supplying it is how a Node-hosted caller (or a future worker that
   * advertises a local-file capability) turns the takeout feeds on, WITHOUT
   * putting `node:fs` into the bundle the live browser feeds must load.
   */
  private readonly csvReader?: (takeoutDir: string) => TakeoutCsvReader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    csvReader?: (takeoutDir: string) => TakeoutCsvReader
  ) {
    super();
    this.fetchImpl = fetchImpl;
    this.csvReader = csvReader;
  }

  readonly definition: RuntimeConnectorDefinition<
    LinkedInCheckpoint,
    LinkedInConfig
  > = {
    key: "linkedin",
    name: "LinkedIn",
    description:
      "Scrapes LinkedIn (home feed, company pages, hiring signals) via the paired Owletto Chrome extension, and ingests local LinkedIn Data Export CSV files. prepare_comment stages a draft for the human to Post; verify_staged_comment checks whether that draft appeared as a comment.",
    version: "3.11.11",
    faviconDomain: "linkedin.com",
    // Auth is `none`: every live feed authenticates implicitly through the
    // paired Owletto Chrome extension (the user's own signed-in linkedin.com
    // session — no OAuth token is ever read), and takeout feeds read local CSV
    // files. A previously-declared OPTIONAL oauth method was removed: no feed
    // consumed it, yet the server's connection-create picks the first non-`none`
    // method as authoritative and forced an irrelevant LinkedIn OAuth handshake
    // before a (takeout or extension-driven) connection could be created —
    // blocking exactly the "one connector, both live and backfill" use case the
    // merge exists for. If real OAuth sign-in is ever needed downstream, add it
    // back behind a feed that actually uses the token.
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {
      // ── Live (Chrome-extension) feeds ──────────────────────────
      home_feed: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "home_feed",
        name: "Home Feed",
        description: "Your personalized LinkedIn home feed.",
        configSchema: homeFeedConfigSchema,
        eventKinds: {
          post: {
            description: "A post from your personalized LinkedIn home feed",
            attributions: LINKEDIN_HOME_FEED_ATTRIBUTIONS,
            metadataSchema: {
              type: "object",
              properties: {
                author: { type: "string" },
                author_linkedin_slug: { type: "string" },
                author_profile_url: { type: "string" },
                social_actor: {
                  type: "string",
                  description:
                    "Member whose engagement surfaced this post (likes/commented/reposted banners).",
                },
                social_action: {
                  type: "string",
                  description:
                    "Engagement verb: like, love, celebrate, support, insightful, funny, comment, repost.",
                },
                social_actor_slug: { type: "string" },
                social_actor_profile_url: { type: "string" },
                reactions: { type: "number" },
                comments: { type: "number" },
                reposts: { type: "number" },
              },
            },
          },
          comment: {
            description:
              "A complete comment or reply on a personalized feed post",
            attributions: LINKEDIN_HOME_COMMENT_ATTRIBUTIONS,
            metadataSchema: {
              type: "object",
              properties: {
                author: { type: "string" },
                author_linkedin_slug: { type: "string" },
                author_profile_url: { type: "string" },
                parent_post_origin_id: { type: "string" },
                parent_author: { type: "string" },
                parent_author_linkedin_slug: { type: "string" },
                parent_author_profile_url: { type: "string" },
                comment_urn: { type: "string" },
                comment_id: { type: "string" },
                parent_activity_id: { type: "string" },
                parent_activity_namespace: { type: "string" },
                parent_comment_origin_id: { type: "string" },
                parent_comment_id: { type: "string" },
                parent_comment_author: { type: "string" },
                parent_comment_author_linkedin_slug: { type: "string" },
                parent_comment_author_profile_url: { type: "string" },
                is_reply: { type: "boolean" },
                reactions: { type: "number" },
                comments: { type: "number" },
                reposts: { type: "number" },
              },
            },
          },
        },
      },
      company_updates: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "company_updates",
        name: "Company Updates",
        description: "Posts and updates from the company LinkedIn page.",
        configSchema: companyUpdatesConfigSchema,
        eventKinds: {
          post: {
            description: "A company LinkedIn post",
            attributions: LINKEDIN_POST_AUTHOR_ATTRIBUTIONS,
            metadataSchema: {
              type: "object",
              properties: {
                author_headline: { type: "string" },
                author_member_id: { type: "string" },
                author_linkedin_slug: { type: "string" },
                likes: { type: "number" },
                comments: { type: "number" },
                shares: { type: "number" },
              },
            },
          },
        },
      },
      jobs: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "jobs",
        name: "Job Listings",
        description: "Open job positions (hiring velocity signal).",
        configSchema: jobsConfigSchema,
        eventKinds: {
          job_posting: {
            description: "An open job listing",
            metadataSchema: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
            },
          },
        },
      },
      // ── Takeout (local CSV) feeds ──────────────────────────────
      messages: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "messages",
        name: "Messages",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
        eventKinds: {
          message: {
            description: "A LinkedIn direct message",
            attributions: LINKEDIN_MESSAGE_ATTRIBUTIONS,
          },
        },
      },
      connections: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "connections",
        name: "Connections",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
        eventKinds: {
          connection: {
            description: "A first-degree LinkedIn connection",
            attributions: LINKEDIN_CONNECTION_ATTRIBUTIONS,
          },
        },
      },
      invitations: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "invitations",
        name: "Invitations",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      applied_jobs: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "applied_jobs",
        name: "Applied Jobs",
        description:
          "Your own applied/saved job postings from the LinkedIn Data Export.",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      profile: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "profile",
        name: "Profile",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      companies: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "companies",
        name: "Company Follows",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      learning: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "learning",
        name: "Learning",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      events: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "events",
        name: "Events",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      endorsements: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "endorsements",
        name: "Endorsements and Recommendations",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      media: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "media",
        name: "Rich Media",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
    },
    actions: {
      prepare_comment: {
        key: "prepare_comment",
        name: "Prepare comment",
        description:
          "Stage a comment draft after the user opens the exact LinkedIn post (fill composer, banner). NEVER opens a tab or submits — the human must click Post.",
        // The user-opened page is the approval surface: this action can only
        // fill its composer. The human still performs the irreversible Post
        // click, which safeDispatch structurally refuses above.
        requiresApproval: false,
        kind: "write",
        annotations: {
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: false,
        },
        inputSchema: {
          type: "object",
          required: ["body"],
          anyOf: [{ required: ["post_url"] }, { required: ["activity_id"] }],
          properties: {
            post_url: {
              type: "string",
              description:
                'LinkedIn post URL, or activity id / URN (e.g. "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567", "urn:li:activity:7312345678901234567", or "7312345678901234567").',
            },
            activity_id: {
              type: "string",
              description:
                "Activity id when post_url is omitted (digits or urn:li:activity:…).",
            },
            body: {
              type: "string",
              description:
                "Draft comment text. Left in the composer for the user to edit/send.",
              minLength: 1,
              maxLength: 3000,
            },
            reason: {
              type: "string",
              description:
                "Optional short explanation for the in-page banner (truncated).",
              maxLength: 500,
            },
            banner: {
              type: "boolean",
              description:
                "Inject a small in-page Lobu handoff banner (default true).",
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            prepared: { type: "boolean" },
            status: {
              type: "string",
              enum: ["not_actionable", "prepared"],
              description:
                "prepared after the draft is staged; not_actionable when the input did not carry a durable post id (no browser action was taken).",
            },
            reason: {
              type: "string",
              description:
                "Present with status=not_actionable: why the input was not actionable (e.g. missing_durable_post_id).",
            },
            tab_id: { type: "integer" },
            post_url: { type: "string" },
            body: { type: "string" },
            method: { type: "string" },
            banner_shown: { type: "boolean" },
            reason_preview: { type: "string" },
            message: { type: "string" },
          },
        },
      },
      verify_staged_comment: {
        key: "verify_staged_comment",
        name: "Verify staged comment",
        description:
          "Re-open a LinkedIn post in the paired Chrome browser and check whether a comment matching the draft body is visible. Read-only — never posts. Best-effort DOM scrape (not a guarantee of publication).",
        requiresApproval: false,
        kind: "read",
        annotations: {
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["body"],
          anyOf: [{ required: ["post_url"] }, { required: ["activity_id"] }],
          properties: {
            post_url: {
              type: "string",
              description:
                "LinkedIn post URL, activity id, or URN (same shapes as prepare_comment).",
            },
            activity_id: {
              type: "string",
              description:
                "Activity id when post_url is omitted (digits or urn:li:activity:…).",
            },
            body: {
              type: "string",
              description: "Expected comment text (the staged draft).",
              minLength: 1,
              maxLength: 3000,
            },
            author_hint: {
              type: "string",
              description:
                "Optional author display-name substring to require when matching.",
              maxLength: 200,
            },
            focus: {
              type: "boolean",
              description:
                "Bring the post tab to the foreground (default true).",
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            verified: { type: "boolean" },
            status: {
              type: "string",
              enum: ["not_actionable", "verified"],
              description:
                "verified after a matching comment is found; not_actionable when the input did not carry a durable post id (no browser action was taken).",
            },
            reason: {
              type: "string",
              description:
                "Present whenever verification did not succeed: why (e.g. missing_durable_post_id, no_matching_comment, no_comments_visible, scrape_exception).",
            },
            post_url: { type: "string" },
            body: { type: "string" },
            tab_id: { type: "integer" },
            comments_scanned: { type: "integer" },
            match: {
              type: "object",
              properties: {
                author: { type: "string" },
                text_preview: { type: "string" },
                match_kind: {
                  type: "string",
                  enum: ["exact", "prefix", "contains"],
                },
              },
            },
            message: { type: "string" },
          },
        },
      },
    },
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      if (
        ctx.actionKey !== "prepare_comment" &&
        ctx.actionKey !== "verify_staged_comment"
      ) {
        return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
      const body =
        typeof ctx.input.body === "string" ? ctx.input.body.trim() : "";
      if (!body) {
        return { success: false, error: "body is required" };
      }
      const postUrlRaw =
        (typeof ctx.input.post_url === "string" && ctx.input.post_url.trim()) ||
        (typeof ctx.input.activity_id === "string" &&
          ctx.input.activity_id.trim()) ||
        "";
      if (!postUrlRaw) {
        return {
          success: false,
          error: "post_url or activity_id is required",
        };
      }

      // Require a supported DURABLE post identifier BEFORE any browser
      // dispatch. A generic home-feed URL must not enqueue a doomed navigate:
      // return a non-failing not_actionable result instead (no failed run, no
      // computer-use action, not an infrastructure incident).
      const normalizedPostUrl = normalizeLinkedInPostUrl(postUrlRaw);
      if (!normalizedPostUrl) {
        if (isGenericLinkedInFeedUrl(postUrlRaw)) {
          return notActionableMissingPostId(postUrlRaw);
        }
        return {
          success: false,
          error: `post_url or activity_id must reference a specific LinkedIn post (got ${JSON.stringify(postUrlRaw)})`,
        };
      }

      const dispatcher = requireExtensionDispatcher(ctx);

      if (ctx.actionKey === "verify_staged_comment") {
        const authorHint =
          typeof ctx.input.author_hint === "string"
            ? ctx.input.author_hint.trim()
            : "";
        const output = await verifyLinkedInStagedComment(dispatcher, {
          postUrl: normalizedPostUrl,
          body,
          author_hint: authorHint || undefined,
          focus: ctx.input.focus !== false,
        });
        return {
          success: true,
          output: {
            ...output,
            ...(output.verified ? { status: "verified" } : {}),
          },
        };
      }

      const reason =
        typeof ctx.input.reason === "string" ? ctx.input.reason.trim() : "";
      const output = await prepareLinkedInComment(dispatcher, {
        postUrl: normalizedPostUrl,
        body,
        reason: reason || undefined,
        banner: ctx.input.banner !== false,
      });
      return { success: true, output: { ...output, status: "prepared" } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async syncFeed(
    ctx: SyncContext<LinkedInCheckpoint, LinkedInConfig>
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const feedKey = ctx.feedKey;

    // ── Live (Chrome-extension) feeds ────────────────────────────
    if (
      feedKey === "home_feed" ||
      feedKey === "company_updates" ||
      feedKey === "jobs"
    ) {
      return this.syncLive(ctx);
    }

    // ── Takeout (local CSV) feeds ────────────────────────────────
    // Parsing lives in `linkedin-takeout.ts` and is filesystem-free; the
    // capability to actually READ the export is supplied here. Injecting it
    // (rather than importing `node:fs` alongside the live feeds) is what keeps
    // the whole bundle isolate-eligible — see this class's header.
    const takeout = Object.hasOwn(LINKEDIN_TAKEOUT_FEEDS, feedKey)
      ? LINKEDIN_TAKEOUT_FEEDS[feedKey]
      : undefined;
    if (takeout) {
      const readCsv = this.csvReader;
      if (!readCsv) {
        throw new Error(
          "LinkedIn feed '" +
            feedKey +
            "' reads the local LinkedIn Data Export, " +
            "and this runtime provides no filesystem access. This invocation has no CSV reader; " +
            "browser-backed live feeds do not require one. For a local import, construct " +
            "the connector with an explicit reader in a filesystem-capable host."
        );
      }
      return this.result(
        ctx,
        takeout.cursor,
        takeout.read(readCsv(assertTakeoutDir(ctx.config))),
        batchSize(ctx.config)
      );
    }

    throw new Error(`Unknown LinkedIn feed: ${feedKey}`);
  }

  // ── Live scrape dispatch ─────────────────────────────────────

  private async syncLive(
    ctx: SyncContext<LinkedInCheckpoint, LinkedInConfig>
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const config = ctx.config;
    const checkpoint = (ctx.checkpoint ?? {}) as LinkedInCheckpoint;
    const feedKey = ctx.feedKey;

    // home_feed is the one feed that needs a content-script scrape (the CDP
    // debugger stops the personalized feed from rendering) and takes no
    // company_url — it always reads linkedin.com/feed/.
    if (feedKey === "home_feed") {
      const homeScrolls = readHomeScrollBudget(config);
      return this.syncHomeFeed(
        homeScrolls,
        checkpoint,
        requireExtensionDispatcher(ctx)
      );
    }

    const companyUrl = config.company_url;
    if (!companyUrl) {
      throw new Error("company_url is required");
    }

    // Normalize URL - remove trailing slash
    const baseUrl = companyUrl.replace(/\/$/, "");
    const maxScrolls = config.max_scrolls ?? (feedKey === "jobs" ? 3 : 5);

    const dispatcher = requireExtensionDispatcher(ctx);
    if (feedKey === "jobs") {
      return this.syncJobs(baseUrl, maxScrolls, checkpoint, dispatcher);
    }
    return this.syncUpdates(baseUrl, maxScrolls, checkpoint, dispatcher);
  }

  /**
   * Personalized home feed via the extension's content-script scrape. Network
   * capture can't read it (the CDP debugger stops the feed rendering), so we
   * dispatch a `cs_scrape` against linkedin.com/feed/ with the home-feed
   * selectors. Prefer an already-loaded feed tab in the paired Chrome profile;
   * otherwise reuse a site-persistent tab so a slow first hydration is still
   * available to the next scheduled retry.
   */
  private async syncHomeFeed(
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const { items: rows, loggedIn } = await extensionDomScrape<HomeFeedRow>({
      dispatcher,
      url: "https://www.linkedin.com/feed/",
      config: {
        ...HOME_FEED_SCRAPE_CONFIG,
        scroll: { ...HOME_FEED_SCRAPE_CONFIG.scroll, max: maxScrolls },
      },
      parseRows: (raw) =>
        (raw as HomeFeedRow[]).map((row) => ({
          ...row,
          post_identity: decodeHomeFeedPostIdentity(row.post_identity),
        })),
      allowedOrigins: LINKEDIN_ALLOWED_ORIGINS,
      existingTabMatch: "linkedin.com/feed/",
      persistent: true,
    });

    if (!loggedIn) {
      throw new Error(
        "Not logged into LinkedIn. Sign in to linkedin.com in the paired Chrome profile, then re-run the sync."
      );
    }
    if (rows.length === 0) {
      throw new Error(
        "LinkedIn is logged in, but the home feed produced no post rows. Keep a signed-in linkedin.com/feed/ tab open on the paired browser and retry."
      );
    }

    const resolvedRows = await resolveHomeFeedPostUrls(rows, this.fetchImpl);
    const unresolvedShortUrlCount =
      unresolvedHomeFeedShortUrlCount(resolvedRows);
    if (unresolvedShortUrlCount > 0) {
      throw new Error(
        `LinkedIn could not resolve ${unresolvedShortUrlCount} copied post short URL${unresolvedShortUrlCount === 1 ? "" : "s"} to a durable identity. No home-feed events were persisted.`
      );
    }
    const unresolvedPostCount = unresolvedHomeFeedPostCount(resolvedRows);
    if (unresolvedPostCount > 0) {
      throw new Error(
        `LinkedIn scraped ${unresolvedPostCount} post row${unresolvedPostCount === 1 ? "" : "s"} without a durable activity/share/ugcPost identity. No partial home-feed batch was persisted.`
      );
    }

    const commentCoverage = summarizeHomeFeedCommentCoverage(resolvedRows);

    const events = buildHomeFeedEvents(resolvedRows, new Date());
    if (events.length === 0) {
      throw new Error(
        "LinkedIn is logged in and returned feed rows, but no row combined usable content with a durable identity. Keep a signed-in linkedin.com/feed/ tab open on the paired browser and retry."
      );
    }

    // Capability gate: author/engager slugs need the `objectAll` scrape take. An
    // older extension can't produce it, so identity degrades to name-only.
    // Surface it in metadata (rather than failing) so a stale extension is
    // observable — events still flow, just without slugs.
    const objectAllSupported = homeFeedObjectAllSupported(resolvedRows);

    return {
      events,
      // The home feed exposes no stable per-post cursor (opaque token ids, no
      // timestamps), so there is nothing new to checkpoint — pass it through.
      checkpoint,
      metadata: {
        items_found: events.length,
        items_scraped: rows.length,
        scrolls_this_run: maxScrolls,
        backend: "extension-cs-scrape",
        object_all_supported: objectAllSupported,
        comment_threads_complete: commentCoverage.incomplete === 0,
        comment_threads_checked: commentCoverage.threads,
        comment_threads_incomplete: commentCoverage.incomplete,
        comment_threads_unsupported: commentCoverage.unsupported,
        comment_threads_timed_out: commentCoverage.timedOut,
        comment_coverage_details: commentCoverage.details,
        comments_expected: commentCoverage.expected,
        comments_collected: commentCoverage.collected,
      },
    };
  }

  private async syncUpdates(
    baseUrl: string,
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const postsUrl = `${baseUrl}/posts/`;
    const result = await extensionNetworkSync<LinkedInPost>({
      dispatcher,
      url: postsUrl,
      config: {
        interceptPatterns: [
          {
            regex: "voyager/api/graphql\\?variables=.*ORGANIZATION_MEMBER_FEED",
          },
          { regex: "voyager/api/graphql\\?variables=.*organizationalPageUrn" },
        ],
        allowedOrigins: ["linkedin.com", "*.linkedin.com"],
        maxScrolls,
        scrollDelayMs: 3000,
        responseTimeoutMs: 8000,
      },
      parseResponse: parseCompanyUpdates,
      checkAuth: (currentUrl) =>
        !currentUrl.includes("/login") && !currentUrl.includes("/authwall"),
    });

    const posts = filterPostsSinceCheckpoint(result.items, checkpoint);
    const events: EventEnvelope[] = posts.map((post) => ({
      origin_id: `li_post_${post.id}`,
      payload_text: post.text,
      author_name: post.author,
      occurred_at: post.publishedAt,
      origin_type: "post",
      source_url: `https://www.linkedin.com/feed/update/urn:li:activity:${post.id}`,
      score: calculateEngagementScore("linkedin", {
        upvotes: post.likes,
        reply_count: post.comments,
      }),
      metadata: {
        author_headline: post.authorHeadline,
        // Author identity for the `post` attribution. member_id (primary) when
        // Voyager exposed the actor's fsd_profile urn; slug bridges to takeout.
        author_member_id: post.authorMemberId,
        author_linkedin_slug: post.authorSlug,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
      },
    }));
    events.sort(
      (a, b) =>
        new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
    );

    return {
      events,
      checkpoint: {
        ...checkpoint,
        last_post_id: posts[0]?.id ?? checkpoint.last_post_id,
        last_timestamp:
          events[0]?.occurred_at?.toISOString?.() ?? checkpoint.last_timestamp,
      },
      // No cookie persistence — auth lives in the user's signed-in Chrome,
      // not in our cookie cache.
      metadata: {
        items_found: events.length,
        items_skipped: result.items.length - posts.length,
        api_calls: result.apiCallCount,
        backend: "extension",
      },
    };
  }

  private async syncJobs(
    baseUrl: string,
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const jobsUrl = `${baseUrl}/jobs/`;
    const result = await extensionNetworkSync<LinkedInJob>({
      dispatcher,
      url: jobsUrl,
      config: {
        interceptPatterns: [
          { regex: "voyager/api/graphql.*jobPosting", flags: "i" },
          { regex: "voyager/api/search/dash/.*jobs", flags: "i" },
          { regex: "voyager/api/organization/.*jobs", flags: "i" },
        ],
        allowedOrigins: ["linkedin.com", "*.linkedin.com"],
        maxScrolls,
        scrollDelayMs: 3000,
        responseTimeoutMs: 8000,
      },
      parseResponse: parseJobListings,
      checkAuth: (currentUrl) =>
        !currentUrl.includes("/login") && !currentUrl.includes("/authwall"),
    });

    const seenIds = new Set<string>();
    const jobs = result.items.filter((j) => {
      if (!j.id || seenIds.has(j.id)) return false;
      seenIds.add(j.id);
      return true;
    });
    jobs.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());

    const events: EventEnvelope[] = jobs.map((job) => ({
      origin_id: `li_job_${job.id}`,
      payload_text: job.description ?? job.title,
      title: job.title,
      occurred_at: job.postedAt,
      origin_type: "job_posting",
      source_url: job.url,
      metadata: { location: job.location },
    }));

    return {
      events,
      checkpoint: {
        ...checkpoint,
        last_job_id: jobs[0]?.id ?? checkpoint.last_job_id,
        last_timestamp:
          jobs[0]?.postedAt?.toISOString?.() ?? checkpoint.last_timestamp,
      },
      metadata: {
        items_found: events.length,
        api_calls: result.apiCallCount,
        backend: "extension",
      },
    };
  }

  // ── Takeout (local CSV) readers ──────────────────────────────

  private result(
    ctx: SyncContext<LinkedInCheckpoint, LinkedInConfig>,
    key: keyof LinkedInCheckpoint,
    allEvents: EventEnvelope[],
    max: number
  ): SyncResult<LinkedInCheckpoint> {
    const events = takeBatch(allEvents, ctx.checkpoint?.[key], max);
    return {
      events,
      checkpoint: {
        ...ctx.checkpoint,
        [key]: maxEventCursor(events, ctx.checkpoint?.[key]),
      },
    };
  }
}
