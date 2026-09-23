import { runSync } from "./sync-harness";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk so the connector imports without the browser stack.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let trackKey: any;

beforeAll(async () => {
  const mod = await import("../spotify.connector");
  trackKey = mod.trackKey;
});

describe("trackKey", () => {
  test("uses the catalog id when present", () => {
    expect(
      trackKey({
        id: "6rguovIe3aoqPhdpiDVOae",
        uri: "spotify:track:6rguovIe3aoqPhdpiDVOae",
      })
    ).toBe("6rguovIe3aoqPhdpiDVOae");
  });

  // Regression: local files / unavailable tracks have id === null. Keying the
  // origin_id on `track.id` directly produced `..._track_null` for ALL of them,
  // so they collided and the dedup path superseded distinct tracks down to one
  // surviving row (observed in prod: 50 distinct local tracks → 6 current rows).
  test("falls back to the uri when id is null so distinct local tracks stay distinct", () => {
    const a = trackKey({
      id: null,
      uri: "spotify:local:Artist+A:Album:Track+A:200",
    });
    const b = trackKey({
      id: null,
      uri: "spotify:local:Artist+B:Album:Track+B:240",
    });

    expect(a).toBe("spotify:local:Artist+A:Album:Track+A:200");
    expect(b).toBe("spotify:local:Artist+B:Album:Track+B:240");
    expect(a).not.toBe(b);
    // Neither collapses onto the old `null` collision key.
    expect(a).not.toBe("null");
    expect(b).not.toBe("null");
  });
});

// ---------------------------------------------------------------------------
// Snapshot-churn regressions
//
// Three of the four Spotify feeds read a SNAPSHOT (your library, your
// playlists, your ranking) and emit it as per-item events. Every one of them
// was rewriting rows that had not changed. Measured on prod events, versions
// per distinct origin_id:
//
//   playlists / playlist rows   62.3x   occurred_at: new Date() every run
//   top_tracks                  18.6x   rank shifts + popularity drift
//   playlists / playlist_track   5.1x   duplicate entries colliding in-run
//   saved_tracks                 1.8x   popularity drift alone
//   recently_played              1.0x   a real event stream — the control
//
// These guards are written against the CLASS (no volatile provider counters in
// emitted content; an unchanged snapshot emits nothing) rather than against the
// individual field that happened to churn.
// ---------------------------------------------------------------------------

let snapshotDigest: any;
let timestampKey: any;
let topTracksLimit: any;
let SpotifyConnector: any;

beforeAll(async () => {
  const mod = await import("../spotify.connector");
  snapshotDigest = mod.snapshotDigest;
  timestampKey = mod.timestampKey;
  topTracksLimit = mod.topTracksLimit;
  SpotifyConnector = mod.default;
});

function fakeTrack(id: string, name = `track ${id}`) {
  return {
    id,
    name,
    artists: [{ id: "a1", name: "Artist", external_urls: { spotify: "u" } }],
    album: {
      id: "al1",
      name: "Album",
      images: [{ url: "img", height: 1, width: 1 }],
      release_date: "2020-01-01",
      external_urls: { spotify: "u" },
    },
    duration_ms: 1000,
    // Spotify's global chart figure. It drifts daily and must never reach an
    // emitted event — that drift alone superseded unchanged rows in prod.
    popularity: 42,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    uri: `spotify:track:${id}`,
    preview_url: null,
  };
}

/** Routes by longest-matching path fragment and records every URL requested. */
function fakeSpotifyApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return {
    calls,
    get: async (url: string) => {
      calls.push(url);
      const key = keys.find((k) => url.includes(k));
      if (!key) throw new Error(`unrouted request: ${url}`);
      return routes[key];
    },
  };
}

function playlistPage(snapshotId: string) {
  return {
    items: [
      {
        id: "PL1",
        name: "hiphop",
        description: null,
        public: true,
        collaborative: false,
        snapshot_id: snapshotId,
        owner: { id: "me", display_name: "Me" },
        tracks: { total: 2, href: "h" },
        images: [],
        external_urls: { spotify: "https://open.spotify.com/playlist/PL1" },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    next: null,
    previous: null,
  };
}

function syncCtx(
  feedKey: string,
  http: unknown,
  extra: Record<string, unknown> = {}
) {
  // The SDK mock hands `credentials` back as the bearer client.
  return { feedKey, credentials: http, config: {}, checkpoint: null, ...extra };
}

describe("topTracksLimit", () => {
  test("defaults to a bounded ranking and clamps junk", () => {
    expect(topTracksLimit(undefined)).toBe(50);
    expect(topTracksLimit(0)).toBe(50);
    expect(topTracksLimit("100")).toBe(50);
    expect(topTracksLimit(10)).toBe(10);
    expect(topTracksLimit(99999)).toBe(1000);
  });
});

describe("snapshotDigest", () => {
  test("is stable for the same list and moves when the order does", () => {
    expect(snapshotDigest(["a", "b"])).toBe(snapshotDigest(["a", "b"]));
    expect(snapshotDigest(["a", "b"])).not.toBe(snapshotDigest(["b", "a"]));
    // Joining must not let ["ab"] and ["a","b"] collide.
    expect(snapshotDigest(["ab"])).not.toBe(snapshotDigest(["a", "b"]));
  });
});

describe("playlists snapshot gate", () => {
  const tracksPage = {
    items: [
      {
        added_at: "2025-06-22T17:27:32Z",
        added_by: { id: "me" },
        track: fakeTrack("t1"),
      },
      {
        added_at: "2025-07-03T17:27:13Z",
        added_by: { id: "me" },
        track: fakeTrack("t1"),
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
    next: null,
    previous: null,
  };

  test("an unchanged snapshot_id emits nothing and skips the track fetch", async () => {
    const http = fakeSpotifyApi({
      "/me/playlists": playlistPage("snap-1"),
      "/playlists/PL1/tracks": tracksPage,
    });
    const connector = new SpotifyConnector();

    const first = await runSync(connector, syncCtx("playlists", http));
    expect(first.events.length).toBeGreaterThan(0);
    // The stored key is a composite (snapshot_id + the fields snapshot_id does
    // not version), so assert it round-trips rather than pinning its value.
    expect(Object.keys(first.checkpoint.playlist_snapshots)).toEqual(["PL1"]);
    expect(http.calls.some((u: string) => u.includes("/tracks"))).toBe(true);

    http.calls.length = 0;
    const second = await runSync(
      connector,
      syncCtx("playlists", http, { checkpoint: first.checkpoint })
    );

    // The whole point: an untouched playlist produces no rows at all, and we
    // never even ask Spotify for its tracks.
    expect(second.events).toEqual([]);
    expect(http.calls.some((u: string) => u.includes("/tracks"))).toBe(false);
    expect(second.checkpoint.playlist_snapshots).toEqual(
      first.checkpoint.playlist_snapshots
    );
  });

  test("a changed snapshot_id re-emits that playlist", async () => {
    const http = fakeSpotifyApi({
      "/me/playlists": playlistPage("snap-2"),
      "/playlists/PL1/tracks": tracksPage,
    });
    const connector = new SpotifyConnector();

    const result = await runSync(
      connector,
      syncCtx("playlists", http, {
        checkpoint: { playlist_snapshots: { PL1: "snap-1" } },
      })
    );

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.checkpoint.playlist_snapshots.PL1).not.toBe("snap-1");
  });

  // Regression: the same track can sit in a playlist several times, each entry
  // with its own added_at. Keying the origin_id on the track alone collapsed
  // them, so inside ONE run they superseded each other down to the last entry
  // (prod: 4 versions of "Stillness" written 8 seconds apart, 3 destroyed).
  test("duplicate entries of one track stay distinct rows", async () => {
    const http = fakeSpotifyApi({
      "/me/playlists": playlistPage("snap-1"),
      "/playlists/PL1/tracks": tracksPage,
    });
    const connector = new SpotifyConnector();

    const result = await runSync(connector, syncCtx("playlists", http));
    const trackIds = result.events
      .filter((e: any) => e.origin_type === "playlist_track")
      .map((e: any) => e.origin_id);

    expect(trackIds).toHaveLength(2);
    expect(new Set(trackIds).size).toBe(2);
  });
});

describe("top_tracks", () => {
  function topPage(ids: string[]) {
    return {
      items: ids.map((id) => fakeTrack(id)),
      total: ids.length,
      limit: 50,
      offset: 0,
      next: null,
      previous: null,
    };
  }

  test("an unchanged ranking emits nothing on the next sync", async () => {
    const http = fakeSpotifyApi({
      "/me/top/tracks": topPage(["t1", "t2", "t3"]),
    });
    const connector = new SpotifyConnector();

    const first = await runSync(connector, syncCtx("top_tracks", http));
    expect(first.events).toHaveLength(3);
    expect(first.checkpoint.top_tracks_digest).toBeTruthy();

    const second = await runSync(
      connector,
      syncCtx("top_tracks", http, { checkpoint: first.checkpoint })
    );
    expect(second.events).toEqual([]);
    expect(second.checkpoint.top_tracks_digest).toBe(
      first.checkpoint.top_tracks_digest
    );
  });

  test("a reshuffled ranking does emit", async () => {
    const connector = new SpotifyConnector();
    const before = await runSync(
      connector,
      syncCtx(
        "top_tracks",
        fakeSpotifyApi({ "/me/top/tracks": topPage(["t1", "t2"]) })
      )
    );
    const after = await runSync(
      connector,
      syncCtx(
        "top_tracks",
        fakeSpotifyApi({ "/me/top/tracks": topPage(["t2", "t1"]) }),
        {
          checkpoint: before.checkpoint,
        }
      )
    );
    expect(after.events).toHaveLength(2);
  });

  test("the configured limit bounds how deep the ranking goes", async () => {
    const http = fakeSpotifyApi({
      "/me/top/tracks": topPage(["t1", "t2", "t3", "t4", "t5"]),
    });
    const connector = new SpotifyConnector();

    const result = await runSync(
      connector,
      syncCtx("top_tracks", http, { config: { limit: 2 } })
    );

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e: any) => e.metadata.rank)).toEqual([1, 2]);
    expect(http.calls[0]).toContain("limit=2");
  });

  // The rank belongs in metadata. Embedding it in the title made the title
  // churn on every reshuffle and rewrote the search index for a track whose
  // name never changed.
  test("the title is the track name, not the ranking", async () => {
    const http = fakeSpotifyApi({ "/me/top/tracks": topPage(["t1"]) });
    const connector = new SpotifyConnector();
    const result = await runSync(connector, syncCtx("top_tracks", http));

    expect(result.events[0].title).toBe("track t1");
    expect(result.events[0].metadata.rank).toBe(1);
  });
});

// Class-wide guard rather than a per-field one: no snapshot feed may carry a
// volatile provider counter into emitted content, whichever field it is.
describe("no snapshot feed emits a volatile provider counter", () => {
  const VOLATILE = ["popularity"];

  test.each([
    [
      "saved_tracks",
      {
        "/me/tracks": {
          items: [{ added_at: "2025-01-09T18:21:15Z", track: fakeTrack("t1") }],
          total: 1,
          limit: 50,
          offset: 0,
          next: null,
          previous: null,
        },
      },
    ],
    [
      "top_tracks",
      {
        "/me/top/tracks": {
          items: [fakeTrack("t1")],
          total: 1,
          limit: 50,
          offset: 0,
          next: null,
          previous: null,
        },
      },
    ],
  ])("%s", async (feedKey, routes) => {
    const connector = new SpotifyConnector();
    const result = await runSync(
      connector,
      syncCtx(
        feedKey as string,
        fakeSpotifyApi(routes as Record<string, unknown>)
      )
    );

    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) {
      for (const field of VOLATILE) {
        expect(Object.keys(event.metadata ?? {})).not.toContain(field);
      }
    }
  });
});

describe("timestampKey", () => {
  test("is a no-op for well-formed timestamps so existing keys keep their shape", () => {
    expect(timestampKey("2025-06-22T17:27:32Z")).toBe(
      String(new Date("2025-06-22T17:27:32Z").getTime())
    );
  });

  // Without this, every entry with an unparseable timestamp keys on "NaN" and
  // they collapse onto one origin_id — the collision this PR exists to fix.
  test("malformed timestamps stay distinct instead of collapsing onto NaN", () => {
    const a = timestampKey("not-a-date");
    const b = timestampKey("also-not-a-date");
    expect(a).not.toBe(b);
    expect(a).not.toContain("NaN");
    expect(b).not.toContain("NaN");
  });
});

// Spotify bumps `snapshot_id` for track-list edits only. A rename or a
// description edit leaves it untouched, so gating on it alone left the stored
// title and payload_text stale forever.
describe("playlists gate covers edits snapshot_id does not version", () => {
  const tracksPage = {
    items: [
      {
        added_at: "2025-06-22T17:27:32Z",
        added_by: { id: "me" },
        track: fakeTrack("t1"),
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    next: null,
    previous: null,
  };

  async function syncWith(page: any, checkpoint: unknown) {
    const http = fakeSpotifyApi({
      "/me/playlists": page,
      "/playlists/PL1/tracks": tracksPage,
    });
    const connector = new SpotifyConnector();
    return runSync(connector, syncCtx("playlists", http, { checkpoint }));
  }

  test("a rename re-emits even though snapshot_id is unchanged", async () => {
    const first = await syncWith(playlistPage("snap-1"), null);

    const renamed = playlistPage("snap-1");
    (renamed.items[0] as any).name = "hiphop (2026)";
    const second = await syncWith(renamed, first.checkpoint);

    const emitted = second.events.filter(
      (e: any) => e.origin_type === "playlist"
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].title).toBe("hiphop (2026)");
  });

  test("a description edit re-emits too", async () => {
    const first = await syncWith(playlistPage("snap-1"), null);

    const edited = playlistPage("snap-1");
    (edited.items[0] as any).description = "now with a description";
    const second = await syncWith(edited, first.checkpoint);

    expect(
      second.events.filter((e: any) => e.origin_type === "playlist")
    ).toHaveLength(1);
  });

  test("no edit at all still emits nothing", async () => {
    const first = await syncWith(playlistPage("snap-1"), null);
    const second = await syncWith(playlistPage("snap-1"), first.checkpoint);
    expect(second.events).toEqual([]);
  });
});
