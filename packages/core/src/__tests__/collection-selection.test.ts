import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  CollectionSelectionSchema,
  parseCollectionSelection,
  selectionImplies,
} from "../contracts/tools/collection-selection";
import { matchesRecord, matchesType } from "../contracts/tools/view-attach";

describe("shared collection selection", () => {
  test("round trips a combined selection without view presentation params", () => {
    const selection = {
      search: "a quoted ' name",
      filters: [
        { field: "tier", op: "eq", value: "gold" },
        { field: "score", op: "gte", value: 50 },
      ],
    };
    expect(Value.Check(CollectionSelectionSchema, selection)).toBe(true);
    expect(parseCollectionSelection(JSON.stringify(selection))).toEqual(
      selection
    );
    expect(parseCollectionSelection(undefined)).toEqual({});
  });

  test("rejects malformed selection instead of broadening it to all records", () => {
    for (const value of [
      "{bad json",
      { filters: [{ field: "tier", op: "sql", value: "TRUE" }] },
      { filters: [{ field: "tier; DROP TABLE entities", op: "eq", value: 1 }] },
      { filters: [{ field: "tier", op: "eq", value: {} }] },
      { filters: [{ field: "score", op: "gte", value: null }] },
      { search: [], filters: [] },
      {
        filters: Array.from({ length: 33 }, () => ({
          field: "tier",
          op: "eq",
          value: 1,
        })),
      },
    ])
      expect(() => parseCollectionSelection(value)).toThrow();
  });

  test("conditional tabs require a matching equality in the effective selection", () => {
    const selection = {
      filters: [{ field: "tier", op: "eq" as const, value: "gold" }],
    };
    expect(selectionImplies(selection, { tier: "gold" })).toBe(true);
    expect(selectionImplies(selection, { tier: "silver" })).toBe(false);
    expect(selectionImplies({}, { tier: "gold" })).toBe(false);
    expect(
      selectionImplies(
        { filters: [{ field: "score", op: "gte", value: 50 }] },
        { score: 50 }
      )
    ).toBe(false);
  });

  test("collection and record attachments do not leak into each other", () => {
    const record = { type: "account", id: 1, slug: "sample", parentId: null };
    const collection = {
      type: "account",
      surface: "collection" as const,
      when: { tier: "gold" },
    };
    const detail = { type: "account", surface: "record" as const };
    const selection = {
      filters: [{ field: "tier", op: "eq" as const, value: "gold" }],
    };
    expect(matchesType(collection, "account", "tab", selection)).toBe(true);
    expect(matchesType(collection, "account", "tab", {})).toBe(false);
    expect(matchesType(detail, "account", "tab", selection)).toBe(false);
    expect(matchesRecord(collection, record, "tab")).toBe(false);
    expect(matchesRecord(detail, record, "tab")).toBe(true);
    expect(matchesRecord({ type: "account" }, record, "tab")).toBe(true);
  });
});
