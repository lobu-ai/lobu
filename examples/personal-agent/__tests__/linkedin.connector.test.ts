import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let LinkedInConnector: any;
let buildHomeFeedEventsRaw: any;
let homeFeedObjectAllSupported: any;
let parseHomeFeedAuthor: any;
let parseHomeFeedEngagement: any;
let isHomeFeedNoise: any;
let filterPostsSinceCheckpoint: any;
let parseCompanyUpdates: any;
let normalizeLinkedInSlug: any;
let normalizeLinkedInMemberId: any;
let LINKEDIN_IDENTITY: any;
let normalizeLinkedInPostUrl: any;
let resolveLinkedInShortPostUrl: any;
let resolveHomeFeedPostUrls: any;
let isGenericLinkedInFeedUrl: any;
let isLinkedInAuthWall: any;
let pickCommentButtonRef: any;
let pickCommentTextboxRef: any;
let isCommentSubmitLabel: any;
let isCommentOpenLabel: any;
let prepareLinkedInComment: any;
let buildFillCommentExpression: any;
let buildInjectHandoffBannerExpression: any;
let truncateHandoffReason: any;
let normalizeCommentMatchText: any;
let commentBodiesMatch: any;
let buildScrapeCommentsExpression: any;
let verifyLinkedInStagedComment: any;
let genericScrape: (
  config: Record<string, unknown>
) => Promise<Record<string, unknown>>;
let readConnections: any;
let readJobs: any;
let assertDirectory: any;
let parseCsv: any;

// Most tests below exercise author, engagement, media, or noise parsing rather
// than post identity recovery. Give those synthetic rows a durable URN derived
// from the fixture's own row id, so they satisfy the production invariant
// without repeating identity boilerplate and without depending on row order.
// Tests that assert identity recovery itself pass post_url / post_identity
// explicitly; tests for MISSING identity call buildHomeFeedEventsRaw.
// Deterministic per-row-id digits: a stable hash keeps the URN independent of
// row order and of which other tests ran first.
function syntheticActivityId(rowId: string): string {
  let hash = 0;
  for (const char of rowId) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000;
  return `74000000000000${String(hash).padStart(6, "0")}`;
}

function buildHomeFeedEvents(rows: any[], occurredAt: Date): any[] {
  return buildHomeFeedEventsRaw(
    rows.map((row) => {
      const id = String(row?.id ?? "");
      // Comment rows carry identity in the row id itself (production parses the
      // `urn:li:comment:(parent,comment)` urn), so they need no injection.
      if (
        row?.post_url ||
        row?.post_identity ||
        /urn:li:comment:\(/i.test(id)
      ) {
        return row;
      }
      return {
        ...row,
        post_identity: `urn:li:activity:${syntheticActivityId(id)}`,
      };
    }),
    occurredAt
  );
}

beforeAll(async () => {
  const mod = await import("../linkedin.connector");
  LinkedInConnector = mod.default;
  buildHomeFeedEventsRaw = mod.buildHomeFeedEvents;
  homeFeedObjectAllSupported = mod.homeFeedObjectAllSupported;
  parseHomeFeedAuthor = mod.parseHomeFeedAuthor;
  parseHomeFeedEngagement = mod.parseHomeFeedEngagement;
  isHomeFeedNoise = mod.isHomeFeedNoise;
  filterPostsSinceCheckpoint = mod.filterPostsSinceCheckpoint;
  parseCompanyUpdates = mod.parseCompanyUpdates;
  normalizeLinkedInPostUrl = mod.normalizeLinkedInPostUrl;
  resolveLinkedInShortPostUrl = mod.resolveLinkedInShortPostUrl;
  resolveHomeFeedPostUrls = mod.resolveHomeFeedPostUrls;
  isGenericLinkedInFeedUrl = mod.isGenericLinkedInFeedUrl;
  isLinkedInAuthWall = mod.isLinkedInAuthWall;
  pickCommentButtonRef = mod.pickCommentButtonRef;
  pickCommentTextboxRef = mod.pickCommentTextboxRef;
  isCommentSubmitLabel = mod.isCommentSubmitLabel;
  isCommentOpenLabel = mod.isCommentOpenLabel;
  prepareLinkedInComment = mod.prepareLinkedInComment;
  buildFillCommentExpression = mod.buildFillCommentExpression;
  buildInjectHandoffBannerExpression = mod.buildInjectHandoffBannerExpression;
  truncateHandoffReason = mod.truncateHandoffReason;
  normalizeCommentMatchText = mod.normalizeCommentMatchText;
  commentBodiesMatch = mod.commentBodiesMatch;
  buildScrapeCommentsExpression = mod.buildScrapeCommentsExpression;
  verifyLinkedInStagedComment = mod.verifyLinkedInStagedComment;
  genericScrape = (
    await import("../../../packages/owletto/apps/chrome/tools.js")
  ).genericScrape;
  const takeoutMod = await import("../linkedin-takeout");
  readConnections = takeoutMod.readConnections;
  readJobs = takeoutMod.readJobs;
  const takeoutFsMod = await import("../takeout-fs");
  assertDirectory = takeoutFsMod.assertDirectory;
  parseCsv = (await import("../takeout-utils")).parseCsv;
  const identityMod = await import("../linkedin-identity");
  normalizeLinkedInSlug = identityMod.normalizeLinkedInSlug;
  normalizeLinkedInMemberId = identityMod.normalizeLinkedInMemberId;
  LINKEDIN_IDENTITY = identityMod.LINKEDIN_IDENTITY;
});

describe("filterPostsSinceCheckpoint", () => {
  test("drops posts at or before the saved timestamp", () => {
    const posts = [
      {
        id: "103",
        text: "Newest",
        author: "OpenAI",
        likes: 3,
        comments: 1,
        shares: 0,
        publishedAt: new Date("2026-03-29T12:00:00.000Z"),
      },
      {
        id: "102",
        text: "Seen already",
        author: "OpenAI",
        likes: 2,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-28T12:00:00.000Z"),
      },
      {
        id: "101",
        text: "Older",
        author: "OpenAI",
        likes: 1,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-27T12:00:00.000Z"),
      },
    ];

    expect(
      filterPostsSinceCheckpoint(posts, {
        last_post_id: "102",
        last_timestamp: "2026-03-28T12:00:00.000Z",
      }).map((post: { id: string }) => post.id)
    ).toEqual(["103"]);
  });

  test("understands legacy li_post_ checkpoint ids", () => {
    const posts = [
      {
        id: "202",
        text: "Newer",
        author: "OpenAI",
        likes: 3,
        comments: 1,
        shares: 0,
        publishedAt: new Date("2026-03-29T12:00:00.000Z"),
      },
      {
        id: "201",
        text: "Checkpoint",
        author: "OpenAI",
        likes: 2,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-28T12:00:00.000Z"),
      },
      {
        id: "200",
        text: "Too old",
        author: "OpenAI",
        likes: 1,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-27T12:00:00.000Z"),
      },
    ];

    expect(
      filterPostsSinceCheckpoint(posts, {
        last_post_id: "li_post_201",
      }).map((post: { id: string }) => post.id)
    ).toEqual(["202"]);
  });
});

describe("buildHomeFeedEvents", () => {
  test("dedupes changing component keys by the durable post identity", () => {
    const events = buildHomeFeedEvents(
      [
        {
          id: "first_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "/feed/update/urn:li:activity:7345678901234567890?utm_source=feed",
        },
        {
          id: "replacement_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:7345678901234567890",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(events).toHaveLength(1);
    expect(events[0].origin_id).toBe("li_home_activity_7345678901234567890");
  });

  test("derives source_url from the embedded urn when post_url does not normalize", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          // The scraped href is the bare feed surface — it carries no post id,
          // so the durable identity has to come from post_identity, and
          // source_url must still be the canonical permalink for that id.
          post_url: "https://www.linkedin.com/feed/",
          post_identity: "urn:li:share:7485276857911828480",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(event.origin_id).toBe("li_home_share_7485276857911828480");
    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7485276857911828480"
    );
  });

  test("links comments to the right parent when component keys are recycled", () => {
    const events = buildHomeFeedEvents(
      [
        {
          id: "recycled",
          body: "Feed post Ada Lovelace • 1st First parent post body long enough here",
          author: "Ada Lovelace",
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111",
        },
        {
          id: "replaceableComment_urn:li:comment:(urn:li:activity:1111111111111111111,2222222222222222222)",
          body: "First comment",
          author: "First Commenter",
        },
        {
          id: "recycled",
          body: "Feed post Grace Hopper • 1st Second parent post body long enough here",
          author: "Grace Hopper",
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:9999999999999999999",
        },
        {
          id: "replaceableComment_urn:li:comment:(urn:li:activity:9999999999999999999,8888888888888888888)",
          body: "Second comment",
          author: "Second Commenter",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(
      events
        .filter(
          (event: { origin_type: string }) => event.origin_type === "comment"
        )
        .map(
          (event: {
            origin_id: string;
            origin_parent_id: string;
            metadata: { parent_author?: string };
          }) => [
            event.origin_id,
            event.origin_parent_id,
            event.metadata.parent_author,
          ]
        )
    ).toEqual([
      [
        "li_comment_2222222222222222222",
        "li_home_activity_1111111111111111111",
        "Ada Lovelace",
      ],
      [
        "li_comment_8888888888888888888",
        "li_home_activity_9999999999999999999",
        "Grace Hopper",
      ],
    ]);
  });

  test("uses the scraped post permalink when LinkedIn exposes one", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "/feed/update/urn:li:activity:7345678901234567890?utm_source=feed",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7345678901234567890"
    );
    expect(event.origin_id).toBe("li_home_activity_7345678901234567890");
  });

  test("prefers the copied activity URL over a different embedded identity", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "/feed/update/urn:li:activity:7345678901234567890?utm_source=feed",
          post_identity: "urn:li:share:7485276857911828480",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(event.origin_id).toBe("li_home_activity_7345678901234567890");
    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7345678901234567890"
    );
  });

  test("builds a permalink from the share id embedded in current feed cards", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_identity:
            "translatable-commentary-ContentUrnShareUrn(shareUrn=ShareUrn(shareId=7485276857911828480))",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    // A shareId is not an activity id; keep the source URN namespace.
    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7485276857911828480"
    );
    expect(event.origin_id).toBe("li_home_share_7485276857911828480");
  });

  test("keeps the ugcPost namespace for ugcPostId feed cards", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_identity: "urn:li:ugcPost:7485276857911828481",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:ugcPost:7485276857911828481"
    );
    expect(event.origin_id).toBe("li_home_ugcPost_7485276857911828481");
  });

  test("drops a component-key row with no durable post identity", () => {
    const occurredAt = new Date("2026-05-29T12:00:00.000Z");
    const events = buildHomeFeedEventsRaw(
      [
        {
          id: "aBc123_token",
          body: "Hello from the home feed, this body is long enough",
          author: "Jane Doe",
        },
      ],
      occurredAt
    );

    expect(events).toEqual([]);
  });

  test("links a native comment to its copied-link parent when post identity is empty", () => {
    const occurredAt = new Date("2026-08-23T10:00:00.000Z");
    const events = buildHomeFeedEvents(
      [
        {
          id: "parent_token",
          body: "Feed post Fixture Post Author • 1st Fixture Role at Fixture Co 9h • A post with enough text to keep",
          author_control_label:
            "Open control menu for post by Fixture Post Author",
          post_identity: "",
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111",
          links: [
            {
              href: "https://www.linkedin.com/in/fixture-post-author/",
              name: "View Fixture Post Author’s profile",
            },
          ],
        },
        {
          id: "replaceableComment_urn:li:comment:(urn:li:activity:1111111111111111111,2222222222222222222)",
          body: "Great work!",
          author: "Fixture Commenter",
          links: [
            {
              href: "https://www.linkedin.com/in/fixture-commenter/",
              name: "View Fixture Commenter’s profile",
            },
          ],
          comment_media: [
            {
              url: "https://media.licdn.com/dms/image/sync/v2/comment-image",
              alt_text: "A diagram in the comment",
            },
          ],
        },
      ],
      occurredAt
    );

    expect(events).toHaveLength(2);
    const comment = events[1];
    expect(comment).toMatchObject({
      origin_id: "li_comment_2222222222222222222",
      origin_parent_id: "li_home_activity_1111111111111111111",
      origin_type: "comment",
      author_name: "Fixture Commenter",
      source_url:
        "https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111",
      score: 0,
      payload_text: "Great work!",
      attachments: [
        {
          kind: "image",
          url: "https://media.licdn.com/dms/image/sync/v2/comment-image",
          alt_text: "A diagram in the comment",
        },
      ],
    });
    expect(comment.metadata).toMatchObject({
      author: "Fixture Commenter",
      author_linkedin_slug: "fixture-commenter",
      parent_post_origin_id: "li_home_activity_1111111111111111111",
      parent_author: "Fixture Post Author",
      parent_author_linkedin_slug: "fixture-post-author",
      comment_id: "2222222222222222222",
      parent_activity_id: "1111111111111111111",
      parent_activity_namespace: "activity",
    });
  });

  test("links a nested reply to both its parent comment and the original post", () => {
    const activityId = "3111111111111111111";
    const parentCommentId = "3222222222222222222";
    const replyId = "3333333333333333333";
    const events = buildHomeFeedEvents(
      [
        {
          id: "reply_parent_post",
          body: "Feed post Parent Post Author • 1st A parent post with enough text to keep",
          author_control_label:
            "Open control menu for post by Parent Post Author",
          post_identity: `urn:li:activity:${activityId}`,
          links: [
            {
              href: "https://www.linkedin.com/in/parent-post-author/",
              name: "View Parent Post Author’s profile",
            },
          ],
        },
        {
          id: `replaceableComment_urn:li:comment:(urn:li:activity:${activityId},${parentCommentId})`,
          body: "Parent comment body",
          author: "Parent Commenter",
          links: [
            {
              href: "https://www.linkedin.com/in/parent-commenter/",
              name: "View Parent Commenter’s profile",
            },
          ],
        },
        {
          id: `replaceableComment_urn:li:comment:(urn:li:activity:${activityId},${replyId})`,
          parent_comment_identity: `replaceableComment_urn:li:comment:(urn:li:activity:${activityId},${parentCommentId})`,
          body: "Nested reply body",
          author: "Reply Author",
          links: [
            {
              href: "https://www.linkedin.com/in/reply-author/",
              name: "View Reply Author’s profile",
            },
          ],
        },
      ],
      new Date("2026-08-24T12:00:00.000Z")
    );

    const reply = events.find(
      (event: any) => event.origin_id === `li_comment_${replyId}`
    );
    expect(reply).toMatchObject({
      origin_parent_id: `li_comment_${parentCommentId}`,
      metadata: {
        parent_post_origin_id: `li_home_activity_${activityId}`,
        parent_comment_origin_id: `li_comment_${parentCommentId}`,
        parent_comment_id: parentCommentId,
        parent_comment_author: "Parent Commenter",
        parent_comment_author_linkedin_slug: "parent-commenter",
        is_reply: true,
      },
    });
  });

  test("keeps content media while rejecting avatars, duplicates, and unsafe URLs", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "media_post",
          body: "Feed post Fixture Media Author • 1st A post with a useful architecture image attached",
          author: "Fixture Media Author",
          post_media: [
            {
              url: "https://media.licdn.com/dms/image/sync/v2/architecture",
              alt_text: "Architecture diagram",
            },
            {
              url: "https://media.licdn.com/dms/image/sync/v2/architecture",
            },
            {
              url: "https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100_100/avatar",
            },
            { url: "javascript:alert(1)" },
          ],
        },
      ],
      new Date()
    );

    expect(event.attachments).toEqual([
      {
        kind: "image",
        url: "https://media.licdn.com/dms/image/sync/v2/architecture",
        alt_text: "Architecture diagram",
      },
    ]);
  });

  test("parses engagement counts and scores every post", () => {
    const body =
      "Feed post Fixture Score Author • 1st Build log Fixture Reactor and 1,616 others reacted 65 comments • 49 reposts";
    const counters = {
      reaction_count_label: "Fixture Reactor and 1,616 others reacted",
      comment_count_text: "65 comments",
      repost_count_label: "49 reposts",
    };
    expect(parseHomeFeedEngagement(counters)).toEqual({
      reactions: 1617,
      comments: 65,
      reposts: 49,
    });
    const [event] = buildHomeFeedEvents(
      [{ id: "scored", body, author: "Fixture Score Author", ...counters }],
      new Date()
    );
    expect(event.score).toBe(100);
    expect(event.metadata).toMatchObject({
      reactions: 1617,
      comments: 65,
      reposts: 49,
    });
  });

  test("does not infer engagement from numbers in post prose", () => {
    const body =
      "Feed post Fixture Prose Author • 1st This launch got 1,000 likes in our internal user study";
    expect(parseHomeFeedEngagement({ body })).toEqual({
      reactions: undefined,
      comments: undefined,
      reposts: undefined,
    });
    const [event] = buildHomeFeedEvents(
      [{ id: "prose-only", body, author: "Fixture Prose Author" }],
      new Date()
    );
    expect(event.score).toBe(0);
    expect(event.metadata).toEqual({ author: "Fixture Prose Author" });
  });

  test("defaults author to empty string when no author and no parseable body", () => {
    // Body long enough to survive the noise filter but with no " • " marker.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "a plain body with no author marker whatsoever here",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("");
    expect(ev.metadata).toEqual({ author: "" });
  });

  test("prefers row.author over body parse when the DOM selector won", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
          author: "DOM Author",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("DOM Author");
    expect(ev.metadata).toEqual({ author: "DOM Author" });
  });

  test("uses the post author when the DOM selector finds the reacting member", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this 🦔 james hawkins • 2nd self driving software and co-ceo at posthog 8h • Connect",
          author: "Deb Mukherjee",
        },
      ],
      new Date()
    );
    // Leading emoji decoration on the actor name is stripped for a clean title.
    expect(ev.author_name).toBe("james hawkins");
    // No profile href on this row → engagement is named but not identified.
    expect(ev.metadata).toEqual({
      author: "james hawkins",
      social_actor: "Deb Mukherjee",
      social_action: "like",
    });
  });

  test("strips Visit website CTA fused into the author after a repost banner", () => {
    // Production body: company page CTA text sits next to the original author.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Emir Karabeg reposted this Sim Visit website 2h • Follow Sim Retreat Malibu ‘26 11 2 2",
          links: [
            {
              href: "https://www.linkedin.com/in/emirkarabeg/",
              name: "View Emir Karabeg’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Sim");
    expect(ev.metadata).toMatchObject({
      author: "Sim",
      social_actor: "Emir Karabeg",
      social_action: "repost",
      social_actor_slug: "emirkarabeg",
    });
  });

  test("matches emoji-prefixed DOM engager to banner actor (keeps engagement attribution)", () => {
    // DOM text often keeps the leading emoji; banner parse strips it. Without
    // normalizing both sides, the banner is discarded and the engager is
    // mis-emitted as the post author with their slug.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this 🦔 james hawkins • 2nd self driving 8h • Connect",
          author: "🦔 Deb Mukherjee",
          author_control_label: "Open control menu for post by james hawkins",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
            {
              href: "https://www.linkedin.com/in/jameshawkins/",
              name: "View james hawkins’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("james hawkins");
    expect(ev.metadata).toMatchObject({
      author: "james hawkins",
      social_actor: "Deb Mukherjee",
      social_action: "like",
      social_actor_slug: "debgotwired",
      author_linkedin_slug: "jameshawkins",
    });
  });

  test("strips the connection-degree marker from a DOM-selector author", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Julien Hurault 1st Julien Hurault • 1st Freelance Data Eng newsletter",
          author: "Julien Hurault • 1st",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Julien Hurault");
    expect(ev.metadata).toEqual({ author: "Julien Hurault" });
  });

  test("falls back to body-parsed author when row.author is empty", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
          author: "   ",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Hugo Lu");
    expect(ev.metadata).toEqual({ author: "Hugo Lu" });
  });

  test("resolves the author slug by matching the control-menu label on a plain card", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Maria Malykh • 1st Founder & CTO | Automating R&D Tax 3h • I'm not an early planner",
          author_control_label: "Open control menu for post by Maria Malykh",
          links: [
            {
              href: "https://www.linkedin.com/in/maria-malykh-ilyina/?miniProfileUrn=abc",
              name: "View Maria Malykh’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Maria Malykh");
    expect(ev.metadata).toEqual({
      author: "Maria Malykh",
      author_linkedin_slug: "maria-malykh-ilyina",
      author_profile_url: "https://www.linkedin.com/in/maria-malykh-ilyina",
    });
  });

  test("uses the control-menu author when the body header is stale", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Stale Header • 2nd Founder 3h • Current post body",
          author_control_label: "Open control menu for post by Current Author",
          links: [
            {
              href: "https://www.linkedin.com/in/current-author/",
              name: "View Current Author’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Current Author");
    expect(ev.metadata).toMatchObject({
      author: "Current Author",
      author_linkedin_slug: "current-author",
    });
  });

  test("attributes engager and author by name on a social-context card", () => {
    // The engager is named by the banner, the author by the control-menu label.
    // Each resolves to its own link by name — order-independent.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this Adam Robinson • 2nd CEO @ MoltSets 8h • Connect unlimited contact data",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({
      author: "Adam Robinson",
      social_actor: "Deb Mukherjee",
      social_action: "like",
      social_actor_slug: "debgotwired",
      social_actor_profile_url: "https://www.linkedin.com/in/debgotwired",
      author_linkedin_slug: "adam-robinson",
      author_profile_url: "https://www.linkedin.com/in/adam-robinson",
    });
  });

  test("keeps engagement attribution when the author link comes first", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this Adam Robinson • 2nd CEO 8h • Connect",
          author: "Adam Robinson",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author_linkedin_slug: "adam-robinson",
      social_actor: "Deb Mukherjee",
      social_actor_slug: "debgotwired",
    });
  });

  test("ignores post-body mention links when resolving the author", () => {
    // A mention link the author didn't write must never be picked as the author.
    // Only the link whose accessible name matches the control-menu author wins.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam Robinson • 2nd CEO 8h • Connect shoutout to a friend",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
            {
              href: "https://www.linkedin.com/in/some-mention/",
              name: "View Some Mention’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author_linkedin_slug: "adam-robinson",
    });
    expect(ev.metadata).not.toHaveProperty("social_actor_slug");
  });

  test("gives a company author no person slug even with a person mention present", () => {
    // The control-menu author is a company (no /in/ link); a person mention in
    // the post must not be promoted to author.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this MoltSets 8h • Follow",
          author_control_label: "Open control menu for post by MoltSets",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
            {
              href: "https://www.linkedin.com/company/moltsets/",
              name: "View company: MoltSets",
            },
            {
              href: "https://www.linkedin.com/in/some-mention/",
              name: "View Some Mention’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({
      author: "MoltSets",
      social_actor: "Deb Mukherjee",
      social_action: "like",
      social_actor_slug: "debgotwired",
      social_actor_profile_url: "https://www.linkedin.com/in/debgotwired",
    });
  });

  test("does not promote a same-named person mention over a company author", () => {
    // Name collision: the author is the company "Adam" and a person mention is
    // also named "Adam". Matching by name alone would wrongly attribute the
    // person; a company anchor sharing the name must block person attribution.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam • 2nd Company update mentioning a same-named person here",
          author_control_label: "Open control menu for post by Adam",
          links: [
            {
              href: "https://www.linkedin.com/company/adam/",
              name: "View company: Adam",
            },
            {
              href: "https://www.linkedin.com/in/adam-person/",
              name: "View Adam’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
  });

  test("does not attribute when two distinct members share the author's name", () => {
    // Two different "Jane Doe" profiles match the name — ambiguous, so neither
    // is attributed rather than guessing one.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Jane Doe • 2nd Founder posting something long enough to keep",
          author_control_label: "Open control menu for post by Jane Doe",
          links: [
            {
              href: "https://www.linkedin.com/in/jane-doe-1/",
              name: "View Jane Doe’s profile",
            },
            {
              href: "https://www.linkedin.com/in/jane-doe-2/",
              name: "View Jane Doe’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
  });

  test("ignores a malformed non-array links field", () => {
    // A stale/garbled field must yield no slugs rather than crashing or minting
    // garbage — normalizeHomeFeedLinks accepts only a real array.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam Robinson • 2nd CEO 8h • Connect",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: "Adam Robinson" as unknown as never,
        },
      ],
      new Date()
    );
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
    expect(ev.metadata).not.toHaveProperty("author_profile_url");
  });

  // Fixtures recorded from the live linkedin.com/feed/ DOM on 2026-07-22 via
  // the paired Owletto extension. They pin three observed shapes: an
  // actor-less "Recommended for you" banner, an engagement card whose author is
  // a COMPANY, and a promoted "follow this Page" card whose leading links belong
  // to followers, not the author.
  test("live DOM: actor-less banner author resolves by control label", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "r1",
          body: "Feed post Recommended for you Victor Baron • 2nd Founder & CEO at Ampere All-In-One Financial Service For Businesses | Building First-world App Busine",
          author_control_label: "Open control menu for post by Victor Baron",
          links: [
            {
              href: "https://www.linkedin.com/in/victor-baron/",
              name: "View Victor Baron’s profile",
            },
            {
              href: "https://www.linkedin.com/company/openai/",
              name: "View company: OpenAI",
            },
            {
              href: "https://www.linkedin.com/company/google/",
              name: "View company: Google",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Victor Baron");
    expect(ev.metadata).toEqual({
      author: "Victor Baron",
      author_linkedin_slug: "victor-baron",
      author_profile_url: "https://www.linkedin.com/in/victor-baron",
    });
  });

  test("live DOM: engagement card with a company author gives the author no person slug", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "r5",
          body: "Feed post Onur Demirtaş likes this Swipeline TR 13h • Follow Twitter'ın kurucu ortağı ve Block'un CEO'su Jack Dorsey, X hesabından paylaştığı gönderiy",
          author_control_label: "Open control menu for post by Swipeline TR",
          links: [
            {
              href: "https://www.linkedin.com/in/onurdmrts/",
              name: "View Onur Demirtaş’s profile",
            },
            {
              href: "https://www.linkedin.com/company/swipelinetr/posts/",
              name: "View company: Swipeline TR",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Swipeline TR");
    expect(ev.metadata).toEqual({
      author: "Swipeline TR",
      social_actor: "Onur Demirtaş",
      social_action: "like",
      social_actor_slug: "onurdmrts",
      social_actor_profile_url: "https://www.linkedin.com/in/onurdmrts",
    });
  });

  test("live DOM: a 'follow this Page' promoted card is dropped as noise", () => {
    // The leading links belong to connections who follow the page, NOT the
    // author (CodeRabbit). It is filtered before routing; this pins that.
    const events = buildHomeFeedEvents(
      [
        {
          id: "r3",
          body: "Feed post Gorkem Cetin, Matthew Gregory and 22 other connections follow this Page CodeRabbit 36,825 followers Promoted Build vs. Buy: What does an AI ",
          author_control_label: "Open control menu for post by CodeRabbit",
          links: [
            {
              href: "https://www.linkedin.com/in/gorkemcetin/",
              name: "Gorkem Cetin",
            },
            {
              href: "https://www.linkedin.com/in/matthewgregory/",
              name: "Matthew Gregory",
            },
            {
              href: "https://www.linkedin.com/company/coderabbitai/posts/",
              name: "View company: CodeRabbit",
            },
          ],
        },
      ],
      new Date()
    );
    expect(events).toHaveLength(0);
  });

  test("keeps both roles when the same member authors and engages", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam Robinson reposted this Adam Robinson • 2nd CEO 8h • Connect",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      social_actor: "Adam Robinson",
      social_actor_slug: "adam-robinson",
      author_linkedin_slug: "adam-robinson",
    });
  });

  test("omits the author slug when a social card exposes only the engager link", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this Adam Robinson • 2nd CEO 8h • Connect",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    // Only the engager exposes a link; the author is named but not linked.
    expect(ev.metadata).toMatchObject({ social_actor_slug: "debgotwired" });
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
  });

  test("preserves a comma suffix in the engager's display name", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post John Smith, MBA likes this Alice Jones • 2nd Founder 2h • Follow",
          author: "John Smith, MBA",
          author_control_label: "Open control menu for post by Alice Jones",
          links: [
            {
              href: "https://www.linkedin.com/in/john-smith/",
              name: "View John Smith, MBA’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author: "Alice Jones",
      social_actor: "John Smith, MBA",
      social_actor_slug: "john-smith",
    });
  });

  test("does not treat an action phrase in the DOM author's name as a banner", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post We Love This Company • 2nd Community 2h • Follow",
          author: "We Love This Company",
          author_control_label:
            "Open control menu for post by We Love This Company",
          links: [
            {
              href: "https://www.linkedin.com/in/we-love-this-company/",
              name: "View We Love This Company’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("We Love This Company");
    expect(ev.metadata).toEqual({
      author: "We Love This Company",
      author_linkedin_slug: "we-love-this-company",
      author_profile_url: "https://www.linkedin.com/in/we-love-this-company",
    });
  });

  test("captures comment and repost engagement actions", () => {
    const events = buildHomeFeedEvents(
      [
        {
          id: "c",
          body: "Feed post Barry McCardel commented Caroline Haynes • 2nd GTM at Hex 20h • Follow After an incredible year",
          links: [
            {
              href: "https://www.linkedin.com/in/barrymccardel/",
              name: "View Barry McCardel’s profile",
            },
          ],
        },
        {
          id: "r",
          body: "Feed post Sabri Karagönen reposted this Hardal 17h • Follow Hardal is now integrated with Bruin",
          links: [
            {
              href: "https://www.linkedin.com/in/sabrikaragonen/",
              name: "View Sabri Karagönen’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(events[0].metadata).toMatchObject({
      author: "Caroline Haynes",
      social_actor: "Barry McCardel",
      social_action: "comment",
      social_actor_slug: "barrymccardel",
    });
    expect(events[1].metadata).toMatchObject({
      author: "Hardal",
      social_actor: "Sabri Karagönen",
      social_action: "repost",
      social_actor_slug: "sabrikaragonen",
    });
  });

  test('keeps only the first engager name on an "and N others" banner', () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Ali Veli and 3 others like this Ayşe Yılmaz • 2nd Data engineer 4h • Connect",
          links: [
            {
              href: "https://www.linkedin.com/in/aliveli/",
              name: "View Ali Veli’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author: "Ayşe Yılmaz",
      social_actor: "Ali Veli",
      social_action: "like",
      social_actor_slug: "aliveli",
    });
  });

  test("attributes the href to the author on an actor-less banner card", () => {
    // "Voices worth following" / "Recommended for you" have no engager; the
    // author resolves by the control-menu label.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Voices worth following Elizabeth Reid • 2nd VP, Search 13h • Follow Bonjour France!",
          author_control_label: "Open control menu for post by Elizabeth Reid",
          links: [
            {
              href: "https://www.linkedin.com/in/elizabeth-reid-56356724/",
              name: "View Elizabeth Reid’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Elizabeth Reid");
    expect(ev.metadata).toEqual({
      author: "Elizabeth Reid",
      author_linkedin_slug: "elizabeth-reid-56356724",
      author_profile_url: "https://www.linkedin.com/in/elizabeth-reid-56356724",
    });
  });

  test("emits no slug fields when the row has no profile href", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({ author: "Hugo Lu" });
  });

  test("does not attribute a later person link to a company author", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Acme Corp • 3rd+ Company update with a tagged member",
          author: "Acme Corp",
          author_control_label: "Open control menu for post by Acme Corp",
          links: [
            {
              href: "https://www.linkedin.com/company/acme/",
              name: "View company: Acme Corp",
            },
            {
              href: "https://www.linkedin.com/in/tagged-member/",
              name: "View Tagged Member’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({ author: "Acme Corp" });
  });

  test("drops rows without id or body and keeps posts sharing a component key", () => {
    const longBody =
      "this body is definitely longer than thirty characters for the test";
    const events = buildHomeFeedEvents(
      [
        {
          id: "a",
          body: longBody,
          author: "First Author",
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:4444444444444444444",
        },
        {
          id: "",
          body: "no id but long enough body to pass the noise filter check",
        },
        { id: "b" }, // no body
        {
          // Same component key as the first row: LinkedIn recycles the key, so
          // the durable activity id decides identity and both posts survive
          // with their own author and permalink.
          id: "a",
          body: "recycled key with a sufficiently long body to pass the filter",
          author: "Second Author",
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:5555555555555555555",
        },
      ],
      new Date()
    );
    expect(events.map((e: { origin_id: string }) => e.origin_id)).toEqual([
      "li_home_activity_4444444444444444444",
      "li_home_activity_5555555555555555555",
    ]);
    expect(events[0]).toMatchObject({
      payload_text: longBody,
      author_name: "First Author",
      source_url:
        "https://www.linkedin.com/feed/update/urn:li:activity:4444444444444444444",
      metadata: { author: "First Author" },
    });
    expect(events[1]).toMatchObject({
      author_name: "Second Author",
      source_url:
        "https://www.linkedin.com/feed/update/urn:li:activity:5555555555555555555",
      metadata: { author: "Second Author" },
    });
  });

  test("drops promoted, suggested, and too-short noise rows end-to-end", () => {
    const occurredAt = new Date("2026-05-29T12:00:00.000Z");
    const events = buildHomeFeedEvents(
      [
        {
          id: "keep1",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
          post_identity: "urn:li:activity:6111111111111111111",
        },
        {
          id: "keep2",
          body: "Feed post Sabri Karagönen reposted this Hardal 17h • Follow Hardal is now integrated with Bruin",
          post_identity: "urn:li:activity:6222222222222222222",
        },
        {
          id: "ad",
          body: "Feed post Attio 52,728 followers Promoted Introducing GTM Atlas the new way to map your market",
        },
        {
          id: "sug",
          body: "Feed post Suggested Matt Graham • 2nd CEO @ RapidDev building fast",
        },
        { id: "short", body: "Load more comments" },
      ],
      occurredAt
    );
    expect(events.map((e: { origin_id: string }) => e.origin_id)).toEqual([
      "li_home_activity_6111111111111111111",
      "li_home_activity_6222222222222222222",
    ]);
    expect(events.map((e: { author_name: string }) => e.author_name)).toEqual([
      "Hugo Lu",
      "Hardal",
    ]);
  });
});

describe("homeFeedObjectAllSupported", () => {
  test("true when a row returns links as an array", () => {
    expect(
      homeFeedObjectAllSupported([
        { id: "a", links: [{ href: "/in/x", name: "View X’s profile" }] },
      ])
    ).toBe(true);
  });

  test("false when the extension returns links as a string (no objectAll)", () => {
    // An older extension ignores the take and returns the field as plain text.
    expect(
      homeFeedObjectAllSupported([
        { id: "a", links: "some card text" as unknown as never },
      ])
    ).toBe(false);
  });

  test("assumes supported when no row carries a links field", () => {
    // A batch of link-less cards is not evidence of a stale extension.
    expect(homeFeedObjectAllSupported([{ id: "a" }, { id: "b" }])).toBe(true);
  });

  test("true if any row is an array even when others are link-less", () => {
    expect(
      homeFeedObjectAllSupported([{ id: "a" }, { id: "b", links: [] }])
    ).toBe(true);
  });
});

describe("parseHomeFeedAuthor", () => {
  test("extracts the leading name before the connection-degree marker", () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped"
      )
    ).toBe("Hugo Lu");
  });

  test("handles an emoji-laden headline", () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Arpit Choudhury • 1st I am the calmest when the music is loud 🔊 1h • Today"
      )
    ).toBe("Arpit Choudhury");
  });

  test('takes the original poster after "reposted this"', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Sabri Karagönen reposted this Hardal 17h • Follow Hardal is now integrated with Bruin"
      )
    ).toBe("Hardal");
  });

  test('strips a "likes this" social-context banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Deb Mukherjee likes this 🦔 james hawkins • 2nd self driving software and co-ceo at posthog 8h • Connect this is what happens"
      )
    ).toBe("james hawkins");
    expect(
      parseHomeFeedAuthor(
        "Feed post Onur Demirtaş likes this Erkan Ayan • 2nd erkanayan.net 8h • Connect 📍 something"
      )
    ).toBe("Erkan Ayan");
  });

  test('strips a "commented" social-context banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Barry McCardel commented Caroline Haynes • 2nd GTM at Hex 20h • Follow After an incredible run"
      )
    ).toBe("Caroline Haynes");
    expect(
      parseHomeFeedAuthor(
        "Feed post Joseph Jacks commented Roelof Botha • 3rd+ Investor 3h • Follow I am hiring"
      )
    ).toBe("Roelof Botha");
  });

  test('strips a "finds this insightful" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Arpit Choudhury finds this insightful Paul Walsh • 2nd Online safety & security 5h • Follow"
      )
    ).toBe("Paul Walsh");
  });

  test('strips a plural "and N others like this" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Ali Veli and 3 others like this Ayşe Yılmaz • 2nd Data engineer 4h • Connect"
      )
    ).toBe("Ayşe Yılmaz");
  });

  test('strips a "Recommended for you" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Recommended for you Rich Nicholls, MBA • 3rd+ Director of Operations & Compliance 1d • Follow"
      )
    ).toBe("Rich Nicholls, MBA");
  });

  test("takes the author after stacked social-context banners", () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Alice likes this Bob reposted this Carol 5h • Follow"
      )
    ).toBe("Carol");
  });

  test('strips a "Voices worth following" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Voices worth following Elizabeth Reid • 2nd VP, Search 13h • Follow Bonjour France!"
      )
    ).toBe("Elizabeth Reid");
  });

  test('recovers the author from an expanded-post "Author" badge row without a degree marker', () => {
    expect(
      parseHomeFeedAuthor(
        "Daniel Kravtsov Author CEO, Improvado | Building the Agentic Marketing OS | A revenue ecosystem"
      )
    ).toBe("Daniel Kravtsov");
    expect(parseHomeFeedAuthor("Q Author Founder and CEO")).toBe("Q");
    expect(
      parseHomeFeedAuthor(
        "Daniel Kravtsov Author CEO who likes this approach to marketing"
      )
    ).toBe("Daniel Kravtsov");
  });

  test('keeps only the leading name on a "Premium Profile" badge row', () => {
    expect(
      parseHomeFeedAuthor(
        "Joseph Jacks Premium Profile 1st Joseph Jacks • 1st Autodidact. 2h Epic run at a16z"
      )
    ).toBe("Joseph Jacks");
  });

  test('returns empty string when no " • " marker is present', () => {
    expect(
      parseHomeFeedAuthor("Feed post some text with no marker at all")
    ).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(parseHomeFeedAuthor("")).toBe("");
  });

  test("caps the result to 60 chars", () => {
    const longName = "A".repeat(100);
    expect(
      parseHomeFeedAuthor(`Feed post ${longName} • 1st headline`).length
    ).toBe(60);
  });
});

describe("isHomeFeedNoise", () => {
  test("drops empty or too-short bodies", () => {
    expect(isHomeFeedNoise("")).toBe(true);
    expect(isHomeFeedNoise("Load more comments")).toBe(true);
  });

  test("drops promoted ads", () => {
    expect(
      isHomeFeedNoise(
        "Feed post Attio 52,728 followers Promoted Introducing GTM Atlas the new way to map your market"
      )
    ).toBe(true);
  });

  test("drops suggested rows", () => {
    expect(
      isHomeFeedNoise("Feed post Suggested Matt Graham • 2nd CEO @ RapidDev")
    ).toBe(true);
  });

  test("drops LinkedIn ad / boost promos without a real member header", () => {
    // Production empties: no " • " degree marker, no Author badge — pure promo.
    expect(
      isHomeFeedNoise(
        "Feed post Get more leads with boosting Boost your best content on LinkedIn to get more quality leads Learn more"
      )
    ).toBe(true);
    expect(
      isHomeFeedNoise(
        "Feed post Try LinkedIn Ads Build your brand and drive quality leads. Spend €200 to get an extra"
      )
    ).toBe(true);
  });

  test("keeps a member post that discusses LinkedIn Ads in the body", () => {
    expect(
      isHomeFeedNoise(
        "Feed post Jane Doe • 1st Growth lead 2h • Follow Why Try LinkedIn Ads still works for B2B pipelines"
      )
    ).toBe(false);
  });

  test("keeps a normal post", () => {
    expect(
      isHomeFeedNoise(
        "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped"
      )
    ).toBe(false);
  });
});

describe("LinkedInConnector home_feed", () => {
  test("declares a home_feed feed with no required company_url", () => {
    const def = new LinkedInConnector().definition;
    expect(def.feeds.home_feed).toBeDefined();
    expect(def.feeds.home_feed.configSchema.required).toBeUndefined();
  });

  test("declares the slug/engagement fields on the post metadata schema", () => {
    const def = new LinkedInConnector().definition;
    const props = def.feeds.home_feed.eventKinds.post.metadataSchema.properties;
    expect(props.author_linkedin_slug).toBeDefined();
    expect(props.social_actor).toBeDefined();
    expect(props.social_action).toBeDefined();
    expect(props.social_actor_slug).toBeDefined();
  });

  test("declares author and engager attributions keyed on linkedin_slug", () => {
    const def = new LinkedInConnector().definition;
    const attributions = def.feeds.home_feed.eventKinds.post.attributions ?? [];
    const authoredBy = attributions.find(
      (rule: { role: string }) => rule.role === "authored_by"
    );
    const performedBy = attributions.find(
      (rule: { role: string }) => rule.role === "performed_by"
    );

    expect(authoredBy).toBeDefined();
    expect(authoredBy.autoCreate).toBe(true);
    expect(authoredBy.target.entityType).toBe("person");
    expect(authoredBy.target.identities).toEqual([
      {
        namespace: LINKEDIN_IDENTITY.SLUG,
        eventPath: "metadata.author_linkedin_slug",
      },
    ]);

    expect(authoredBy.name).toBe("author");
    expect(performedBy).toBeDefined();
    expect(performedBy.name).toBe("engager");
    expect(performedBy.autoCreate).toBe(true);
    expect(performedBy.target.entityType).toBe("person");
    expect(performedBy.target.titlePath).toBe("metadata.social_actor");
    expect(performedBy.target.identities).toEqual([
      {
        namespace: LINKEDIN_IDENTITY.SLUG,
        eventPath: "metadata.social_actor_slug",
      },
    ]);
  });

  test("declares complete comments with commenter and post-author attributions", () => {
    const comment = new LinkedInConnector().definition.feeds.home_feed
      .eventKinds.comment;
    expect(comment).toBeDefined();
    expect(
      comment.attributions.map((rule: { name: string }) => rule.name)
    ).toEqual(["commenter", "post_author", "parent_comment_author"]);
  });

  test("syncHomeFeed dispatches cs_scrape and maps rows to events", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dom = new JSDOM(
      `<!doctype html><body>
      <div componentkey="expandedparent_tokenFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Fixture Post Author"></button>
        <a href="https://www.linkedin.com/in/fixture-post-author/">
          <span aria-hidden="true">Fixture Post Author</span>
          <span aria-label="View Fixture Post Author’s profile"></span>
        </a>
        <span id="translatable-commentary-urn:li:activity:1111111111111111111"></span>
        <p>A home-feed post with enough useful text to pass the noise filter</p>
        <div class="social-details-social-counts">
          <span class="social-details-social-counts__reactions-count">12</span>
          <button aria-label="2 comments"></button>
          <button aria-label="2 reposts"></button>
        </div>
        <div componentkey="commentsSectionContainerparent_token">
          <div id="replaceableComment_urn:li:comment:(urn:li:activity:1111111111111111111,2222222222222222222)">
            <a href="https://www.linkedin.com/in/fixture-commenter-one/">
              <span aria-hidden="true">Fixture Commenter One</span>
              <span aria-label="View Fixture Commenter One’s profile"></span>
            </a>
            <p>Fixture Commenter One • This first visible comment is long enough to pass the noise filter</p>
            <button class="comments-comment-social-bar__reactions-count--cr">2 reactions</button>
            <img src="https://media.licdn.com/dms/image/sync/v2/fixture-comment-one" alt="First fixture diagram" />
          </div>
          <div id="replaceableComment_urn:li:comment:(urn:li:activity:1111111111111111111,3333333333333333333)">
            <a href="https://www.linkedin.com/in/fixture-commenter-two/">
              <span aria-hidden="true">Fixture Commenter Two</span>
              <span aria-label="View Fixture Commenter Two’s profile"></span>
            </a>
            <p>Fixture Commenter Two • This second visible comment is long enough to pass the noise filter</p>
            <img src="https://media.licdn.com/dms/image/sync/v2/fixture-comment-two" alt="Second fixture diagram" />
          </div>
        </div>
      </div>
    </body>`,
      { url: "https://www.linkedin.com/feed/" }
    );
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent ?? "";
      },
    });
    dom.window.scrollTo = () => undefined;
    dom.window.document.documentElement.scrollTo = () => undefined;
    const savedGlobals = new Map(
      ["document", "window", "location"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ])
    );
    Object.defineProperties(globalThis, {
      document: {
        configurable: true,
        value: dom.window.document,
        writable: true,
      },
      window: { configurable: true, value: dom.window, writable: true },
      location: {
        configurable: true,
        value: dom.window.location,
        writable: true,
      },
    });
    const dispatcher = {
      dispatch: async (action: string, input: Record<string, unknown>) => {
        calls.push({ action, input });
        const config = input.scrape_config as Record<string, unknown>;
        const scraped = await genericScrape({
          ...config,
          scroll: { max: 0, stall: 0, waitMs: 0 },
        });
        return {
          tab_id: 1,
          cs_scrape: true,
          result: scraped,
        };
      },
    };

    const connector = new LinkedInConnector();
    const ctx = {
      feedKey: "home_feed",
      config: { max_scrolls: 4 },
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    };
    const res = await (async () => {
      try {
        return await connector.sync(ctx);
      } finally {
        dom.window.close();
        for (const [name, descriptor] of savedGlobals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete (globalThis as Record<string, unknown>)[name];
        }
      }
    })();

    // Dispatched a cs_scrape navigate against /feed/ with the home-feed config.
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe("navigate");
    expect(calls[0].input.cs_scrape).toBe(true);
    expect(calls[0].input.persistent).toBe(true);
    expect(calls[0].input.existing_tab_match).toBe("linkedin.com/feed/");
    expect(calls[0].input.focus).toBe(false);
    expect(calls[0].input.url).toBe("https://www.linkedin.com/feed/");
    expect(
      (calls[0].input.scrape_config as { scroll: { max: number } }).scroll.max
    ).toBe(4);
    const cfg = calls[0].input.scrape_config as {
      rowSelector: string;
      expandRows: {
        rowSelector: string;
        identity: { selector: string; take: string; attr: string };
        expected: { selector: string; textRegex: string };
        items: { selector: string; idAttr: string };
        open: { selector: string; textRegex: string };
        sort: {
          triggerSelector: string;
          triggerTextRegex: string;
          selectedTextRegex: string;
          optionSelector: string;
          optionTextRegex: string;
        };
        more: { selector: string; textRegex: string };
        maxDurationMs: number;
        outputField: string;
      };
      id: { name: string | string[]; regex: string; group: number };
      fields: {
        links: {
          selector: string;
          take: string;
          parts: Record<string, unknown>;
        };
        author_control_label: { selector: string; attr: string };
        post_identity: { selector: string; take: string; attr: string };
        post_url: {
          take: string;
          triggerSelector: string;
          actionSelector: string;
          actionText: string;
        };
        post_media: { selector: string; take: string };
        comment_media: { selector: string; take: string };
        reaction_count_text: { selector: string; take: string };
        comment_count_text: { selector: string; take: string };
        comment_count_label: { selector: string; attr: string };
        repost_count_label: { selector: string; attr: string };
      };
    };
    expect(cfg.rowSelector).toContain("replaceableComment_urn:li:comment");
    expect(cfg.expandRows.rowSelector).toContain('[componentkey^="expanded"]');
    expect(cfg.expandRows.identity).toMatchObject(cfg.fields.post_identity);
    expect(cfg.expandRows.expected.textRegex).toContain("comments?");
    expect(cfg.expandRows.expected.selector).toContain(
      cfg.fields.comment_count_text.selector
    );
    expect(cfg.expandRows.expected.selector).toContain(
      cfg.fields.comment_count_label.selector
    );
    expect(cfg.expandRows.items).toEqual({
      selector: '[id^="replaceableComment_urn:li:comment:"]',
      idAttr: "id",
    });
    expect(cfg.expandRows.open.textRegex).toContain("comments?");
    expect(cfg.expandRows.sort).toMatchObject({
      triggerTextRegex: "^Most relevant$|^Most recent$",
      selectedTextRegex: "^Most recent$",
      optionSelector: '[role="menuitem"]',
      optionTextRegex: "^Most recent\\b",
    });
    expect(cfg.expandRows.more.textRegex).toContain("replies");
    expect(cfg.expandRows.maxDurationMs).toBe(55_000);
    expect(cfg.expandRows.stall).toBe(12);
    expect(cfg.expandRows.outputField).toBe("comment_coverage");
    expect(cfg.id.name).toEqual(["componentkey", "id"]);
    expect(
      "expandedparent_tokenFeedType_MAIN_FEED_RELEVANCE".match(
        new RegExp(cfg.id.regex)
      )?.[cfg.id.group]
    ).toBe("parent_token");
    const firstCommentId =
      "replaceableComment_urn:li:comment:(urn:li:activity:1111111111111111111,2222222222222222222)";
    expect(firstCommentId.match(new RegExp(cfg.id.regex))?.[cfg.id.group]).toBe(
      firstCommentId
    );
    // objectAll captures each anchor with its href + accessible name, so the
    // author/engager are matched by NAME rather than DOM position.
    expect(cfg.fields.links.take).toBe("objectAll");
    expect(cfg.fields.links.selector).toContain("/company/");
    expect(Object.keys(cfg.fields.links.parts)).toContain("href");
    expect(cfg.fields.author_control_label.selector).toContain(
      "control menu for post by"
    );
    expect(cfg.fields.post_url).toMatchObject({
      take: "clipboardAction",
      triggerSelector: 'button[aria-label*="control menu for post by"]',
      actionSelector: '[role="menuitem"]',
      actionTextRegex: "^Copy link(?: to post)?$",
    });
    expect(cfg.fields.post_media.take).toBe("objectAll");
    expect(cfg.fields.post_media.selector).toContain("profile-displayphoto");
    expect(cfg.fields.comment_media.take).toBe("objectAll");
    expect(cfg.fields.reaction_count_text.selector).toContain(
      "social-details-social-counts"
    );
    expect(cfg.fields.reaction_count_text.selector).toContain(
      "comments-comment-social-bar__reactions-count"
    );
    expect(cfg.fields.reaction_count_text.selector).toContain(
      'button[aria-label="Open reactions menu"]'
    );
    expect(cfg.fields.comment_count_label.attr).toBe("aria-label");
    expect(cfg.fields.repost_count_label.attr).toBe("aria-label");

    expect(res.events).toHaveLength(3);
    expect(res.events[0]).toMatchObject({
      origin_id: "li_home_activity_1111111111111111111",
      score: 22,
      metadata: { reactions: 12, comments: 2, reposts: 2 },
    });
    expect(res.events[1]).toMatchObject({
      origin_id: "li_comment_2222222222222222222",
      origin_parent_id: "li_home_activity_1111111111111111111",
      origin_type: "comment",
      author_name: "Fixture Commenter One",
      score: 2,
      metadata: { reactions: 2 },
      attachments: [
        {
          kind: "image",
          url: "https://media.licdn.com/dms/image/sync/v2/fixture-comment-one",
          alt_text: "First fixture diagram",
        },
      ],
    });
    expect(res.events[2]).toMatchObject({
      origin_id: "li_comment_3333333333333333333",
      origin_parent_id: "li_home_activity_1111111111111111111",
      origin_type: "comment",
      author_name: "Fixture Commenter Two",
      // This row has no comment social bar, so it reports no reaction count and
      // scores 0 rather than defaulting to some non-zero engagement.
      score: 0,
      attachments: [
        {
          kind: "image",
          url: "https://media.licdn.com/dms/image/sync/v2/fixture-comment-two",
          alt_text: "Second fixture diagram",
        },
      ],
    });
    expect(
      (res.events[2].metadata as Record<string, unknown>).reactions
    ).toBeUndefined();
    expect(res.metadata.backend).toBe("extension-cs-scrape");
    expect(res.metadata.comment_threads_complete).toBe(true);
    // These mock rows carry no links field, so support is assumed.
    expect(res.metadata.object_all_supported).toBe(true);
  });

  /**
   * Drive a real `genericScrape` over `body` with the connector's own home-feed
   * config, so selector scoping is exercised end to end rather than asserted
   * as a string.
   */
  const syncHomeFeedDom = async (
    body: string,
    setup?: (dom: JSDOM) => void,
    expandRowsOverride?: Record<string, unknown>,
    scrollOverride?: Record<string, number>
  ) => {
    const dom = new JSDOM(`<!doctype html><body>${body}</body>`, {
      url: "https://www.linkedin.com/feed/",
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent ?? "";
      },
    });
    dom.window.scrollTo = () => undefined;
    dom.window.document.documentElement.scrollTo = () => undefined;
    const savedGlobals = new Map(
      ["document", "window", "location"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ])
    );
    Object.defineProperties(globalThis, {
      document: {
        configurable: true,
        value: dom.window.document,
        writable: true,
      },
      window: { configurable: true, value: dom.window, writable: true },
      location: {
        configurable: true,
        value: dom.window.location,
        writable: true,
      },
    });
    setup?.(dom);
    try {
      return await new LinkedInConnector().sync({
        feedKey: "home_feed",
        config: { max_scrolls: 1 },
        checkpoint: {},
        sessionState: {
          chrome_dispatcher: {
            dispatch: async (
              _action: string,
              input: Record<string, unknown>
            ) => ({
              tab_id: 1,
              cs_scrape: true,
              result: await genericScrape({
                ...(input.scrape_config as Record<string, unknown>),
                scroll: scrollOverride ?? { max: 0, stall: 0, waitMs: 0 },
                ...(expandRowsOverride
                  ? {
                      expandRows: {
                        ...((
                          input.scrape_config as {
                            expandRows?: Record<string, unknown>;
                          }
                        ).expandRows ?? {}),
                        ...expandRowsOverride,
                      },
                    }
                  : {}),
              }),
            }),
          },
        },
      });
    } finally {
      dom.window.close();
      for (const [name, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  };

  test.each([
    ["CgoIjsejvOXquuse", "activity", "1111111111111111111"],
    ["EgoIqtXqtLDAsMJc", "ugcPost", "3333333333333333333"],
    // Current ids exceed 2^62, so the ZigZag varint fills all ten bytes.
    ["CgsIgICIqvf8v8fMAQ", "activity", "7370000000000000000"],
  ])("reads encoded %s post identities from comment tools", async (encoded, namespace, postId) => {
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedfixture_tokenFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Fixture Author"></button>
        <p>Fixture Author • 1st A current feed card with a durable encoded identity</p>
        <div id="replaceableComment_urn:li:comment:(urn:li:${namespace}:${postId},2222222222222222222)">
          <p>Fixture Commenter • A native comment that stays linked to its parent</p>
        </div>
        <div id="${encoded}-replaceableCommentToolsfixture_tokenFeedType_MAIN_FEED_RELEVANCE"></div>
      </div>`);
    expect(res.events).toMatchObject([
      {
        origin_id: `li_home_${namespace}_${postId}`,
        source_url: `https://www.linkedin.com/feed/update/urn:li:${namespace}:${postId}`,
      },
      {
        origin_id: "li_comment_2222222222222222222",
        origin_parent_id: `li_home_${namespace}_${postId}`,
      },
    ]);
    expect(res.metadata.comment_threads_complete).toBe(true);
  });

  test.each([
    "%%%",
    "GgIIAg",
    "CgoIjsejvOXquus",
    "CgIIAw",
    "CgoIjsejvOXquuseAA",
  ])("rejects malformed or unsupported encoded post identity %s", async (encoded) => {
    await expect(
      syncHomeFeedDom(`
        <div componentkey="expandedfixture_tokenFeedType_MAIN_FEED_RELEVANCE">
          <p>Fixture Author • 1st A post whose identity must not be guessed</p>
          <div id="${encoded}-replaceableCommentToolsfixture_token"></div>
        </div>`)
    ).rejects.toThrow("invalid encoded post identity");
  });

  test("rejects duplicate encoded identities despite different recycled card keys", async () => {
    await expect(
      syncHomeFeedDom(
        ["first", "second"]
          .map(
            (token) => `
      <div componentkey="expanded${token}FeedType_MAIN_FEED_RELEVANCE">
        <p>Fixture Author • 1st A duplicated card cannot own expansion evidence</p>
        <div id="CgoIjsejvOXquuse-replaceableCommentTools${token}"></div>
      </div>`
          )
          .join("")
      )
    ).rejects.toThrow("home feed produced no post rows");
  });

  test("expands a 4-comment thread from 3 rendered comments and emits all durable comments", async () => {
    const activityId = "8111111111111111111";
    const comment = (id: string, name: string) => `
      <div id="replaceableComment_urn:li:comment:(urn:li:activity:${activityId},${id})">
        <a href="https://www.linkedin.com/in/${name.toLowerCase().replace(/ /g, "-")}/">
          <span aria-hidden="true">${name}</span>
          <span aria-label="View ${name}’s profile"></span>
        </a>
        <p>${name} • A complete fixture comment with enough text for collection</p>
      </div>`;
    const res = await syncHomeFeedDom(
      `
      <div componentkey="expandedcomplete_threadFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Complete Thread Author"></button>
        <span id="translatable-commentary-urn:li:activity:${activityId}"></span>
        <p>A complete-thread home-feed post with enough useful text to pass the filter</p>
        <div role="button" class="comment-count">4 comments</div>
        <div role="button" class="comment-sort">Most relevant</div>
        ${comment("8222222222222222221", "Commenter One")}
        ${comment("8222222222222222222", "Commenter Two")}
        ${comment("8222222222222222223", "Commenter Three")}
        <div role="button" class="more-comments">See 1 more comment</div>
      </div>`,
      (dom) => {
        const document = dom.window.document;
        const bindMore = (row: Element) => {
          row.querySelector(".more-comments")?.addEventListener("click", () => {
            const holder = document.createElement("div");
            holder.innerHTML = comment("8222222222222222224", "Commenter Four");
            const fourth = holder.firstElementChild;
            if (fourth) row.append(fourth);
            row.querySelector(".more-comments")?.remove();
          });
        };
        const initialRow = document.querySelector("[componentkey]");
        if (initialRow) bindMore(initialRow);
        document
          .querySelector(".comment-sort")
          ?.addEventListener("click", () => {
            const option = document.createElement("div");
            option.setAttribute("role", "menuitem");
            option.textContent =
              "Most recent See all comments, the most recent comments are first";
            option.addEventListener("click", () => {
              const current = document.querySelector("[componentkey]");
              const replacement = current?.cloneNode(true) as
                | Element
                | undefined;
              const sort = replacement?.querySelector(".comment-sort");
              if (sort && current) {
                sort.textContent = "Most recent";
                bindMore(replacement);
                current.replaceWith(replacement);
              }
              option.remove();
            });
            document.body.append(option);
          });
      },
      undefined,
      // No iterative harvest follows this terminal pass. The unique replacement
      // must receive its own fresh expansion attempt immediately.
      { max: 0, stall: 0, waitMs: 0 }
    );

    expect(res.events.map((event: any) => event.origin_id)).toEqual([
      `li_home_activity_${activityId}`,
      "li_comment_8222222222222222221",
      "li_comment_8222222222222222222",
      "li_comment_8222222222222222223",
      "li_comment_8222222222222222224",
    ]);
    expect(res.metadata).toMatchObject({
      comment_threads_complete: true,
      comments_expected: 4,
      comments_collected: 4,
    });
  });

  test("persists durable posts when advertised comment coverage remains incomplete", async () => {
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedincomplete_threadFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Incomplete Thread Author"></button>
        <span id="translatable-commentary-urn:li:activity:8333333333333333333"></span>
        <p>An incomplete-thread home-feed post with enough useful text to pass the filter</p>
        <div role="button" class="comment-count">4 comments</div>
        <div id="replaceableComment_urn:li:comment:(urn:li:activity:8333333333333333333,8444444444444444441)"><p>Commenter One • First rendered fixture comment</p></div>
        <div id="replaceableComment_urn:li:comment:(urn:li:activity:8333333333333333333,8444444444444444442)"><p>Commenter Two • Second rendered fixture comment</p></div>
        <div id="replaceableComment_urn:li:comment:(urn:li:activity:8333333333333333333,8444444444444444443)"><p>Commenter Three • Third rendered fixture comment</p></div>
      </div>`);

    expect(res.events.map((event: any) => event.origin_id)).toEqual([
      "li_home_activity_8333333333333333333",
      "li_comment_8444444444444444441",
      "li_comment_8444444444444444442",
      "li_comment_8444444444444444443",
    ]);
    expect(res.metadata).toMatchObject({
      comment_threads_complete: false,
      comment_threads_checked: 1,
      comment_threads_incomplete: 1,
      comments_expected: 4,
      comments_collected: 3,
    });
    expect(res.metadata.comment_coverage_details).toEqual(["4/4/3"]);
  });

  test("surfaces expansion timeout as incomplete coverage metadata", async () => {
    const activityId = "8555555555555555555";
    const res = await syncHomeFeedDom(
      `
      <div componentkey="expandedtimeout_threadFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Timed Out Thread Author"></button>
        <span id="translatable-commentary-urn:li:activity:${activityId}"></span>
        <p>A timed-out-thread home-feed post with enough useful text to pass the filter</p>
        <div role="button" class="comment-count">4 comments</div>
        <div id="replaceableComment_urn:li:comment:(urn:li:activity:${activityId},8666666666666666661)"><p>Commenter One • First rendered fixture comment</p></div>
        <div role="button" class="more-comments">See 3 more comments</div>
      </div>`,
      undefined,
      { maxDurationMs: 1, waitMs: 5 }
    );

    expect(
      res.events.some(
        (event: any) => event.origin_id === `li_home_activity_${activityId}`
      )
    ).toBe(true);
    expect(res.metadata).toMatchObject({
      comment_threads_complete: false,
      comment_threads_incomplete: 1,
      comment_threads_timed_out: 1,
      comments_expected: 4,
      comments_collected: 1,
    });
  });

  test("ignores FeedType helper rows nested inside a real post", async () => {
    const activityId = "8777777777777777777";
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedhelper_rowFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Real Post Author"></button>
        <span id="translatable-commentary-urn:li:activity:${activityId}"></span>
        <p>A real home-feed post with enough useful text to pass the filter</p>
        <div componentkey="commentsSectionContainerhelper_rowFeedType_MAIN_FEED_RELEVANCE">
          <p>Helper Row Person • This nested comment-section helper has author-like text but is not a post</p>
        </div>
      </div>`);

    expect(res.events.map((event: any) => event.origin_id)).toEqual([
      `li_home_activity_${activityId}`,
    ]);
  });

  test("a post does not inherit reactions from a comment rendered above its own counts", async () => {
    // Ordering matters: `querySelector` returns the first match in DOCUMENT
    // order across the whole selector list, not the first branch that matches.
    // Put the comment's social bar BEFORE the post's social-details block, the
    // layout in which an unscoped comment branch would hijack the post's count.
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedparent_orderingFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Fixture Post Author"></button>
        <span id="translatable-commentary-urn:li:activity:4444444444444444444"></span>
        <p>A home-feed post with enough useful text to pass the noise filter</p>
        <div componentkey="commentsSectionContainerordering_token">
          <div id="replaceableComment_urn:li:comment:(urn:li:activity:4444444444444444444,5555555555555555555)">
            <a href="https://www.linkedin.com/in/fixture-commenter-three/">
              <span aria-hidden="true">Fixture Commenter Three</span>
              <span aria-label="View Fixture Commenter Three’s profile"></span>
            </a>
            <p>Fixture Commenter Three • A visible comment long enough to pass the noise filter</p>
            <button class="comments-comment-social-bar__reactions-count--cr">7 reactions</button>
          </div>
        </div>
        <div class="social-details-social-counts">
          <span class="social-details-social-counts__reactions-count">99</span>
        </div>
      </div>`);

    const post = res.events.find((event: any) => event.origin_type === "post");
    const comment = res.events.find(
      (event: any) => event.origin_type === "comment"
    );
    // The post keeps its own 99 reactions; the comment keeps its own 7.
    expect(post.metadata.reactions).toBe(99);
    expect(comment.metadata.reactions).toBe(7);
  });

  test("a label-only post card does not inherit a nested comment's aria-label counts", async () => {
    // The label branches are the shape with no social-details text node to win
    // on document order, so an unscoped label selector leaks the comment's
    // numbers into the post for reactions, comments, and reposts alike.
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedparent_orderingFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Fixture Label Author"></button>
        <span id="translatable-commentary-urn:li:activity:6666666666666666666"></span>
        <p>A label-only home-feed post with text long enough to pass the filter</p>
        <div componentkey="commentsSectionContainerordering_token">
          <div id="replaceableComment_urn:li:comment:(urn:li:activity:6666666666666666666,7777777777777777777)">
            <a href="https://www.linkedin.com/in/fixture-commenter-four/">
              <span aria-hidden="true">Fixture Commenter Four</span>
              <span aria-label="View Fixture Commenter Four’s profile"></span>
            </a>
            <p>Fixture Commenter Four • Another visible comment long enough to pass the filter</p>
            <svg aria-label="Reaction button state: no reaction"></svg>
            <div>
              <div><span>3 reactions</span><span>3</span></div>
              <button aria-label="Open reactions menu"></button>
            </div>
            <button aria-label="2 comments">2</button>
            <button aria-label="1 repost">1</button>
          </div>
        </div>
        <span aria-label="140 reactions"></span>
        <span aria-label="65 comments"></span>
        <span aria-label="49 reposts"></span>
        ${Array.from(
          { length: 64 },
          (_, index) => `
            <div id="replaceableComment_urn:li:comment:(urn:li:activity:6666666666666666666,${8800000000000000000n + BigInt(index)})">
              <p>Additional complete fixture comment ${index + 1} with enough text to collect</p>
            </div>`
        ).join("")}
      </div>`);

    const post = res.events.find((event: any) => event.origin_type === "post");
    const comment = res.events.find(
      (event: any) => event.origin_type === "comment"
    );
    expect(post.metadata).toMatchObject({
      reactions: 140,
      comments: 65,
      reposts: 49,
    });
    expect(res.metadata).toMatchObject({
      comment_threads_complete: true,
      comments_expected: 65,
      comments_collected: 65,
    });
    // The comment scores from its own reactions only; reply and repost counts
    // stay post-only quantities.
    expect(comment.metadata.reactions).toBe(3);
    expect(comment.metadata.comments).toBeUndefined();
    expect(comment.metadata.reposts).toBeUndefined();
  });

  test("scores current obfuscated post counters without reading the Like control", async () => {
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedcurrent_counter_postFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Fixture Current Author"></button>
        <span id="translatable-commentary-urn:li:activity:8888888888888888888"></span>
        <p>A current home-feed post with enough useful text to pass the filter</p>
        <div>
          <a href="https://www.linkedin.com/">
            <span>Fixture Reactor and 236 others reacted</span>
            <span>Fixture Reactor and 236 others</span>
          </a>
          <div>
            <div><p><span>15 comments</span><span>15 comments</span></p></div>
            <p>•</p>
            <a href="https://www.linkedin.com/"><p><span>2 reposts</span><span>2 reposts</span></p></a>
          </div>
        </div>
        <hr />
        <div>
          <div>
            <button aria-label="Reaction button state: no reaction">Like</button>
            <button aria-label="Open reactions menu"></button>
          </div>
          <button>Comment</button>
          <button>Repost</button>
        </div>
        ${Array.from(
          { length: 15 },
          (_, index) => `
            <div id="replaceableComment_urn:li:comment:(urn:li:activity:8888888888888888888,${8900000000000000000n + BigInt(index)})">
              <p>Complete counter fixture comment ${index + 1} with enough text to collect</p>
            </div>`
        ).join("")}
      </div>`);

    const post = res.events.find((event: any) => event.origin_type === "post");
    expect(post).toMatchObject({
      origin_id: "li_home_activity_8888888888888888888",
      score: 100,
      metadata: { reactions: 237, comments: 15, reposts: 2 },
    });
  });

  test("does not cross-map single-kind current counter groups", async () => {
    const res = await syncHomeFeedDom(`
      <div componentkey="expandedreaction_onlyFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Reaction Only Author"></button>
        <span id="translatable-commentary-urn:li:activity:9000000000000000001"></span>
        <p>A reaction-only current post with enough useful text for the filter</p>
        <div><a href="https://www.linkedin.com/"><span>4 reactions</span><span>4</span></a></div>
        <hr />
        <div><div><button aria-label="Reaction button state: no reaction">Like</button><button aria-label="Open reactions menu"></button></div></div>
      </div>
      <div componentkey="expandedcomment_onlyFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Comment Only Author"></button>
        <span id="translatable-commentary-urn:li:activity:9000000000000000002"></span>
        <p>A comment-only current post with enough useful text for the filter</p>
        <div><div><div><p><span>1 comment</span><span>1 comment</span></p></div></div></div>
        <hr />
        <div><div><button aria-label="Reaction button state: no reaction">Like</button><button aria-label="Open reactions menu"></button></div></div>
        <div id="replaceableComment_urn:li:comment:(urn:li:activity:9000000000000000002,9000000000000000003)">
          <p>A complete single-kind fixture comment with enough text to collect</p>
        </div>
      </div>`);

    const posts = res.events.filter(
      (event: any) => event.origin_type === "post"
    );
    expect(posts).toHaveLength(2);
    expect(posts[0].metadata).toMatchObject({ reactions: 4 });
    expect(posts[0].metadata.comments).toBeUndefined();
    expect(posts[0].metadata.reposts).toBeUndefined();
    expect(posts[1].metadata).toMatchObject({ comments: 1 });
    expect(posts[1].metadata.reactions).toBeUndefined();
    expect(posts[1].metadata.reposts).toBeUndefined();
  });

  test("min_scrolls/max_scrolls pick a scroll budget in range each run", async () => {
    const scrollMaxes: number[] = [];
    const dispatcher = {
      dispatch: async (_action: string, input: Record<string, unknown>) => {
        scrollMaxes.push(
          (input.scrape_config as { scroll: { max: number } }).scroll.max
        );
        return {
          tab_id: 1,
          cs_scrape: true,
          result: {
            loggedIn: true,
            rows: [
              {
                id: "scroll-budget-fixture",
                body: "A loaded feed row used only to verify the scroll budget",
                post_identity: "urn:li:activity:1234567890123456789",
              },
            ],
          },
        };
      },
    };
    const connector = new LinkedInConnector();
    const realRandom = Math.random;
    // Force mid-range pick: min + floor(0.5 * (max-min+1)) = 6 + floor(2.5) = 8
    Math.random = () => 0.5;
    try {
      const res = await connector.sync({
        feedKey: "home_feed",
        config: { min_scrolls: 6, max_scrolls: 10 },
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      });
      expect(scrollMaxes).toEqual([8]);
      expect(res.metadata.scrolls_this_run).toBe(8);
    } finally {
      Math.random = realRandom;
    }
  });

  test("fails health checks when a logged-in feed emits no rows", async () => {
    const dispatcher = {
      dispatch: async () => ({ result: { loggedIn: true, rows: [] } }),
    };
    const connector = new LinkedInConnector();
    await expect(
      connector.sync({
        feedKey: "home_feed",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      })
    ).rejects.toThrow(/no post rows/i);
  });

  test("fails the whole batch when an organic post has no durable identity", async () => {
    const dispatcher = {
      dispatch: async () => ({
        result: {
          loggedIn: true,
          rows: [
            {
              id: "opaque-component-key",
              body: "Fixture Author • 1st A real organic post with enough text",
              post_url: "https://example.com/not-a-linkedin-post",
            },
          ],
        },
      }),
    };
    const connector = new LinkedInConnector();
    await expect(
      connector.sync({
        feedKey: "home_feed",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      })
    ).rejects.toThrow(/No partial home-feed batch was persisted/i);
  });

  test("ignores current feed modules without weakening organic-post identity checks", async () => {
    const dispatcher = {
      dispatch: async () => ({
        result: {
          loggedIn: true,
          rows: [
            {
              id: "market-like-a-pro-module",
              body: "Feed post Market like a pro Transform every high-performing post into a campaign that converts Learn how",
              author_control_label: "",
              post_url: "",
            },
            {
              id: "jobs-recommended-module",
              body: "Feed post Jobs recommended for you Staff / Senior Staff Engineer, AI Agent Engineering Equinix London (Hybrid) Show more",
              author_control_label: "",
              post_url: "",
            },
            {
              id: "organic-post",
              body: "Feed post Fixture Author • 1st A real organic post with enough text",
              author_control_label:
                "Open control menu for post by Fixture Author",
              post_url:
                "https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789",
            },
          ],
        },
      }),
    };
    const connector = new LinkedInConnector();

    const result = await connector.sync({
      feedKey: "home_feed",
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].origin_id).toBe(
      "li_home_activity_1234567890123456789"
    );
  });

  test("persists the durable post identity resolved from a copied short URL", async () => {
    const fetchImpl = async () =>
      new Response(null, {
        status: 301,
        headers: {
          location:
            "https://www.linkedin.com/posts/example-user_activity-1234567890123456789-abcd",
        },
      });
    const dispatcher = {
      dispatch: async () => ({
        result: {
          loggedIn: true,
          rows: [
            {
              id: "opaque-component-key",
              body: "Fixture Author • 1st A real organic post with enough text",
              post_url: "https://lnkd.in/p/example-token",
            },
          ],
        },
      }),
    };
    const connector = new LinkedInConnector(fetchImpl);

    const result = await connector.sync({
      feedKey: "home_feed",
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      origin_id: "li_home_activity_1234567890123456789",
      source_url:
        "https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789",
    });
  });

  test("never falls back to an embedded origin when copied-link resolution fails", async () => {
    const failedFetch = async () => {
      throw new Error("temporary redirect failure");
    };
    const dispatcher = {
      dispatch: async () => ({
        result: {
          loggedIn: true,
          rows: [
            {
              id: "opaque-component-key",
              body: "Fixture Author • 1st A real organic post with enough text",
              post_url: "https://lnkd.in/p/example-token",
              post_identity: "urn:li:share:1234567890123456789",
            },
          ],
        },
      }),
    };
    const connector = new LinkedInConnector(failedFetch);
    await expect(
      connector.sync({
        feedKey: "home_feed",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      })
    ).rejects.toThrow(/could not resolve.*No home-feed events were persisted/i);
  });

  test("fails health checks when every scraped row is unusable", async () => {
    const dispatcher = {
      dispatch: async () => ({
        result: {
          loggedIn: true,
          rows: [
            {
              id: "opaque_component_key",
              body: "Promoted Try LinkedIn Ads for more leads today",
              post_identity: "urn:li:activity:7111111111111111111",
            },
          ],
        },
      }),
    };
    const connector = new LinkedInConnector();
    await expect(
      connector.sync({
        feedKey: "home_feed",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      })
    ).rejects.toThrow(/usable content with a durable identity/i);
  });

  test("throws a clear error when not logged into LinkedIn", async () => {
    const dispatcher = {
      dispatch: async () => ({ result: { loggedIn: false, rows: [] } }),
    };
    const connector = new LinkedInConnector();
    const ctx = {
      feedKey: "home_feed",
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    };
    await expect(connector.sync(ctx)).rejects.toThrow(
      /Not logged into LinkedIn/
    );
  });
});

describe("normalizeLinkedInSlug", () => {
  test("collapses protocol / www / case / trailing-slash / bare-slug variants to one slug", () => {
    const canonical = "jane-doe";
    const variants = [
      "https://www.linkedin.com/in/jane-doe/",
      "http://linkedin.com/in/jane-doe",
      "https://www.linkedin.com/in/Jane-Doe",
      "https://www.LinkedIn.com/in/Jane-Doe/?trk=contacts",
      "linkedin.com/in/jane-doe#section",
      "jane-doe",
    ];
    for (const v of variants) {
      expect(normalizeLinkedInSlug(v)).toBe(canonical);
    }
  });

  test("preserves the full alphanumeric slug (with the trailing id hash)", () => {
    expect(
      normalizeLinkedInSlug("https://www.linkedin.com/in/tolga-ozen-65b10513a")
    ).toBe("tolga-ozen-65b10513a");
  });

  test("rejects empty, non-/in/ URLs, and junk", () => {
    expect(normalizeLinkedInSlug("")).toBe(null);
    expect(normalizeLinkedInSlug("   ")).toBe(null);
    expect(normalizeLinkedInSlug(null)).toBe(null);
    expect(normalizeLinkedInSlug(undefined)).toBe(null);
    // A non-profile URL has no `/in/` segment; the whole string fails the
    // slug charset (slashes/dots are not slug chars).
    expect(normalizeLinkedInSlug("https://www.linkedin.com/company/acme")).toBe(
      null
    );
    expect(normalizeLinkedInSlug("https://example.com/profile")).toBe(null);
  });
});

describe("LinkedInConnector takeout identity attributions", () => {
  test.each([
    "constructor",
    "toString",
    "__proto__",
  ])("rejects inherited feed key %s", async (feedKey) => {
    const connector = new LinkedInConnector();
    await expect(
      connector.definition.feeds.home_feed.sync({ feedKey, config: {} })
    ).rejects.toThrow("Unknown LinkedIn feed");
  });

  test("rejects a missing export directory rather than returning an empty sync", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-reader-missing-"));
    try {
      expect(() =>
        assertDirectory({ takeout_dir: path.join(dir, "missing") }, "LinkedIn")
      ).toThrow("takeout directory does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a regular file as an export directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-reader-file-"));
    try {
      const file = path.join(dir, "not-a-directory");
      writeFileSync(file, "fixture");
      expect(() => assertDirectory({ takeout_dir: file }, "LinkedIn")).toThrow(
        "takeout directory does not exist"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a valid export directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-reader-empty-"));
    try {
      expect(assertDirectory({ takeout_dir: dir }, "LinkedIn")).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("connections feed mints a person keyed on linkedin_slug + email, neither primary", () => {
    const def = new LinkedInConnector().definition;
    const attr = def.feeds.connections.eventKinds.connection.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.autoCreate).toBe(true);
    expect(attr.target.entityType).toBe("person");
    expect(attr.target.titlePath).toBe("author_name");

    const identities = attr.target.identities;
    const slug = identities.find(
      (i: { namespace: string }) => i.namespace === LINKEDIN_IDENTITY.SLUG
    );
    expect(slug).toMatchObject({
      namespace: "linkedin_slug",
      eventPath: "metadata.linkedin_slug",
    });
    // Equal-weight cross-channel matching: no primary until the live connector.
    expect(slug.primary).toBeUndefined();

    const email = identities.find(
      (i: { namespace: string }) => i.namespace === "email"
    );
    expect(email).toMatchObject({
      namespace: "email",
      eventPath: "metadata.email",
    });
    expect(email.primary).toBeUndefined();

    // The full URL survives only as a display trait, never as an identity.
    expect(
      identities.some(
        (i: { namespace: string }) => i.namespace === "linkedin_url"
      )
    ).toBe(false);
    expect(attr.traits.linkedin_url).toMatchObject({
      eventPath: "metadata.linkedin_url",
      mergeStrategy: "prefer_non_empty",
    });
  });

  test("messages feed attributes the sender via their profile-url slug", () => {
    const def = new LinkedInConnector().definition;
    const attr = def.feeds.messages.eventKinds.message.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.autoCreate).toBe(true);
    expect(attr.role).toBe("authored_by");
    expect(attr.target.identities).toEqual([
      {
        namespace: "linkedin_slug",
        eventPath: "metadata.sender_linkedin_slug",
      },
    ]);
  });

  test("a real connections row emits the metadata the slug identity resolves", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-takeout-"));
    writeFileSync(
      path.join(dir, "Connections.csv"),
      [
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
        "Jane,Doe,https://www.LinkedIn.com/in/Jane-Doe/,jane@acme.com,Acme,CEO,01 Jan 2024",
      ].join("\n")
    );

    const connector = new LinkedInConnector();
    // The reader is injected, not imported: `linkedin-takeout.ts` must stay
    // filesystem-free so the live feeds' bundle loads in the isolate. Here the
    // real on-disk reader supplies the capability, so this still exercises the
    // genuine CSV -> event path against a genuine file.
    const events = readConnections((file: string) =>
      parseCsv(readFileSync(path.join(dir, file), "utf8"))
    );
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.origin_type).toBe("connection");
    expect(event.author_name).toBe("Jane Doe");

    // The connection attribution's identity specs point at exactly these keys.
    const attr =
      connector.definition.feeds.connections.eventKinds.connection
        .attributions[0];
    for (const identity of attr.target.identities) {
      const value = resolvePath(event, identity.eventPath);
      expect(value).toBeTruthy();
    }
    // Full URL survives as a display trait...
    expect(resolvePath(event, "metadata.linkedin_url")).toBe(
      "https://www.LinkedIn.com/in/Jane-Doe/"
    );
    expect(resolvePath(event, "metadata.email")).toBe("jane@acme.com");
    // ...but the connector emits the ALREADY-canonical slug the identity keys
    // on, since the server won't run this example connector's normalizer. The
    // case-variant URL collapses to `jane-doe` at emit time.
    const slugSpec = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === "linkedin_slug"
    );
    expect(slugSpec.eventPath).toBe("metadata.linkedin_slug");
    expect(resolvePath(event, "metadata.linkedin_slug")).toBe("jane-doe");
  });

  test("applied_jobs feed reads the user's own job postings CSV", () => {
    const rows = parseCsv(
      "Title,Company Name,Create Date\nEngineer,Example,2024-01-01"
    );
    const connector = new LinkedInConnector();
    // readJobs is source-agnostic; the applied_jobs feedKey routes here.
    const events = readJobs(() => rows);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Engineer");
    // The definition exposes the renamed feed key, not the old "jobs" takeout.
    expect(connector.definition.feeds.applied_jobs).toBeDefined();
    expect(connector.definition.feeds.applied_jobs.name).toBe("Applied Jobs");
  });
});

describe("LinkedInConnector auth schema", () => {
  test("is none-only so a takeout/extension connection needs no OAuth handshake", () => {
    const def = new LinkedInConnector().definition;
    const methods = def.authSchema.methods;
    expect(methods).toHaveLength(1);
    expect(methods[0].type).toBe("none");
    // No oauth method — the server would otherwise pick it as authoritative and
    // force a LinkedIn OAuth flow before a connection could be created, blocking
    // the takeout + extension use cases (no feed consumes an OAuth token).
    expect(methods.some((m: { type: string }) => m.type === "oauth")).toBe(
      false
    );
  });
});

describe("normalizeLinkedInMemberId", () => {
  test("reduces fsd_profile / member URNs and bare ids to the id token", () => {
    expect(normalizeLinkedInMemberId("urn:li:fsd_profile:ACoAAB1234xyz")).toBe(
      "ACoAAB1234xyz"
    );
    expect(normalizeLinkedInMemberId("urn:li:member:987654")).toBe("987654");
    expect(normalizeLinkedInMemberId("ACoAAB1234xyz")).toBe("ACoAAB1234xyz");
  });

  test("rejects empty / non-id junk", () => {
    expect(normalizeLinkedInMemberId("")).toBe(null);
    expect(normalizeLinkedInMemberId(null)).toBe(null);
    expect(normalizeLinkedInMemberId(undefined)).toBe(null);
    // A slash-bearing URL is not a bare id token.
    expect(normalizeLinkedInMemberId("https://x.com/in/foo")).toBe(null);
  });

  test("rejects a NON-person URN so a company id never becomes a person id", () => {
    // The whole point: a company actor's urn must not normalize to a person id.
    expect(normalizeLinkedInMemberId("urn:li:fsd_company:99")).toBe(null);
    expect(normalizeLinkedInMemberId("urn:li:organization:123")).toBe(null);
    // A bare colon-string that isn't a person URN is rejected too.
    expect(normalizeLinkedInMemberId("foo:bar")).toBe(null);
  });
});

describe("LinkedInConnector live post author identity (member id)", () => {
  test("parseCompanyUpdates extracts author member id + slug from the Voyager actor", () => {
    // Minimal Voyager-shaped payload: an element referencing an actor in
    // `included`, the actor carrying an fsd_profile urn + a /in/ profile URL.
    const json = {
      included: [
        {
          entityUrn: "urn:li:actor:1",
          name: { text: "Jane Doe" },
          description: { text: "CEO at Acme" },
          "*miniProfile": "urn:li:fsd_profile:ACoAABcdef123",
          navigationContext: {
            actionTarget: "https://www.linkedin.com/in/Jane-Doe/",
          },
        },
      ],
      data: {
        data: {
          feed: {
            "*elements": [
              {
                entityUrn: "urn:li:activity:7200000000000000000",
                "*commentary": null,
                commentary: { text: { text: "Hello world" } },
                "*actor": "urn:li:actor:1",
              },
            ],
          },
        },
      },
    };

    const posts = parseCompanyUpdates("", json);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post.author).toBe("Jane Doe");
    expect(post.authorMemberId).toBe("ACoAABcdef123");
    // The case-variant /in/ URL collapses to the canonical slug.
    expect(post.authorSlug).toBe("jane-doe");
  });

  test("a company-authored post (no member urn) yields no member id", () => {
    const json = {
      included: [
        {
          entityUrn: "urn:li:actor:2",
          name: { text: "Acme Inc" },
          // company actor: a fsd_company urn, not fsd_profile
          "*miniProfile": "urn:li:fsd_company:99",
          navigationContext: {
            actionTarget: "https://www.linkedin.com/company/acme/",
          },
        },
      ],
      data: {
        data: {
          feed: {
            "*elements": [
              {
                entityUrn: "urn:li:activity:1",
                commentary: { text: { text: "We are hiring" } },
                "*actor": "urn:li:actor:2",
              },
            ],
          },
        },
      },
    };
    const [post] = parseCompanyUpdates("", json);
    expect(post.authorMemberId).toBeUndefined();
    // /company/ URL is not a person slug.
    expect(post.authorSlug).toBeUndefined();
  });

  test("company_updates post attribution matches member id + slug equal-weight (neither primary)", () => {
    const def = new LinkedInConnector().definition;
    const attr = def.feeds.company_updates.eventKinds.post.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.role).toBe("authored_by");
    expect(attr.autoCreate).toBe(true);
    // NO createWhen gate: a member_id-primary mint-gate would fork the existing
    // slug-keyed takeout person. Equal-weight union binds them instead.
    expect(attr.target.createWhen).toBeUndefined();

    const memberId = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === LINKEDIN_IDENTITY.MEMBER_ID
    );
    expect(memberId).toMatchObject({
      namespace: "linkedin_member_id",
      eventPath: "metadata.author_member_id",
    });
    // CRITICAL: member_id is NOT primary — a primary that misses would mint a
    // new person and fork the takeout-first slug person.
    expect(memberId.primary).toBeUndefined();

    const slug = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === LINKEDIN_IDENTITY.SLUG
    );
    expect(slug).toMatchObject({
      namespace: "linkedin_slug",
      eventPath: "metadata.author_linkedin_slug",
    });
    expect(slug.primary).toBeUndefined();
  });

  test("parseCompanyUpdates reads the miniProfile urn as a bare string too", () => {
    // Voyager sometimes gives `miniProfile` as the urn STRING itself (not a ref
    // or an object). Codex flagged this shape as previously missed.
    const json = {
      included: [
        {
          entityUrn: "urn:li:actor:3",
          name: { text: "Bare Shape" },
          miniProfile: "urn:li:fsd_profile:ACoAABbareXYZ",
        },
      ],
      data: {
        data: {
          feed: {
            "*elements": [
              {
                entityUrn: "urn:li:activity:3",
                commentary: { text: { text: "post body" } },
                "*actor": "urn:li:actor:3",
              },
            ],
          },
        },
      },
    };
    const [post] = parseCompanyUpdates("", json);
    expect(post.authorMemberId).toBe("ACoAABbareXYZ");
  });
});

function resolvePath(obj: any, dotPath: string): unknown {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

describe("prepare_comment helpers", () => {
  test("normalizeLinkedInPostUrl accepts urls, urns, and bare ids", () => {
    expect(normalizeLinkedInPostUrl("7312345678901234567")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(normalizeLinkedInPostUrl("li_post_7312345678901234567")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl("urn:li:activity:7312345678901234567")
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl(
        "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567/"
      )
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl(
        "https://www.linkedin.com/feed/?updateEntityUrn=urn%3Ali%3Aactivity%3A7312345678901234567"
      )
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl(
        "http://www.linkedin.com/posts/example_activity-7312345678901234567-x"
      )
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl("https://www.linkedin.com/feed/")
    ).toBeNull();
    expect(normalizeLinkedInPostUrl("ftp://linkedin.com/post")).toBeNull();
    expect(normalizeLinkedInPostUrl("https://evil.example/x")).toBeNull();
    expect(normalizeLinkedInPostUrl("")).toBeNull();
  });

  test("resolves a Copy-link short URL to the durable LinkedIn share id", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl = async (input: URL, init: RequestInit) => {
      calls.push({ input: input.href, init });
      return new Response(null, {
        status: 301,
        headers: {
          location:
            "https://www.linkedin.com/posts/example-user_example-share-1234567890123456789-abcd/?utm_source=share",
        },
      });
    };

    await expect(
      resolveLinkedInShortPostUrl("https://lnkd.in/p/example-token", fetchImpl)
    ).resolves.toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:1234567890123456789"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://lnkd.in/p/example-token");
    expect(calls[0].init.method).toBe("HEAD");
    expect(calls[0].init.redirect).toBe("manual");
  });

  test("resolves only LinkedIn post short links and leaves other rows untouched", async () => {
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 301,
        headers: {
          location:
            "https://www.linkedin.com/posts/example-user_activity-1234567890123456789-abcd",
        },
      });
    };
    const rows = [
      {
        id: "short",
        body: "Short URL fixture",
        post_url: "https://lnkd.in/p/example",
      },
      {
        id: "canonical",
        body: "Canonical fixture",
        post_url:
          "https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456790",
      },
      {
        id: "unsupported",
        body: "Unsupported fixture",
        post_url: "https://example.com/post/1",
      },
    ];

    const resolved = await resolveHomeFeedPostUrls(rows, fetchImpl);
    expect(fetchCount).toBe(1);
    expect(resolved[0].post_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789"
    );
    expect(resolved[1]).toBe(rows[1]);
    expect(resolved[2]).toBe(rows[2]);
  });

  test("isLinkedInAuthWall detects login walls", () => {
    expect(isLinkedInAuthWall("https://www.linkedin.com/login")).toBe(true);
    expect(isLinkedInAuthWall("https://www.linkedin.com/authwall")).toBe(true);
    expect(
      isLinkedInAuthWall(
        "https://www.linkedin.com/feed/update/urn:li:activity:1"
      )
    ).toBe(false);
  });

  test("submit labels are never treated as open-composer controls", () => {
    expect(isCommentSubmitLabel("Post")).toBe(true);
    expect(isCommentSubmitLabel("Submit")).toBe(true);
    expect(isCommentSubmitLabel("Send")).toBe(true);
    expect(isCommentSubmitLabel("Post comment")).toBe(true);
    expect(isCommentSubmitLabel("Comment")).toBe(false);
    expect(isCommentOpenLabel("Comment")).toBe(true);
    expect(isCommentOpenLabel("Post")).toBe(false);
    expect(isCommentOpenLabel("Post a comment")).toBe(true);
  });

  test("pickComment*Ref finds composer controls without selecting Post", () => {
    const tree = [
      { ref_id: 1, role: "button", name: "Like", tag: "button" },
      { ref_id: 2, role: "button", name: "Comment", tag: "button" },
      { ref_id: 3, role: "button", name: "Repost", tag: "button" },
      { ref_id: 4, role: "textbox", name: "Add a comment…", tag: "div" },
      { ref_id: 5, role: "button", name: "Post", tag: "button" },
    ];
    expect(pickCommentButtonRef(tree, 7)).toEqual({
      document_epoch: 7,
      ref_id: 2,
    });
    expect(pickCommentTextboxRef(tree, 7)).toEqual({
      document_epoch: 7,
      ref_id: 4,
    });
    expect(pickCommentButtonRef(tree, 7)?.ref_id).not.toBe(5);
  });

  test("buildFillCommentExpression embeds body safely and never auto-submits", () => {
    const expr = buildFillCommentExpression('hello "world"\nline2');
    expect(expr).toContain('hello \\"world\\"');
    expect(expr).toContain("insertText");
    expect(expr).toContain("isSubmitLabel");
    expect(expr).toContain("submitted: false");
    expect(expr).not.toMatch(
      /dispatchKeyEvent|key:\s*['"]Enter['"]|Meta\+Enter/i
    );
    expect(expr).toContain("composer_not_found");
  });

  test("truncateHandoffReason caps length for the banner", () => {
    expect(truncateHandoffReason("  short  ")).toBe("short");
    expect(truncateHandoffReason("")).toBeUndefined();
    const long = "x".repeat(200);
    const t = truncateHandoffReason(long, 40)!;
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t.endsWith("…")).toBe(true);
  });

  test("buildInjectHandoffBannerExpression is Lobu-branded and not a submit", () => {
    const expr = buildInjectHandoffBannerExpression({
      reason: 'Met them at "AI" meetup',
    });
    expect(expr).toContain("lobu-handoff-banner");
    expect(expr).toContain("Lobu staged this comment");
    expect(expr).toContain("record the outcome in Lobu Activity");
    expect(expr).toContain("reject it with a reason");
    expect(expr).toContain('Met them at \\"AI\\" meetup');
    expect(expr).not.toMatch(/click\(\)\s*;[\s\S]*Post|Post[\s\S]*\.click\(/);
    expect(expr).not.toContain("setTimeout");
    expect(expr).toContain("root.remove()");
  });

  test("definition lets prepare_comment stage without a redundant approval gate", () => {
    const c = new LinkedInConnector();
    const action = c.definition.actions?.prepare_comment;
    expect(action?.key).toBe("prepare_comment");
    expect(action?.requiresApproval).toBe(false);
    expect(action?.kind).toBe("write");
    expect(action?.annotations?.destructiveHint).toBe(false);
    expect(action?.inputSchema?.anyOf).toEqual([
      { required: ["post_url"] },
      { required: ["activity_id"] },
    ]);
    expect(action?.inputSchema?.properties).not.toHaveProperty(
      "browser_connection_id"
    );
    expect(c.definition.version).toBe("3.11.11");
    expect(String(action?.description ?? "")).toMatch(
      /NEVER opens a tab or submits/i
    );
  });

  test("definition declares verify_staged_comment as read-only", () => {
    const c = new LinkedInConnector();
    const action = c.definition.actions?.verify_staged_comment;
    expect(action?.key).toBe("verify_staged_comment");
    expect(action?.requiresApproval).toBe(false);
    expect(action?.kind).toBe("read");
    expect(action?.annotations?.destructiveHint).toBe(false);
    expect(action?.annotations?.idempotentHint).toBe(true);
    expect(
      action?.outputSchema?.properties?.match?.properties?.match_kind?.enum
    ).toEqual(["exact", "prefix", "contains"]);
  });

  test("commentBodiesMatch normalizes without accepting weak partial matches", () => {
    expect(normalizeCommentMatchText("  Hello\nWorld  ")).toBe("hello world");
    expect(commentBodiesMatch("Hello world", "Hello world").ok).toBe(true);
    expect(commentBodiesMatch("Hello world", "Hello world").kind).toBe("exact");
    expect(
      commentBodiesMatch(
        "A sufficiently distinctive draft body that continues after truncation",
        "A sufficiently distinctive draft body"
      ).kind
    ).toBe("prefix");
    expect(
      commentBodiesMatch(
        "a reasonably long draft body",
        "Prefix a reasonably long draft body suffix"
      ).kind
    ).toBe("contains");
    expect(
      commentBodiesMatch(
        "Great insight followed by the rest of the staged draft",
        "Great insight"
      ).ok
    ).toBe(false);
    expect(
      commentBodiesMatch(
        "This staged draft has an embedded generic phrase",
        "staged draft"
      ).ok
    ).toBe(false);
    expect(commentBodiesMatch("hello", "goodbye").ok).toBe(false);
  });

  test("buildScrapeCommentsExpression is read-only (no submit)", () => {
    const expr = buildScrapeCommentsExpression();
    expect(expr).toContain("comments-comment-item");
    expect(expr).not.toMatch(
      /insertText|dispatchKeyEvent|key:\s*['"]Enter['"]/
    );
    expect(expr).not.toMatch(/Post[\s\S]*\.click\(/);
  });

  test("verifyLinkedInStagedComment matches scraped comments", async () => {
    const log: string[] = [];
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push(key);
        if (key === "navigate") {
          return {
            tab_id: 3,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return { found: true };
        if (key === "evaluate") {
          const expr = String(input.expression);
          if (expr.includes("load more comments")) return { value: true };
          return {
            value: {
              ok: true,
              comments: [
                { author: "Other", text: "unrelated" },
                {
                  author: "Burak",
                  text: "Great insight — thanks for sharing.",
                },
              ],
              count: 2,
            },
          };
        }
        if (key === "focus_tab") return {};
        throw new Error(`unexpected ${key}`);
      },
    };
    const result = await verifyLinkedInStagedComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "Great insight — thanks for sharing.",
      author_hint: "Burak",
    });
    expect(result.verified).toBe(true);
    expect(result.comments_scanned).toBe(2);
    expect(result.match?.author).toBe("Burak");
    expect(result.match?.match_kind).toBe("exact");
    expect(log).not.toContain("click_ref");
    expect(log).not.toContain("type_ref");
  });

  test("verifyLinkedInStagedComment reports no match cleanly", async () => {
    const dispatcher = {
      dispatch: async (key: string) => {
        if (key === "navigate") {
          return {
            tab_id: 3,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return {};
        if (key === "evaluate") {
          return {
            value: {
              comments: [{ author: "A", text: "something else" }],
              count: 1,
            },
          };
        }
        if (key === "focus_tab") return {};
        return {};
      },
    };
    const result = await verifyLinkedInStagedComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "the staged draft that was never posted",
      focus: false,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("no_matching_comment");
    expect(result.comments_scanned).toBe(1);
  });

  test("prepareLinkedInComment stages via evaluate (primary) and never clicks Post", async () => {
    const log: Array<{ key: string; input: Record<string, unknown> }> = [];
    let evaluateCalls = 0;
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push({ key, input });
        if (key === "navigate") {
          return {
            tab_id: 42,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
            title: "Post",
          };
        }
        if (key === "wait_for_selector") return { found: true };
        if (key === "evaluate") {
          evaluateCalls += 1;
          const expr = String(input.expression);
          if (evaluateCalls === 1) {
            expect(expr).toContain("Great insight — thanks for sharing.");
            return {
              value: {
                ok: true,
                reason: "typed",
                preview: "Great insight — thanks for sharing.",
              },
            };
          }
          // Banner inject
          expect(expr).toContain("lobu-handoff-banner");
          expect(expr).toContain("Met at conference");
          return { value: { ok: true, anchored: true } };
        }
        throw new Error(`unexpected dispatch ${key}`);
      },
    };

    const result = await prepareLinkedInComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "Great insight — thanks for sharing.",
      reason: "Met at conference",
    });

    expect(result).toMatchObject({
      prepared: true,
      tab_id: 42,
      method: "evaluate",
      body: "Great insight — thanks for sharing.",
      banner_shown: true,
      reason_preview: "Met at conference",
    });
    expect(result.post_url).toContain("activity:7312345678901234567");

    const keys = log.map((e) => e.key);
    expect(keys).toEqual([
      "navigate",
      "wait_for_selector",
      "evaluate",
      "evaluate",
    ]);
    // Never click Post (no click_ref at all on the happy path).
    expect(keys).not.toContain("click_ref");
    expect(keys).not.toContain("type_ref");
  });

  test("never releases a tab when the composer was never filled", async () => {
    const log: string[] = [];
    const dispatcher = {
      dispatch: async (key: string) => {
        log.push(key);
        if (key === "navigate") {
          return {
            tab_id: 42,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return { found: true };
        if (key === "evaluate") return { value: { ok: false } };
        if (key === "get_accessibility_tree") {
          return { document_epoch: 1, tree: [] };
        }
        return {};
      },
    };
    await expect(
      prepareLinkedInComment(dispatcher, {
        postUrl: "7312345678901234567",
        body: "hi",
      })
    ).rejects.toThrow(/could not fill comment composer/);
    // Failure must not attempt any follow-up tab mutation.
    expect(log).not.toContain("release_tab");
    expect(log).not.toContain("focus_tab");
  });

  test("prepareLinkedInComment falls back to type_ref when evaluate is unavailable", async () => {
    const log: string[] = [];
    let evaluateCalls = 0;
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push(key);
        if (key === "navigate") {
          return {
            tab_id: 9,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return {};
        if (key === "evaluate") {
          evaluateCalls += 1;
          // First call is fill; later is banner.
          if (evaluateCalls === 1) {
            throw new Error("evaluate unavailable");
          }
          return { value: { ok: true, anchored: false } };
        }
        if (key === "get_accessibility_tree") {
          return {
            document_epoch: 1,
            tree: [
              { ref_id: 1, role: "button", name: "Comment", tag: "button" },
              {
                ref_id: 2,
                role: "textbox",
                name: "Add a comment…",
                tag: "div",
              },
              { ref_id: 3, role: "button", name: "Post", tag: "button" },
            ],
          };
        }
        if (key === "type_ref") {
          expect((input.ref as { ref_id: number }).ref_id).toBe(2);
          expect(input.text).toBe("hi");
          return {};
        }
        throw new Error(`unexpected ${key} ${JSON.stringify(input)}`);
      },
    };

    const result = await prepareLinkedInComment(dispatcher, {
      postUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
      body: "hi",
    });
    expect(result.method).toBe("type_ref");
    expect(result.prepared).toBe(true);
    expect(result.banner_shown).toBe(true);
    expect(log).toContain("evaluate");
    expect(log).toContain("type_ref");
    expect(log).not.toContain("show_notification");
    // Must not click the Post submit control.
    expect(log).not.toContain("click_ref");
  });

  test("prepareLinkedInComment fails closed on auth wall", async () => {
    const dispatcher = {
      dispatch: async (key: string) => {
        if (key === "navigate") {
          return {
            tab_id: 1,
            current_url: "https://www.linkedin.com/login",
          };
        }
        throw new Error(`unexpected ${key}`);
      },
    };
    await expect(
      prepareLinkedInComment(dispatcher, {
        postUrl: "1234567890123",
        body: "x",
      })
    ).rejects.toThrow(/Not logged into LinkedIn/);
  });

  test("prepareLinkedInComment requires the exact activated page without selecting a browser", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        inputs.push(input);
        if (key === "navigate") {
          return {
            tab_id: 9,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "evaluate") {
          return { value: { ok: true, reason: "typed", preview: "Nice post" } };
        }
        return {};
      },
    };

    await prepareLinkedInComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "Nice post",
      banner: false,
    });

    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0]?.require_page_activation).toBe(true);
    expect(inputs[0]).not.toHaveProperty("open_in_new_tab");
    expect(inputs.every((input) => !input.target_browser_connection_id)).toBe(
      true
    );
  });

  test("execute prepare_comment returns success output via dispatcher", async () => {
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "prepare_comment",
      input: {
        activity_id: "7312345678901234567",
        body: "Nice post",
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async (key: string) => {
            if (key === "navigate") {
              return {
                tab_id: 5,
                current_url:
                  "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
              };
            }
            if (key === "wait_for_selector") return {};
            if (key === "evaluate") {
              return {
                value: { ok: true, reason: "typed", preview: "Nice post" },
              };
            }
            return {};
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.prepared).toBe(true);
    expect(result.output?.status).toBe("prepared");
    expect(result.output?.tab_id).toBe(5);
    expect(result.output?.method).toBe("evaluate");
  });

  test("execute verify_staged_comment routes through the read path", async () => {
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "verify_staged_comment",
      input: {
        activity_id: "7312345678901234567",
        body: "Nice post",
        author_hint: "Burak",
        focus: false,
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async (key: string, input: Record<string, unknown>) => {
            if (key === "navigate") {
              return {
                tab_id: 6,
                current_url:
                  "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
              };
            }
            if (key === "wait_for_selector") return {};
            if (key === "evaluate") {
              const expr = String(input.expression);
              if (expr.includes("load|show|view")) return { value: false };
              return {
                value: {
                  comments: [{ author: "Burak", text: "Nice post" }],
                },
              };
            }
            throw new Error(`unexpected ${key}`);
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.verified).toBe(true);
    expect(result.output?.status).toBe("verified");
    expect(result.output?.match?.author).toBe("Burak");
  });

  test("execute prepare_comment on a generic feed URL is not_actionable, NOT a failed run", async () => {
    // A generic linkedin.com/feed/ URL addresses the whole feed, not a post.
    // prepare_comment must refuse it WITHOUT dispatching any browser action and
    // WITHOUT creating a failed operational run.
    let dispatches = 0;
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "prepare_comment",
      input: {
        post_url: "https://www.linkedin.com/feed/",
        body: "Nice post",
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async () => {
            dispatches += 1;
            throw new Error("must not dispatch for a generic feed URL");
          },
        },
      },
    });
    expect(result.success).toBe(true); // non-failing result
    expect(result.output?.status).toBe("not_actionable");
    expect(result.output?.reason).toBe("missing_durable_post_id");
    expect(dispatches).toBe(0);
  });

  test("execute prepare_comment accepts an activity URN as a durable identity", async () => {
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "prepare_comment",
      input: {
        activity_id: "urn:li:activity:7312345678901234567",
        body: "Nice post",
        banner: false,
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async (key: string) => {
            if (key === "navigate") {
              return {
                tab_id: 9,
                current_url:
                  "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
              };
            }
            if (key === "evaluate") {
              return { value: { ok: true, preview: "Nice post" } };
            }
            return {};
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.prepared).toBe(true);
    expect(result.output?.status).toBe("prepared");
    expect(result.output?.post_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
  });

  test("execute prepare_comment accepts a canonical post URL as a durable identity", async () => {
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "prepare_comment",
      input: {
        post_url:
          "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
        body: "Nice post",
        banner: false,
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async (key: string) => {
            if (key === "navigate") {
              return {
                tab_id: 10,
                current_url:
                  "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
              };
            }
            if (key === "evaluate") {
              return { value: { ok: true, preview: "Nice post" } };
            }
            return {};
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.prepared).toBe(true);
    expect(result.output?.status).toBe("prepared");
    expect(result.output?.post_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
  });

  test("execute verify_staged_comment on a generic feed URL is not_actionable, NOT a failed run", async () => {
    let dispatches = 0;
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "verify_staged_comment",
      input: {
        post_url: "https://www.linkedin.com/feed",
        body: "Nice post",
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async () => {
            dispatches += 1;
            throw new Error("must not dispatch for a generic feed URL");
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.status).toBe("not_actionable");
    expect(result.output?.reason).toBe("missing_durable_post_id");
    expect(dispatches).toBe(0);
  });

  test("buildHomeFeedEvents persists the canonical post URL as source_url", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "/feed/update/urn:li:activity:7345678901234567890?utm_source=feed",
          post_identity: "urn:li:activity:7345678901234567890",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );
    expect(ev.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7345678901234567890"
    );
  });

  test("buildHomeFeedEvents derives the canonical URL for share/ugcPost ids", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "/feed/update/urn:li:share:7345678901234567890?utm_source=feed",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );
    expect(ev.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7345678901234567890"
    );
  });

  test("isGenericLinkedInFeedUrl identifies home-feed URLs with no post id", () => {
    expect(isGenericLinkedInFeedUrl("https://www.linkedin.com/feed/")).toBe(
      true
    );
    expect(isGenericLinkedInFeedUrl("https://www.linkedin.com/feed")).toBe(
      true
    );
    expect(
      isGenericLinkedInFeedUrl("https://www.linkedin.com/feed/update")
    ).toBe(true);
    expect(
      isGenericLinkedInFeedUrl("https://www.linkedin.com/feed/hashtag/ai/")
    ).toBe(true);
    expect(
      isGenericLinkedInFeedUrl("https://www.linkedin.com/feed/trending")
    ).toBe(true);
    expect(
      isGenericLinkedInFeedUrl(
        "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
      )
    ).toBe(false);
    expect(isGenericLinkedInFeedUrl("https://evil.example/x")).toBe(false);
    expect(isGenericLinkedInFeedUrl("")).toBe(false);
  });
});
