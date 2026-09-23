import { runSync } from "./sync-harness";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

let GoogleTakeoutConnector: any;
const fixtureDirs = new Set<string>();

beforeAll(async () => {
  GoogleTakeoutConnector = (await import("../google-takeout.connector"))
    .default;
});

afterEach(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  fixtureDirs.clear();
});

function writeMapsFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "g-takeout-"));
  fixtureDirs.add(dir);
  const places = path.join(dir, "Maps (your places)");
  mkdirSync(places, { recursive: true });
  mkdirSync(path.join(dir, "Saved"), { recursive: true });

  writeFileSync(
    path.join(places, "Saved Places.json"),
    JSON.stringify({
      features: [
        {
          geometry: { coordinates: [-0.1178191, 51.5483613] },
          properties: {
            date: "2026-03-18T17:11:43Z",
            google_maps_url: "http://maps.google.com/?cid=8204920803681670701",
            location: {
              address: "472 Caledonian Rd, London N7 8TB, United Kingdom",
              country_code: "GB",
              name: "Veli's Grooming",
            },
          },
        },
        {
          geometry: { coordinates: [0, 0] },
          properties: { date: "2026-03-31T01:34:50Z", location: {} },
        },
      ],
    })
  );

  writeFileSync(
    path.join(places, "Reviews.json"),
    JSON.stringify({
      features: [
        {
          geometry: { coordinates: [-0.1268417, 51.5285672] },
          properties: {
            date: "2026-05-25T17:36:07.216676Z",
            five_star_rating_published: 1,
            google_maps_url: "https://www.google.com/maps/place//data=!4m2",
            location: {
              address: "88 Euston Rd., London NW1 2RA, United Kingdom",
              country_code: "GB",
              name: "Premier Inn London St Pancras hotel",
            },
            review_text_published: "The room was not clean.",
            questions: [
              { question: "Trip type", selected_option: "Vacation" },
              {
                question: "Highlights",
                selected_options: ["Central", "Quiet"],
              },
              { question: "Rooms", rating: 2 },
            ],
          },
        },
      ],
    })
  );

  const listPath = path.join(dir, "Saved", "Favorite places.csv");
  writeFileSync(
    listPath,
    "Title,Note,URL,Tags,Comment\n" +
      '"Core by Clare Smyth",,https://www.google.com/maps/place/Core,,\n' +
      ",Missing title,https://www.google.com/maps/place/Unknown,,\n"
  );
  // Pin the mtime so the date assertion is deterministic.
  const when = new Date("2024-02-03T04:05:06Z");
  utimesSync(listPath, when, when);
  return dir;
}

function readMaps(dir: string): any[] {
  return (new GoogleTakeoutConnector() as any).readMapsEvents(dir);
}

describe("Maps feed is declared and routed", () => {
  test("the connector exposes a maps feed", () => {
    const def = new GoogleTakeoutConnector().definition;
    expect(def.feeds.maps).toBeDefined();
    expect(def.feeds.maps.key).toBe("maps");
  });

  test("maps sync batches events and advances its own checkpoint", async () => {
    const connector = new GoogleTakeoutConnector();
    const config = { takeout_dir: writeMapsFixture(), batch_size: 2 };

    const first = await runSync(connector, { feedKey: "maps", config });
    expect(first.events).toHaveLength(2);
    expect(typeof first.checkpoint.last_maps_timestamp).toBe("string");

    const second = await runSync(connector, {
      feedKey: "maps",
      config,
      checkpoint: first.checkpoint,
    });
    expect(second.events).toHaveLength(1);

    const exhausted = await runSync(connector, {
      feedKey: "maps",
      config,
      checkpoint: second.checkpoint,
    });
    expect(exhausted.events).toHaveLength(0);
    expect(exhausted.checkpoint).toEqual(second.checkpoint);
  });
});

describe("saved places", () => {
  test("coordinates are read as [longitude, latitude], not positionally", () => {
    const saved = readMaps(writeMapsFixture()).find(
      (e) => e.origin_type === "saved_place"
    );
    expect(saved.metadata.latitude).toBe(51.5483613);
    expect(saved.metadata.longitude).toBe(-0.1178191);
  });

  test("a place carries name, address and its own save date", () => {
    const saved = readMaps(writeMapsFixture()).find(
      (e) => e.origin_type === "saved_place"
    );
    expect(saved.title).toBe("Veli's Grooming");
    expect(saved.metadata.address).toContain("Caledonian Rd");
    expect(saved.metadata.country_code).toBe("GB");
    expect(saved.occurred_at.toISOString()).toBe("2026-03-18T17:11:43.000Z");
    expect(saved.source_url).toContain("cid=8204920803681670701");
  });

  test("a feature with no place name emits nothing", () => {
    const events = readMaps(writeMapsFixture());
    expect(events.filter((e) => e.origin_type === "saved_place")).toHaveLength(
      1
    );
    expect(events.every((e) => e.title)).toBe(true);
  });
});

describe("reviews", () => {
  test("a review keeps its rating and answered prompts", () => {
    const review = readMaps(writeMapsFixture()).find(
      (e) => e.origin_type === "place_review"
    );
    expect(review.metadata.rating).toBe(1);
    expect(review.payload_text).toContain("— 1/5");
    expect(review.payload_text).toContain("The room was not clean.");
    expect(review.payload_text).toContain("Trip type: Vacation");
    expect(review.payload_text).toContain("Highlights: Central, Quiet");
    expect(review.payload_text).toContain("Rooms: 2/5");
  });

  test("a review is a different origin_type from a saved place", () => {
    const events = readMaps(writeMapsFixture());
    const kinds = new Set(events.map((e) => e.origin_type));
    expect(kinds.has("saved_place")).toBe(true);
    expect(kinds.has("place_review")).toBe(true);
  });
});

describe("saved lists", () => {
  test("the list name comes from the filename and rides on the event", () => {
    const row = readMaps(writeMapsFixture()).find(
      (e) => e.origin_type === "saved_list_place"
    );
    expect(row.metadata.list).toBe("Favorite places");
    expect(row.title).toBe("Core by Clare Smyth");
    expect(row.payload_text).toContain("Favorite places: Core by Clare Smyth");
  });

  test("a dateless CSV row takes the file mtime, not a fixed sentinel", () => {
    const row = readMaps(writeMapsFixture()).find(
      (e) => e.origin_type === "saved_list_place"
    );
    expect(row.occurred_at.toISOString()).toBe("2024-02-03T04:05:06.000Z");
  });

  test("a row without a title is dropped", () => {
    const rows = readMaps(writeMapsFixture()).filter(
      (e) => e.origin_type === "saved_list_place"
    );
    expect(rows).toHaveLength(1);
  });
});

describe("identity", () => {
  test("every event has a distinct, stable origin_id", () => {
    const dir = writeMapsFixture();
    const first = readMaps(dir);
    const second = readMaps(dir);
    const ids = first.map((e) => e.origin_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.map((e) => e.origin_id)).toEqual(ids);
  });

  test("a display-name edit keeps the URL-backed place identity", () => {
    const dir = writeMapsFixture();
    const before = readMaps(dir);
    const savedBefore = before.find((e) => e.origin_type === "saved_place");
    const listBefore = before.find((e) => e.origin_type === "saved_list_place");

    const savedPath = path.join(dir, "Maps (your places)", "Saved Places.json");
    const savedJson = JSON.parse(readFileSync(savedPath, "utf8"));
    savedJson.features[0].properties.location.name = "Renamed saved place";
    writeFileSync(savedPath, JSON.stringify(savedJson));

    const listPath = path.join(dir, "Saved", "Favorite places.csv");
    writeFileSync(
      listPath,
      "Title,Note,URL,Tags,Comment\n" +
        '"Renamed list place",,https://www.google.com/maps/place/Core,,\n'
    );

    const after = readMaps(dir);
    expect(after.find((e) => e.origin_type === "saved_place").origin_id).toBe(
      savedBefore.origin_id
    );
    expect(
      after.find((e) => e.origin_type === "saved_list_place").origin_id
    ).toBe(listBefore.origin_id);
  });
});
