import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertDirectory, readJsonFile } from "./takeout-fs.ts";
import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  batchSize,
  decodeHtml,
  type LocalTakeoutConfig,
  maxEventCursor,
  parseCsv,
  parseDate,
  stableId,
  stripHtml,
  takeBatch,
} from "./takeout-utils.ts";

interface GoogleTakeoutCheckpoint {
  last_youtube_timestamp?: string;
  last_keep_timestamp?: string;
  last_maps_timestamp?: string;
}

interface MapsFeature {
  geometry?: { coordinates?: number[] };
  properties?: {
    date?: string;
    google_maps_url?: string;
    five_star_rating_published?: number;
    location?: { address?: string; country_code?: string; name?: string };
    questions?: Array<{
      question?: string;
      rating?: number;
      selected_option?: string;
      selected_options?: string[];
    }>;
    review_text_published?: string;
  };
}

interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: Array<{ text?: string; isChecked?: boolean }>;
  createdTimestampUsec?: number;
  userEditedTimestampUsec?: number;
  isTrashed?: boolean;
  isPinned?: boolean;
  labels?: Array<{ name?: string }>;
}

export default class GoogleTakeoutConnector extends ConnectorRuntime<
  GoogleTakeoutCheckpoint,
  LocalTakeoutConfig
> {
  readonly definition: RuntimeConnectorDefinition<
    GoogleTakeoutCheckpoint,
    LocalTakeoutConfig
  > = {
    key: "google.takeout",
    name: "Google Takeout",
    // Minor bump for the added `maps` feed. Connector source is retained per
    // version, so shipping new semantics under 1.0.0 would overwrite the
    // existing artifact and leave version-pinned runs and rollback pointing at
    // code that no longer matches.
    version: "1.2.0",
    description:
      "Ingests local Google Takeout exports for YouTube history, Keep notes, " +
      "and Maps saved places, lists, and reviews.",
    authSchema: { methods: [{ type: "none" }] },
    // Local-filesystem connector: it reads an absolute path on the user's own
    // machine, so it must not be routed to the cloud fleet. See the longer note
    // on the same two fields in twitter-takeout.connector.ts.
    requiredCapability: "os.files",
    runtime: { platforms: ["macos"] },
    feeds: {
      youtube: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "youtube",
        name: "YouTube Watch History",
        configSchema: localTakeoutSchema("Path to a Google Takeout folder."),
      },
      keep: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "keep",
        name: "Google Keep Notes",
        configSchema: localTakeoutSchema("Path to a Google Takeout folder."),
      },
      maps: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "maps",
        name: "Maps Saved Places and Reviews",
        configSchema: localTakeoutSchema("Path to a Google Takeout folder."),
      },
    },
  };

  private async syncFeed(
    ctx: SyncContext<GoogleTakeoutCheckpoint, LocalTakeoutConfig>
  ): Promise<SyncResult> {
    const takeoutDir = assertDirectory(ctx.config, "Google");
    if (ctx.feedKey === "youtube") {
      const events = takeBatch(
        this.readYoutubeEvents(takeoutDir),
        ctx.checkpoint?.last_youtube_timestamp,
        batchSize(ctx.config)
      );
      await ctx.commit(events, {
        ...ctx.checkpoint,
        last_youtube_timestamp: maxEventCursor(
          events,
          ctx.checkpoint?.last_youtube_timestamp
        ),
      });
      return { status: "complete" };
    }

    if (ctx.feedKey === "keep") {
      const events = takeBatch(
        this.readKeepEvents(takeoutDir),
        ctx.checkpoint?.last_keep_timestamp,
        batchSize(ctx.config)
      );
      await ctx.commit(events, {
        ...ctx.checkpoint,
        last_keep_timestamp: maxEventCursor(
          events,
          ctx.checkpoint?.last_keep_timestamp
        ),
      });
      return { status: "complete" };
    }

    if (ctx.feedKey === "maps") {
      const events = takeBatch(
        this.readMapsEvents(takeoutDir),
        ctx.checkpoint?.last_maps_timestamp,
        batchSize(ctx.config)
      );
      await ctx.commit(events, {
        ...ctx.checkpoint,
        last_maps_timestamp: maxEventCursor(
          events,
          ctx.checkpoint?.last_maps_timestamp
        ),
      });
      return { status: "complete" };
    }

    throw new Error(`Unknown Google Takeout feed: ${ctx.feedKey}`);
  }

  private readYoutubeEvents(takeoutDir: string): EventEnvelope[] {
    const filePath = path.join(
      takeoutDir,
      "YouTube and YouTube Music",
      "history",
      "watch-history.html"
    );
    if (!existsSync(filePath)) return [];
    const html = readFileSync(filePath, "utf8");
    const cells =
      html.match(
        /<div class="outer-cell[\s\S]*?(?=<div class="outer-cell|<\/body>)/g
      ) ?? [];

    return cells.flatMap((cell) => {
      const links = [
        ...cell.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
      ].map((match) => ({
        href: decodeHtml(match[1] ?? ""),
        text: stripHtml(match[2] ?? ""),
      }));
      const title = links[0]?.text;
      if (!title) return [];
      const text = stripHtml(cell);
      const timestampMatch =
        text.match(
          /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2}\s*[AP]M [A-Z]{2,4}/
        ) ??
        text.match(
          /[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}:\d{2}\s*[AP]M [A-Z]{2,4}/
        );
      const occurredAt = timestampMatch
        ? parseGoogleTakeoutTimestamp(timestampMatch[0])
        : undefined;
      if (!occurredAt || Number.isNaN(occurredAt.getTime())) return [];

      const channel = links[1];
      return [
        {
          origin_id: stableId("google_youtube_watch", [
            links[0]?.href,
            occurredAt.toISOString(),
            title,
          ]),
          origin_type: "video_watch",
          occurred_at: occurredAt,
          title,
          source_url: links[0]?.href,
          author_name: channel?.text,
          payload_text: [
            `Watched YouTube video: ${title}`,
            channel?.text ? `Channel: ${channel.text}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            platform: "youtube",
            video_url: links[0]?.href,
            channel_name: channel?.text,
            channel_url: channel?.href,
          },
        },
      ];
    });
  }

  private readKeepEvents(takeoutDir: string): EventEnvelope[] {
    const keepDir = path.join(takeoutDir, "Keep");
    if (!existsSync(keepDir)) return [];
    return readdirSync(keepDir)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        const filePath = path.join(keepDir, file);
        const note = readJsonFile<KeepNote>(filePath);
        if (!note) return [];
        const occurredAt = note.createdTimestampUsec
          ? new Date(Math.floor(note.createdTimestampUsec / 1000))
          : undefined;
        if (!occurredAt || Number.isNaN(occurredAt.getTime())) return [];

        const listText = note.listContent
          ?.map(
            (item) => `- ${item.text ?? ""}${item.isChecked ? " (done)" : ""}`
          )
          .join("\n");
        const payload = [note.title, note.textContent, listText]
          .filter(Boolean)
          .join("\n")
          .trim();
        if (!payload) return [];

        return [
          {
            origin_id: stableId("google_keep_note", [
              file,
              note.createdTimestampUsec,
              note.title,
            ]),
            origin_type: "note",
            occurred_at: occurredAt,
            title: note.title,
            payload_text: payload,
            metadata: {
              platform: "google_keep",
              file,
              is_trashed: note.isTrashed ?? false,
              is_pinned: note.isPinned ?? false,
              labels:
                note.labels?.map((label) => label.name).filter(Boolean) ?? [],
              edited_at: note.userEditedTimestampUsec
                ? new Date(
                    Math.floor(note.userEditedTimestampUsec / 1000)
                  ).toISOString()
                : undefined,
            },
          },
        ];
      });
  }

  private readMapsEvents(takeoutDir: string): EventEnvelope[] {
    return [
      ...this.readMapsPlaceFile(takeoutDir, "Saved Places.json", "saved_place"),
      ...this.readMapsPlaceFile(takeoutDir, "Reviews.json", "place_review"),
      ...this.readMapsListEvents(takeoutDir),
    ];
  }

  private readMapsPlaceFile(
    takeoutDir: string,
    fileName: string,
    originType: "saved_place" | "place_review"
  ): EventEnvelope[] {
    const filePath = path.join(takeoutDir, "Maps (your places)", fileName);
    if (!existsSync(filePath)) return [];
    const parsed = readJsonFile<{ features?: MapsFeature[] }>(filePath);
    const features = parsed?.features;
    if (!Array.isArray(features)) return [];

    return features.flatMap((feature) => {
      const props = feature.properties;
      const name = props?.location?.name?.trim();
      // No name means no usable place — a bare coordinate is not worth an event.
      if (!name) return [];
      const occurredAt = parseDate(props?.date);
      if (!occurredAt) return [];

      const address = props?.location?.address?.trim();
      const mapsUrl = props?.google_maps_url?.trim();
      const rating = props?.five_star_rating_published;
      const reviewText = props?.review_text_published?.trim();
      const answers = (props?.questions ?? []).flatMap((question) => {
        const prompt = question.question?.trim();
        const selectedOptions = question.selected_options
          ?.map((option) => option.trim())
          .filter(Boolean)
          .join(", ");
        const answer =
          question.selected_option?.trim() ||
          selectedOptions ||
          (typeof question.rating === "number" ? `${question.rating}/5` : "");
        return prompt && answer ? [`${prompt}: ${answer}`] : [];
      });
      // Coordinates are GeoJSON order — [longitude, latitude], NOT lat/lng.
      const [longitude, latitude] = feature.geometry?.coordinates ?? [];
      const placeIdentity =
        mapsUrl ??
        (longitude === undefined || latitude === undefined
          ? `${name}\0${address ?? ""}`
          : `${longitude},${latitude}`);

      return [
        {
          origin_id: stableId("google_maps_place", [originType, placeIdentity]),
          origin_type: originType,
          occurred_at: occurredAt,
          title: name,
          payload_text: [
            originType === "place_review"
              ? `Reviewed ${name}${
                  rating === undefined ? "" : ` — ${rating}/5`
                }`
              : `Saved ${name}`,
            reviewText,
            address,
            ...answers,
          ]
            .filter(Boolean)
            .join("\n"),
          source_url: mapsUrl,
          metadata: {
            platform: "google_maps",
            place_name: name,
            address,
            country_code: props?.location?.country_code,
            latitude,
            longitude,
            ...(rating === undefined ? {} : { rating }),
          },
        },
      ];
    });
  }

  private readMapsListEvents(takeoutDir: string): EventEnvelope[] {
    const savedDir = path.join(takeoutDir, "Saved");
    if (!existsSync(savedDir)) return [];

    return readdirSync(savedDir)
      .filter((file) => file.endsWith(".csv"))
      .flatMap((file) => {
        const filePath = path.join(savedDir, file);
        const listName = path.basename(file, ".csv");
        // List rows have no timestamp. The file mtime lets a later export
        // supersede URL-backed rows while still advancing the feed checkpoint.
        const occurredAt = statSync(filePath).mtime;

        return parseCsv(readFileSync(filePath, "utf8")).flatMap((row) => {
          const title = row.Title?.trim();
          if (!title) return [];
          const note = row.Note?.trim();
          const comment = row.Comment?.trim();
          const mapsUrl = row.URL || undefined;

          return [
            {
              origin_id: stableId("google_maps_list_place", [
                listName,
                mapsUrl ?? title,
              ]),
              origin_type: "saved_list_place",
              occurred_at: occurredAt,
              title,
              payload_text: [`${listName}: ${title}`, note, comment]
                .filter(Boolean)
                .join("\n"),
              source_url: mapsUrl,
              metadata: {
                platform: "google_maps",
                place_name: title,
                list: listName,
                note: note || undefined,
                tags: row.Tags || undefined,
              },
            },
          ];
        });
      });
  }
}

const GOOGLE_TZ_OFFSETS: Record<string, string> = {
  UTC: "+0000",
  GMT: "+0000",
  BST: "+0100",
  CET: "+0100",
  CEST: "+0200",
  EET: "+0200",
  EEST: "+0300",
  PST: "-0800",
  PDT: "-0700",
  MST: "-0700",
  MDT: "-0600",
  CST: "-0600",
  CDT: "-0500",
  EST: "-0500",
  EDT: "-0400",
  IST: "+0530",
};

function parseGoogleTakeoutTimestamp(input: string): Date | undefined {
  const normalized = input.replace(" at ", ", ");
  const match = normalized.match(
    /^(.*\d{1,2}:\d{2}:\d{2}\s*[AP]M) ([A-Z]{2,4})$/
  );
  if (!match) return parseDateOrUndefined(normalized);

  const [, datePart, zone] = match;
  const offset = zone ? GOOGLE_TZ_OFFSETS[zone] : undefined;
  return parseDateOrUndefined(offset ? `${datePart} GMT${offset}` : datePart);
}

function parseDateOrUndefined(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
