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

  test("scopes a viewer preset to the signed-in user's lowercased email", () => {
    const preset = {
      key: "mine",
      label: "My tasks",
      viewer: { field: "owner_email" },
      selection: {
        filters: [{ field: "state", op: "eq" as const, value: "open" }],
      },
      relativeDate: {
        field: "due_date",
        fromDays: 0,
        toDays: 7,
        timeZone: "UTC",
      },
    };
    expect(
      resolveCollectionPreset(preset, new Date("2026-10-07T12:00:00Z"), {
        email: "Ada.Lovelace@Example.COM",
      })
    ).toEqual({
      filters: [
        { field: "state", op: "eq", value: "open" },
        { field: "owner_email", op: "eq", value: "ada.lovelace@example.com" },
        { field: "due_date", op: "gte", value: "2026-10-07" },
        { field: "due_date", op: "lte", value: "2026-10-14" },
      ],
    });
    // No viewer never widens to every row.
    expect(() => resolveCollectionPreset(preset)).toThrow();
    expect(() =>
      resolveCollectionPreset(preset, new Date(), { email: "" })
    ).toThrow();
  });

  test("counts the viewer filter toward the per-preset filter cap", () => {
    const filters = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        field: `f${index}`,
        op: "eq" as const,
        value: index,
      }));
    const preset = (count: number, relative: boolean) => ({
      presets: [
        {
          key: "mine",
          label: "Mine",
          viewer: { field: "owner_email" },
          selection: { filters: filters(count) },
          ...(relative
            ? {
                relativeDate: {
                  field: "due",
                  fromDays: 0,
                  toDays: 5,
                  timeZone: "UTC",
                },
              }
            : {}),
        },
      ],
    });
    expect(() => parseCollectionPresentation(preset(29, true))).not.toThrow();
    expect(() => parseCollectionPresentation(preset(30, true))).toThrow();
    expect(() => parseCollectionPresentation(preset(31, false))).not.toThrow();
    expect(() => parseCollectionPresentation(preset(32, false))).toThrow();
  });

  test("rejects a malformed viewer", () => {
    const base = { key: "mine", label: "Mine", selection: {} };
    for (const viewer of [
      {},
      { field: "owner;email" },
      { field: "owner_email", op: "neq" },
      [{ field: "owner_email" }],
      "owner_email",
    ])
      expect(() =>
        parseCollectionPresentation({ presets: [{ ...base, viewer }] })
      ).toThrow();
    expect(
      parseCollectionPresentation({
        presets: [{ ...base, viewer: { field: "owner_email" } }],
      }).presets?.[0]?.viewer
    ).toEqual({ field: "owner_email" });
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
