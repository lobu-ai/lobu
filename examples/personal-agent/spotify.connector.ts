/**
 * Spotify Connector (example-only — not bundled with Lobu) (V1 runtime)
 *
 * Syncs saved tracks, playlists, recently played, and top tracks from Spotify.
 * Requires OAuth with user-scoped tokens.
 */

import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type HttpClient,
  paginateByCursor,
  paginateByOffset,
  requireBearerClient,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// ---------------------------------------------------------------------------
// Spotify API types
// ---------------------------------------------------------------------------

interface SpotifyArtist {
  id: string;
  name: string;
  external_urls: { spotify: string };
}

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyAlbum {
  id: string;
  name: string;
  images: SpotifyImage[];
  release_date: string;
  external_urls: { spotify: string };
}

interface SpotifyTrack {
  /**
   * Spotify catalog track id. Null for local files and unavailable tracks —
   * use `trackKey()` for a stable per-track identifier, never `track.id`
   * directly in an origin_id (otherwise every local track collides on
   * `..._track_null` and supersedes the others).
   */
  id: string | null;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  duration_ms: number;
  popularity: number;
  explicit: boolean;
  external_urls: { spotify: string };
  uri: string;
  preview_url: string | null;
}

interface SpotifyPagingResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
}

interface SpotifySavedTrack {
  added_at: string;
  track: SpotifyTrack;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  /**
   * Spotify's own content fingerprint — it changes when and only when the
   * playlist's contents change. `syncPlaylists` gates on it, which is why that
   * feed can stamp `occurred_at` with the observation time.
   */
  snapshot_id: string;
  description: string | null;
  public: boolean | null;
  collaborative: boolean;
  owner: { id: string; display_name: string | null };
  tracks: { total: number; href: string };
  images: SpotifyImage[];
  external_urls: { spotify: string };
}

interface SpotifyPlaylistTrackItem {
  added_at: string;
  added_by: { id: string };
  track: SpotifyTrack | null;
}

interface SpotifyRecentlyPlayedItem {
  track: SpotifyTrack;
  played_at: string;
  context: {
    type: string;
    uri: string;
    external_urls: { spotify: string };
  } | null;
}

interface SpotifyRecentlyPlayedResponse {
  items: SpotifyRecentlyPlayedItem[];
  cursors: { after: string; before: string } | null;
  next: string | null;
}

interface SpotifyCheckpoint {
  last_sync_at?: string;
  offset?: number;
  cursor?: string;
  /** Per-playlist content key as of the last sync. See `syncPlaylists`. */
  playlist_snapshots?: Record<string, string>;
  /** Fingerprint of the last emitted top-tracks ranking. See `syncTopTracks`. */
  top_tracks_digest?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function artistNames(artists: SpotifyArtist[]): string {
  return artists.map((a) => a.name).join(", ");
}

/**
 * Stable per-track identifier for origin_ids. Spotify omits `id` for local
 * files and unavailable tracks; falling back to the always-present `uri`
 * (e.g. `spotify:local:...`) keeps each track distinct. Without this, every
 * id-less track collapses onto `..._track_null` and the dedup path supersedes
 * them down to a single surviving row (silent data loss).
 */
export function trackKey(track: { id: string | null; uri: string }): string {
  return track.id ?? track.uri;
}

function albumArt(images: SpotifyImage[]): string | undefined {
  return images[0]?.url;
}

/**
 * Spotify's own ceiling for `/me/top/tracks` is offset 999, and the default
 * stays deliberately shallow: a rank only carries information inside a bounded
 * list. Prod ran the maximum depth and every run rewrote ~1000 rows because one
 * listen shifted every position below it.
 */
export function topTracksLimit(raw: unknown): number {
  const parsed = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 1000);
}

/**
 * Millisecond component for an origin_id. `new Date(bad).getTime()` is NaN, and
 * every NaN entry would then collapse onto a single origin_id — the same
 * collision class `trackKey` guards against. Falls back to the raw string, and
 * is a no-op for well-formed timestamps so existing keys keep their shape.
 */
export function timestampKey(raw: string): string {
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? String(ms) : `raw_${raw}`;
}

/**
 * FNV-1a over the canonical form of a snapshot. Not cryptographic — it only has
 * to answer "did this list change since the last sync", and it is written in
 * plain JS so the connector stays portable across isolate backends (no
 * `node:crypto`, no `crypto.subtle` async).
 */
export function snapshotDigest(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  const canonical = parts.join("\u0000");
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class SpotifyConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "spotify",
    name: "Spotify",
    description:
      "Syncs saved tracks, playlists, recently played, and top tracks from Spotify.",
    version: "1.1.0",
    faviconDomain: "spotify.com",
    authSchema: {
      methods: [
        {
          type: "oauth",
          provider: "spotify",
          authorizationUrl: "https://accounts.spotify.com/authorize",
          tokenUrl: "https://accounts.spotify.com/api/token",
          userinfoUrl: "https://api.spotify.com/v1/me",
          tokenEndpointAuthMethod: "client_secret_basic",
          requiredScopes: [
            "user-read-private",
            "user-read-email",
            "user-library-read",
            "user-top-read",
            "user-read-recently-played",
            "playlist-read-private",
          ],
          loginScopes: ["user-read-private", "user-read-email"],
          clientIdKey: "SPOTIFY_CLIENT_ID",
          clientSecretKey: "SPOTIFY_CLIENT_SECRET",
          loginProvisioning: {
            autoCreateConnection: true,
          },
          setupInstructions:
            "Create a Spotify App at https://developer.spotify.com/dashboard — add {{redirect_uri}} as a Redirect URI, then copy the client ID and secret below.",
        },
      ],
    },
    feeds: {
      saved_tracks: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "saved_tracks",
        name: "Saved Tracks",
        description: "Your liked/saved tracks on Spotify.",
        displayNameTemplate: "Saved Tracks",
        requiredScopes: ["user-library-read"],
        eventKinds: {
          track: {
            description: "A saved Spotify track",
            // No `popularity`: it is Spotify's global chart figure, it drifts
            // daily, and it says nothing about the user's own library. Carrying
            // it made an otherwise unchanged saved track supersede itself on
            // every run (observed in prod: popularity oscillating 21<->22 was
            // the ONLY difference between stored versions).
            metadataSchema: {
              type: "object",
              properties: {
                artist: { type: "string" },
                album: { type: "string" },
                album_art_url: { type: "string", format: "uri" },
                duration_ms: { type: "number" },
                explicit: { type: "boolean" },
                release_date: { type: "string" },
              },
            },
          },
        },
      },
      playlists: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "playlists",
        name: "Playlists",
        description: "Your playlists and their tracks.",
        displayNameTemplate: "Playlists",
        requiredScopes: ["playlist-read-private"],
        eventKinds: {
          playlist: {
            description: "A Spotify playlist",
            metadataSchema: {
              type: "object",
              properties: {
                track_count: { type: "number" },
                public: { type: "boolean" },
                collaborative: { type: "boolean" },
                owner: { type: "string" },
                snapshot_id: { type: "string" },
              },
            },
          },
          playlist_track: {
            description: "A track within a Spotify playlist",
            metadataSchema: {
              type: "object",
              properties: {
                playlist_id: { type: "string" },
                playlist_name: { type: "string" },
                artist: { type: "string" },
                album: { type: "string" },
                added_at: { type: "string" },
                added_by: { type: "string" },
              },
            },
          },
        },
      },
      recently_played: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "recently_played",
        name: "Recently Played",
        description: "Your recently played tracks.",
        displayNameTemplate: "Recently Played",
        requiredScopes: ["user-read-recently-played"],
        eventKinds: {
          play: {
            description: "A recently played track",
            metadataSchema: {
              type: "object",
              properties: {
                artist: { type: "string" },
                album: { type: "string" },
                duration_ms: { type: "number" },
                context_type: { type: "string" },
                context_uri: { type: "string" },
              },
            },
          },
        },
      },
      top_tracks: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "top_tracks",
        name: "Top Tracks",
        description: "Your top tracks by listening frequency.",
        displayNameTemplate: "Top Tracks ({time_range})",
        requiredScopes: ["user-top-read"],
        configSchema: {
          type: "object",
          properties: {
            time_range: {
              type: "string",
              enum: ["short_term", "medium_term", "long_term"],
              default: "medium_term",
              description:
                "Time range: short_term (~4 weeks), medium_term (~6 months), long_term (all time).",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              default: 50,
              description:
                "How deep the ranking goes. A rank is only meaningful inside a bounded list — at depth 1000 a single listen reshuffles hundreds of positions and rewrites the whole feed.",
            },
          },
        },
        eventKinds: {
          top_track: {
            description: "A top track by listening frequency",
            // No `popularity` here either — same volatile global counter as in
            // saved_tracks. `rank` stays because it IS this feed's subject, and
            // the digest gate below keeps a reshuffle from rewriting the list
            // when the ranking has not actually moved.
            metadataSchema: {
              type: "object",
              properties: {
                artist: { type: "string" },
                album: { type: "string" },
                rank: { type: "number" },
                time_range: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  private readonly API_BASE = "https://api.spotify.com/v1";
  private readonly PAGE_SIZE = 50;
  private readonly MAX_PAGES = 20;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const http = requireBearerClient(ctx.credentials, {
      errorPrefix: "Spotify API",
      label: "Spotify",
    });

    switch (ctx.feedKey) {
      case "saved_tracks":
        return this.syncSavedTracks(ctx, http);
      case "playlists":
        return this.syncPlaylists(ctx, http);
      case "recently_played":
        return this.syncRecentlyPlayed(ctx, http);
      case "top_tracks":
        return this.syncTopTracks(ctx, http);
      default:
        throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Feed: saved_tracks
  // -------------------------------------------------------------------------

  private async syncSavedTracks(
    ctx: SyncContext,
    http: HttpClient
  ): Promise<SyncResult> {
    const events: EventEnvelope[] = [];

    const pages = paginateByOffset(
      async (offset) => {
        const data = await http.get<SpotifyPagingResponse<SpotifySavedTrack>>(
          `${this.API_BASE}/me/tracks?limit=${this.PAGE_SIZE}&offset=${offset}`
        );
        return { items: data.items, hasMore: !!data.next };
      },
      { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
    );

    for await (const items of pages) {
      for (const item of items) {
        const track = item.track;
        events.push({
          origin_id: `spotify_track_${trackKey(track)}`,
          title: track.name,
          payload_text: `${track.name} by ${artistNames(track.artists)} — ${track.album.name}`,
          author_name: artistNames(track.artists),
          source_url: track.external_urls.spotify,
          occurred_at: new Date(item.added_at),
          origin_type: "track",
          metadata: {
            artist: artistNames(track.artists),
            album: track.album.name,
            album_art_url: albumArt(track.album.images),
            duration_ms: track.duration_ms,
            explicit: track.explicit,
            release_date: track.album.release_date,
          },
        });
      }

      await ctx.commit(events.splice(0), null);
    }

    await ctx.commit(events, {
      last_sync_at: new Date().toISOString(),
    } satisfies SpotifyCheckpoint as Record<string, unknown>);
    return { status: "complete" };
  }

  // -------------------------------------------------------------------------
  // Feed: playlists
  // -------------------------------------------------------------------------

  private async syncPlaylists(
    ctx: SyncContext,
    http: HttpClient
  ): Promise<SyncResult> {
    const events: EventEnvelope[] = [];
    const previous = (ctx.checkpoint ?? {}) as SpotifyCheckpoint;
    const lastSnapshots = previous.playlist_snapshots ?? {};
    const snapshots: Record<string, string> = {};

    // First, fetch all playlists
    const playlists: SpotifyPlaylist[] = [];
    const playlistPages = paginateByOffset(
      async (offset) => {
        const data = await http.get<SpotifyPagingResponse<SpotifyPlaylist>>(
          `${this.API_BASE}/me/playlists?limit=${this.PAGE_SIZE}&offset=${offset}`
        );
        return { items: data.items, hasMore: !!data.next };
      },
      { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
    );
    for await (const items of playlistPages) {
      playlists.push(...items);
    }

    for (const pl of playlists) {
      // Spotify hands us a content fingerprint for free, but `snapshot_id`
      // versions the TRACK LIST only — renaming a playlist or editing its
      // description or visibility does not bump it, and those fields are the
      // emitted title and payload_text. Fold them in so an edit still re-emits
      // instead of leaving the stored row stale forever.
      const playlistKey = snapshotDigest([
        pl.snapshot_id,
        pl.name,
        pl.description ?? "",
        String(pl.public),
        String(pl.collaborative),
      ]);
      snapshots[pl.id] = playlistKey;

      // Unchanged means nothing to emit AND nothing to fetch — the per-playlist
      // track request below is skipped too. An absent entry is the first run,
      // so no backfill flag is needed.
      if (lastSnapshots[pl.id] === playlistKey) continue;

      const trackEvents: EventEnvelope[] = [];
      const trackPages = paginateByOffset(
        async (offset) => {
          const data = await http.get<
            SpotifyPagingResponse<SpotifyPlaylistTrackItem>
          >(
            `${this.API_BASE}/playlists/${pl.id}/tracks?limit=${this.PAGE_SIZE}&offset=${offset}`
          );
          return { items: data.items, hasMore: !!data.next };
        },
        { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
      );

      for await (const items of trackPages) {
        for (const item of items) {
          if (!item.track) continue;
          const track = item.track;
          const addedAt = new Date(item.added_at);
          trackEvents.push({
            // A playlist ENTRY, not a track: Spotify allows the same track to
            // sit in one playlist several times, each with its own `added_at`.
            // Keying on the track alone collapsed those entries onto one
            // origin_id, so within a single run they superseded each other down
            // to the last one — silent data loss, the same collision class the
            // `trackKey` doc warns about. Mirrors `recently_played`'s key.
            origin_id: `spotify_pl_${pl.id}_track_${trackKey(track)}_${timestampKey(item.added_at)}`,
            title: track.name,
            payload_text: `${track.name} by ${artistNames(track.artists)}`,
            author_name: artistNames(track.artists),
            source_url: track.external_urls.spotify,
            occurred_at: addedAt,
            origin_type: "playlist_track",
            origin_parent_id: `spotify_playlist_${pl.id}`,
            metadata: {
              playlist_id: pl.id,
              playlist_name: pl.name,
              artist: artistNames(track.artists),
              album: track.album.name,
              added_at: item.added_at,
              added_by: item.added_by.id,
            },
          });
        }
      }

      events.push({
        origin_id: `spotify_playlist_${pl.id}`,
        title: pl.name,
        payload_text: pl.description ?? pl.name,
        author_name: pl.owner.display_name ?? pl.owner.id,
        source_url: pl.external_urls.spotify,
        // Observation time, which under the `snapshot_id` gate above is only
        // reached when the playlist actually changed. Ungated this was the
        // single worst source of churn in prod (62x): an untouched playlist got
        // a fresh occurred_at every run and superseded itself forever.
        occurred_at: new Date(),
        origin_type: "playlist",
        metadata: {
          track_count: pl.tracks.total,
          public: pl.public,
          collaborative: pl.collaborative,
          owner: pl.owner.display_name ?? pl.owner.id,
          snapshot_id: pl.snapshot_id,
        },
      });
      events.push(...trackEvents);

      await ctx.commit(events.splice(0), null);
    }

    await ctx.commit(events, {
      last_sync_at: new Date().toISOString(),
      playlist_snapshots: snapshots,
    } satisfies SpotifyCheckpoint as Record<string, unknown>);
    return { status: "complete" };
  }

  // -------------------------------------------------------------------------
  // Feed: recently_played
  // -------------------------------------------------------------------------

  private async syncRecentlyPlayed(
    ctx: SyncContext,
    http: HttpClient
  ): Promise<SyncResult> {
    const events: EventEnvelope[] = [];
    const checkpoint = (ctx.checkpoint ?? {}) as SpotifyCheckpoint;
    let firstUrl = `${this.API_BASE}/me/player/recently-played?limit=${this.PAGE_SIZE}`;

    // Resume from last cursor if available
    if (checkpoint.cursor) {
      firstUrl += `&after=${checkpoint.cursor}`;
    }

    let newCursor: string | undefined;

    // Spotify paginates recently-played via full `next` URLs, so the cursor is the page URL.
    const pages = paginateByCursor<SpotifyRecentlyPlayedItem, string>(
      async (url) => {
        const data = await http.get<SpotifyRecentlyPlayedResponse>(
          url ?? firstUrl
        );
        // Store the latest cursor for next sync
        if (data.cursors?.after) {
          newCursor = data.cursors.after;
        }
        return { items: data.items, nextCursor: data.next };
      },
      { maxPages: this.MAX_PAGES, initialCursor: firstUrl }
    );

    for await (const items of pages) {
      for (const item of items) {
        const track = item.track;
        const playedAt = new Date(item.played_at);
        events.push({
          origin_id: `spotify_play_${trackKey(track)}_${timestampKey(item.played_at)}`,
          title: track.name,
          payload_text: `${track.name} by ${artistNames(track.artists)}`,
          author_name: artistNames(track.artists),
          source_url: track.external_urls.spotify,
          occurred_at: playedAt,
          origin_type: "play",
          metadata: {
            artist: artistNames(track.artists),
            album: track.album.name,
            duration_ms: track.duration_ms,
            context_type: item.context?.type,
            context_uri: item.context?.uri,
          },
        });
      }

      await ctx.commit(events.splice(0), null);
    }

    await ctx.commit(events, {
      last_sync_at: new Date().toISOString(),
      ...(newCursor && { cursor: newCursor }),
    } satisfies SpotifyCheckpoint as Record<string, unknown>);
    return { status: "complete" };
  }

  // -------------------------------------------------------------------------
  // Feed: top_tracks
  // -------------------------------------------------------------------------

  private async syncTopTracks(
    ctx: SyncContext,
    http: HttpClient
  ): Promise<SyncResult> {
    const timeRange = (ctx.config.time_range as string) ?? "medium_term";
    const limit = topTracksLimit(ctx.config.limit);
    const previous = (ctx.checkpoint ?? {}) as SpotifyCheckpoint;
    const events: EventEnvelope[] = [];
    let rank = 1;
    // UTC-midnight bucket so re-syncs within the same day dedup (see occurred_at below).
    const snapshotDay = new Date(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
    );

    const pages = paginateByOffset(
      async (offset) => {
        const pageSize = Math.min(this.PAGE_SIZE, limit - offset);
        const data = await http.get<SpotifyPagingResponse<SpotifyTrack>>(
          `${this.API_BASE}/me/top/tracks?time_range=${timeRange}&limit=${pageSize}&offset=${offset}`
        );
        return {
          items: data.items,
          hasMore: !!data.next && offset + pageSize < limit,
        };
      },
      {
        pageSize: this.PAGE_SIZE,
        maxPages: Math.ceil(limit / this.PAGE_SIZE),
      }
    );

    for await (const items of pages) {
      for (const track of items) {
        if (rank > limit) break;
        events.push({
          origin_id: `spotify_top_${timeRange}_${trackKey(track)}`,
          // The rank lives in metadata, not in the title. Embedding it made the
          // title itself churn on every reshuffle, which rewrites the search
          // index for a track whose name never changed.
          title: track.name,
          payload_text: `${track.name} by ${artistNames(track.artists)} — ${track.album.name}`,
          author_name: artistNames(track.artists),
          source_url: track.external_urls.spotify,
          // Day-bucketed snapshot time. A bare `new Date()` makes every sync
          // look new (occurred_at always differs), so an unchanged top-tracks
          // ranking supersedes itself on each run and the events table grows
          // unbounded with masked rows. Bucketing to UTC midnight lets an
          // identical same-day snapshot dedup while still recording the new
          // ranking whenever it actually shifts.
          occurred_at: snapshotDay,
          origin_type: "top_track",
          metadata: {
            artist: artistNames(track.artists),
            album: track.album.name,
            rank,
            time_range: timeRange,
          },
        });
        rank++;
      }
    }

    // The ranking is a snapshot, so re-emitting an unmoved list buys nothing:
    // each item supersedes its own previous version and mints a fresh row. Gate
    // on a fingerprint of the ranking itself — same digest, emit nothing.
    // Absent digest IS the first run, so no separate backfill flag is needed.
    const digest = snapshotDigest(
      events.map((e, index) => `${index}:${e.origin_id}`)
    );
    if (previous.top_tracks_digest === digest) {
      await ctx.commit([], {
        last_sync_at: new Date().toISOString(),
        top_tracks_digest: digest,
      } satisfies SpotifyCheckpoint as Record<string, unknown>);
      return { status: "complete" };
    }

    await ctx.commit(events, {
      last_sync_at: new Date().toISOString(),
      top_tracks_digest: digest,
    } satisfies SpotifyCheckpoint as Record<string, unknown>);
    return { status: "complete" };
  }
}
