import path from "node:path";
import { assertDirectory, readJsArray } from "./takeout-fs.ts";
import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventAttributionRule,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  batchSize,
  type LocalTakeoutConfig,
  maxEventCursor,
  stableId,
  takeBatch,
  twitterSnowflakeDate,
} from "./takeout-utils.ts";
import {
  handleFromUserLink,
  normalizeXHandle,
  X_IDENTITY,
} from "./x-identity.ts";

/**
 * A tweet the user *replied to* names the person they replied to via
 * `in_reply_to_user_id` (immutable numeric id) + `in_reply_to_screen_name`
 * (mutable handle). Emit it as an `about` attribution keyed on the SAME
 * `x_user_id`/`x_handle` namespaces the live X connector uses, so a reply
 * target consolidates onto the person the live connector already tracks —
 * across the connector/connection boundary.
 *
 * `createWhen: { in_reply_to_user_id exists }` gates minting on the IMMUTABLE
 * numeric id: a reply whose archive row carries only a handle (no user id)
 * matches an existing person by `x_handle` but NEVER auto-creates. Otherwise a
 * handle-only person would fork — a later live-X event carrying the real
 * primary `x_user_id` won't merge into a person that has no primary id, so the
 * two would coexist as duplicates. Mint only when we have the durable key.
 */
const X_REPLY_TARGET_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      createWhen: { path: "metadata.in_reply_to_user_id", exists: true },
      titlePath: "metadata.in_reply_to_screen_name",
      identities: [
        {
          namespace: X_IDENTITY.USER_ID,
          eventPath: "metadata.in_reply_to_user_id",
          primary: true,
        },
        {
          namespace: X_IDENTITY.HANDLE,
          eventPath: "metadata.in_reply_to_screen_name",
        },
      ],
    },
    traits: {
      x_handle: {
        eventPath: "metadata.in_reply_to_screen_name",
        mergeStrategy: "prefer_non_empty",
      },
      last_x_interaction_at: {
        eventPath: "occurred_at",
        mergeStrategy: "overwrite",
      },
    },
  },
];

/**
 * A DM names both parties by immutable numeric id (`sender_id`/`recipient_id`)
 * but a takeout gives no way to tell which id is the connected account itself.
 * So attribute BOTH ids `matchOnly` (accrete DM history onto an already-known
 * person, but never MINT one from a raw numeric id — that would risk minting a
 * "person" for the user's own account). No handle is present in the DM archive.
 */
const X_DM_PARTY_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: false,
    target: {
      entityType: "person",
      identities: [
        {
          namespace: X_IDENTITY.USER_ID,
          eventPath: "metadata.sender_id",
          matchOnly: true,
        },
      ],
    },
    traits: {
      last_x_dm_at: { eventPath: "occurred_at", mergeStrategy: "overwrite" },
    },
  },
  {
    role: "about",
    autoCreate: false,
    target: {
      entityType: "person",
      identities: [
        {
          namespace: X_IDENTITY.USER_ID,
          eventPath: "metadata.recipient_id",
          matchOnly: true,
        },
      ],
    },
  },
];

/**
 * Followers/following name a person by immutable numeric `account_id` +
 * (optional) `handle` recovered from the profile link. These ARE the user's
 * network, so `autoCreate` mints a person per row keyed primary on `x_user_id`
 * so they fuse with the live connector's people — but ONLY when the numeric
 * `account_id` is present. A follow row that carries only a `userLink`/handle
 * (no account id) matches an existing person by `x_handle` but never mints:
 * a handle-only person can't merge with a later live-X event that has the real
 * primary `x_user_id`, so minting one would fork a duplicate. `createWhen`
 * gates the mint on the durable key.
 */
const X_FOLLOW_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      createWhen: { path: "metadata.account_id", exists: true },
      titlePath: "metadata.handle",
      identities: [
        {
          namespace: X_IDENTITY.USER_ID,
          eventPath: "metadata.account_id",
          primary: true,
        },
        { namespace: X_IDENTITY.HANDLE, eventPath: "metadata.handle" },
      ],
    },
    traits: {
      x_handle: {
        eventPath: "metadata.handle",
        mergeStrategy: "prefer_non_empty",
      },
    },
  },
];

interface TwitterTakeoutCheckpoint {
  last_tweets_timestamp?: string;
  last_messages_timestamp?: string;
  last_likes_timestamp?: string;
  last_followers_timestamp?: string;
  last_following_timestamp?: string;
}

interface TweetRecord {
  tweet?: {
    id?: string;
    id_str?: string;
    full_text?: string;
    text?: string;
    created_at?: string;
    source?: string;
    retweet_count?: string;
    favorite_count?: string;
    lang?: string;
    entities?: Record<string, unknown>;
    in_reply_to_status_id_str?: string;
    in_reply_to_user_id_str?: string;
    in_reply_to_screen_name?: string;
  };
}

interface LikeRecord {
  like?: {
    tweetId?: string;
    fullText?: string;
    expandedUrl?: string;
  };
}

interface DmRecord {
  dmConversation?: {
    conversationId?: string;
    messages?: Array<{
      messageCreate?: {
        id?: string;
        createdAt?: string;
        text?: string;
        senderId?: string;
        recipientId?: string;
        urls?: unknown[];
        mediaUrls?: string[];
        reactions?: unknown[];
      };
    }>;
  };
}

interface FollowRecord {
  follower?: { accountId?: string; userLink?: string };
  following?: { accountId?: string; userLink?: string };
}

export default class TwitterTakeoutConnector extends ConnectorRuntime<
  TwitterTakeoutCheckpoint,
  LocalTakeoutConfig
> {
  readonly definition: RuntimeConnectorDefinition<
    TwitterTakeoutCheckpoint,
    LocalTakeoutConfig
  > = {
    key: "twitter.takeout",
    name: "X/Twitter Takeout",
    version: "1.1.0",
    description: "Ingests local X/Twitter archive exports.",
    authSchema: { methods: [{ type: "none" }] },
    // Feed sync reads an absolute path on the user's own machine. Per the SDK
    // contract, omitting `runtime` means "runs on the cloud worker fleet" and
    // omitting `requiredCapability` means "any worker" — so declaring neither
    // is what let `worker-api/poll.ts` hand these runs to a Kubernetes pod with
    // no ~/Downloads (unpinned connections), or to the Swift Mac bridge, which
    // cannot execute a TypeScript connector at all (pinned connections). Two
    // error strings, one missing declaration.
    //
    // `os.files` is already in OS_CAPABILITIES and allowlisted for macos, so no
    // core change is needed. NOTE: no worker advertises `os.files` today, so
    // this does not make takeout ingest work — it makes the failure honest
    // ("no worker serves this") instead of a silent misroute.
    requiredCapability: "os.files",
    runtime: { platforms: ["macos"] },
    feeds: {
      tweets: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "tweets",
        name: "Tweets and Replies",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/tweets.js."
        ),
        eventKinds: {
          reply: {
            description: "A reply the user posted to another account",
            attributions: X_REPLY_TARGET_ATTRIBUTIONS,
          },
        },
      },
      messages: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "messages",
        name: "Direct Messages",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing DM files."
        ),
        eventKinds: {
          dm_message: {
            description: "A direct message between the user and a counterparty",
            attributions: X_DM_PARTY_ATTRIBUTIONS,
          },
        },
      },
      likes: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "likes",
        name: "Likes",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/like.js."
        ),
      },
      followers: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "followers",
        name: "Followers",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/follower.js."
        ),
        eventKinds: {
          follower: {
            description: "An account that follows the user",
            attributions: X_FOLLOW_ATTRIBUTIONS,
          },
        },
      },
      following: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "following",
        name: "Following",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/following.js."
        ),
        eventKinds: {
          following: {
            description: "An account the user follows",
            attributions: X_FOLLOW_ATTRIBUTIONS,
          },
        },
      },
    },
  };

  private async syncFeed(
    ctx: SyncContext<TwitterTakeoutCheckpoint, LocalTakeoutConfig>
  ): Promise<SyncResult> {
    const takeoutDir = assertDirectory(ctx.config, "X/Twitter");
    const dataDir = path.join(takeoutDir, "data");
    const max = batchSize(ctx.config);

    if (ctx.feedKey === "tweets") {
      return this.result(
        ctx,
        "last_tweets_timestamp",
        this.readTweetEvents(dataDir),
        max
      );
    }
    if (ctx.feedKey === "messages") {
      return this.result(
        ctx,
        "last_messages_timestamp",
        this.readMessageEvents(dataDir),
        max
      );
    }
    if (ctx.feedKey === "likes") {
      return this.result(
        ctx,
        "last_likes_timestamp",
        this.readLikeEvents(dataDir),
        max
      );
    }
    if (ctx.feedKey === "followers") {
      return this.result(
        ctx,
        "last_followers_timestamp",
        this.readFollowEvents(dataDir, "follower"),
        max
      );
    }
    if (ctx.feedKey === "following") {
      return this.result(
        ctx,
        "last_following_timestamp",
        this.readFollowEvents(dataDir, "following"),
        max
      );
    }

    throw new Error(`Unknown X/Twitter Takeout feed: ${ctx.feedKey}`);
  }

  private async result(
    ctx: SyncContext<TwitterTakeoutCheckpoint, LocalTakeoutConfig>,
    key: keyof TwitterTakeoutCheckpoint,
    allEvents: EventEnvelope[],
    max: number
  ): Promise<SyncResult> {
    const events = takeBatch(allEvents, ctx.checkpoint?.[key], max);
    await ctx.commit(events, {
      ...ctx.checkpoint,
      [key]: maxEventCursor(events, ctx.checkpoint?.[key]),
    });
    return { status: "complete" };
  }

  private readTweetEvents(dataDir: string): EventEnvelope[] {
    return readJsArray<TweetRecord>(path.join(dataDir, "tweets.js")).flatMap(
      (record) => {
        const tweet = record.tweet;
        const occurredAt = tweet?.created_at
          ? new Date(tweet.created_at)
          : undefined;
        const tweetId = tweet?.id_str ?? tweet?.id;
        if (
          !tweet ||
          !tweetId ||
          !occurredAt ||
          Number.isNaN(occurredAt.getTime())
        )
          return [];
        const isReply = Boolean(
          tweet.in_reply_to_status_id_str || tweet.in_reply_to_screen_name
        );
        const text = tweet.full_text ?? tweet.text ?? "";
        return [
          {
            origin_id: `x_tweet_${tweetId}`,
            origin_type: isReply ? "reply" : "tweet",
            occurred_at: occurredAt,
            payload_text: text,
            source_url: `https://twitter.com/i/web/status/${tweetId}`,
            title: text.slice(0, 120),
            metadata: {
              platform: "x",
              tweet_id: tweetId,
              retweet_count: tweet.retweet_count
                ? Number(tweet.retweet_count)
                : undefined,
              favorite_count: tweet.favorite_count
                ? Number(tweet.favorite_count)
                : undefined,
              language: tweet.lang,
              source: tweet.source,
              entities: tweet.entities,
              in_reply_to_status_id: tweet.in_reply_to_status_id_str,
              in_reply_to_user_id: tweet.in_reply_to_user_id_str,
              // Normalized at emit time (lowercased handle): the server does not
              // run this example connector's identity normalizer, so the value
              // must already be in canonical `x_handle` form to match the live
              // X connector's people. Raw display name kept separately.
              in_reply_to_screen_name: normalizeXHandle(
                tweet.in_reply_to_screen_name
              ),
              in_reply_to_screen_name_raw: tweet.in_reply_to_screen_name,
            },
          },
        ];
      }
    );
  }

  private readMessageEvents(dataDir: string): EventEnvelope[] {
    const oneToOne = readJsArray<DmRecord>(
      path.join(dataDir, "direct-messages.js")
    );
    const group = readJsArray<DmRecord>(
      path.join(dataDir, "direct-messages-group.js")
    );
    return [...oneToOne, ...group].flatMap((conversation) => {
      const conversationId = conversation.dmConversation?.conversationId;
      return (
        conversation.dmConversation?.messages?.flatMap((message) => {
          const created = message.messageCreate;
          const occurredAt = created?.createdAt
            ? new Date(created.createdAt)
            : undefined;
          if (!created?.id || !occurredAt || Number.isNaN(occurredAt.getTime()))
            return [];
          return [
            {
              origin_id: `x_dm_${created.id}`,
              origin_type: "dm_message",
              occurred_at: occurredAt,
              payload_text: created.text ?? "",
              metadata: {
                platform: "x",
                conversation_id: conversationId,
                sender_id: created.senderId,
                recipient_id: created.recipientId,
                urls: created.urls ?? [],
                media_urls: created.mediaUrls ?? [],
                reactions: created.reactions ?? [],
              },
            },
          ];
        }) ?? []
      );
    });
  }

  private readLikeEvents(dataDir: string): EventEnvelope[] {
    return readJsArray<LikeRecord>(path.join(dataDir, "like.js")).flatMap(
      (record) => {
        const like = record.like;
        const occurredAt = like?.tweetId
          ? twitterSnowflakeDate(like.tweetId)
          : undefined;
        if (!like?.tweetId || !occurredAt) return [];
        return [
          {
            origin_id: `x_like_${like.tweetId}`,
            origin_type: "liked_tweet",
            occurred_at: occurredAt,
            payload_text: like.fullText ?? "",
            source_url: like.expandedUrl,
            title: (like.fullText ?? "").slice(0, 120),
            metadata: {
              platform: "x",
              tweet_id: like.tweetId,
              expanded_url: like.expandedUrl,
              occurred_at_source: "tweet_snowflake_created_at",
            },
          },
        ];
      }
    );
  }

  private readFollowEvents(
    dataDir: string,
    kind: "follower" | "following"
  ): EventEnvelope[] {
    const file = kind === "follower" ? "follower.js" : "following.js";
    return readJsArray<FollowRecord>(path.join(dataDir, file)).flatMap(
      (record) => {
        const item = kind === "follower" ? record.follower : record.following;
        if (!item?.accountId && !item?.userLink) return [];
        const occurredAt = new Date("1970-01-02T00:00:00.000Z");
        const handle = handleFromUserLink(item.userLink);
        return [
          {
            origin_id: stableId(`x_${kind}`, [item.accountId, item.userLink]),
            origin_type: kind,
            occurred_at: occurredAt,
            payload_text:
              kind === "follower"
                ? `Follower: ${handle ?? item.accountId}`
                : `Following: ${handle ?? item.accountId}`,
            source_url: item.userLink,
            metadata: {
              platform: "x",
              account_id: item.accountId,
              user_link: item.userLink,
              handle,
            },
          },
        ];
      }
    );
  }
}

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
