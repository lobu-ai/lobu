import { describe, expect, test } from "bun:test";
import {
  parseCollectionPresentation,
  resolveCollectionPreset,
} from "../contracts/tools/collection-presentation";

describe("collection presentation", () => {
  test("resolves a rolling calendar range into the existing selection contract", () => {
    const preset = {
      key: "upcoming",
      label: "Upcoming",
      selection: {
        filters: [{ field: "state", op: "eq" as const, value: "active" }],
      },
      relativeDate: {
        field: "due_date",
        fromDays: 0,
        toDays: 30,
        timeZone: "America/Los_Angeles",
      },
    };
    expect(
      resolveCollectionPreset(preset, new Date("2026-10-07T01:00:00Z"))
    ).toEqual({
      filters: [
        { field: "state", op: "eq", value: "active" },
        { field: "due_date", op: "gte", value: "2026-10-06" },
        { field: "due_date", op: "lte", value: "2026-11-05" },
      ],
    });
    expect(preset.selection.filters).toHaveLength(1);
  });

  test("rejects unsupported operators and duplicate preset keys", () => {
    expect(() =>
      parseCollectionPresentation({
        presets: [
          {
            key: "a",
            label: "A",
            selection: {
              filters: [{ field: "state", op: "in", value: ["active"] }],
            },
          },
        ],
      })
    ).toThrow();
    expect(() =>
      parseCollectionPresentation({
        presets: [
          { key: "a", label: "A", selection: {} },
          { key: "a", label: "B", selection: {} },
        ],
      })
    ).toThrow();
  });

  test("rejects invalid timezone and reversed ranges", () => {
    const base = { key: "a", label: "A", selection: {} };
    expect(() =>
      parseCollectionPresentation({
        presets: [
          {
            ...base,
            relativeDate: {
              field: "due",
              fromDays: 5,
              toDays: 0,
              timeZone: "UTC",
            },
          },
        ],
      })
    ).toThrow();
    expect(() =>
      parseCollectionPresentation({
        presets: [
          {
            ...base,
            relativeDate: {
              field: "due",
              fromDays: 0,
              toDays: 5,
              timeZone: "Nowhere",
            },
          },
        ],
      })
    ).toThrow();
  });
});
