import { describe, expect, test } from "bun:test";
import type { ViewAttachment } from "../contracts/tools/manage-views";
import {
  eventAttachmentsFor,
  hasWorkspaceAttachment,
  isEventAttachment,
  isTabAttachment,
  matchesRecord,
  matchesType,
} from "../contracts/tools/view-attach";

const record = { type: "deal", id: 7, slug: "renewal", parentId: null };
const event: ViewAttachment = { event_kind: "deal.won", type: "deal" };

describe("view attachment matching shared by server and web", () => {
  test("defaults subject placement to tab and keeps overview separate", () => {
    for (const attachment of [
      { type: "deal" },
      { entity: 7 },
      { workspace: true },
    ] satisfies ViewAttachment[]) {
      expect(isTabAttachment(attachment)).toBe(true);
      expect(isTabAttachment({ ...attachment, placement: "overview" })).toBe(
        false
      );
    }
    expect(isTabAttachment(event)).toBe(false);
  });

  test("matches only the requested type and placement", () => {
    expect(matchesType({ type: "deal" }, "deal", "tab")).toBe(true);
    expect(matchesType({ type: "deal" }, "company", "tab")).toBe(false);
    expect(matchesType({ type: "deal" }, "deal", "overview")).toBe(false);
    const overview: ViewAttachment = { type: "deal", placement: "overview" };
    expect(matchesType(overview, "deal", "overview")).toBe(true);
    expect(matchesType(overview, "deal", "tab")).toBe(false);
    expect(matchesType({ entity: 7 }, "deal", "tab")).toBe(false);
    expect(matchesType({ workspace: true }, "deal", "tab")).toBe(false);
  });

  test("matches type attachments on records with the same placement", () => {
    expect(matchesRecord({ type: "deal" }, record, "tab")).toBe(true);
    expect(matchesRecord({ type: "company" }, record, "tab")).toBe(false);
    expect(matchesRecord({ type: "deal" }, record, "overview")).toBe(false);
    const overview: ViewAttachment = { type: "deal", placement: "overview" };
    expect(matchesRecord(overview, record, "overview")).toBe(true);
    expect(matchesRecord(overview, record, "tab")).toBe(false);
  });

  test("pins numeric entity ids regardless of type or nesting", () => {
    expect(matchesRecord({ entity: 7 }, record, "tab")).toBe(true);
    expect(matchesRecord({ entity: 8 }, record, "tab")).toBe(false);
    expect(
      matchesRecord(
        { entity: 7 },
        { ...record, type: "company", parentId: 3 },
        "tab"
      )
    ).toBe(true);
    expect(matchesRecord({ entity: 7 }, record, "overview")).toBe(false);
    expect(
      matchesRecord({ entity: 7, placement: "overview" }, record, "overview")
    ).toBe(true);
  });

  test("pins slugs only on top-level records and never coerces them to ids", () => {
    expect(matchesRecord({ entity: "renewal" }, record, "tab")).toBe(true);
    expect(matchesRecord({ entity: "other" }, record, "tab")).toBe(false);
    expect(
      matchesRecord({ entity: "renewal" }, { ...record, parentId: 3 }, "tab")
    ).toBe(false);
    expect(matchesRecord({ entity: "7" }, record, "tab")).toBe(false);
  });

  test("event attachments never match type, record or workspace pages", () => {
    expect(isEventAttachment(event)).toBe(true);
    expect(isEventAttachment({ type: "deal" })).toBe(false);
    for (const placement of ["tab", "overview"] as const) {
      expect(matchesType(event, "deal", placement)).toBe(false);
      expect(matchesRecord(event, record, placement)).toBe(false);
    }
    expect(hasWorkspaceAttachment([event])).toBe(false);
    expect(matchesRecord({ workspace: true }, record, "tab")).toBe(false);
  });

  test("recognizes workspace attachments even among other subjects", () => {
    expect(hasWorkspaceAttachment([])).toBe(false);
    expect(hasWorkspaceAttachment([{ type: "deal" }, { entity: 7 }])).toBe(
      false
    );
    expect(hasWorkspaceAttachment([event, { workspace: true }])).toBe(true);
  });

  test("filters event candidates by kind without treating type tabs as events", () => {
    const lost: ViewAttachment = { event_kind: "deal.lost", type: "deal" };
    const companyWon: ViewAttachment = {
      event_kind: "deal.won",
      type: "company",
    };
    const attach: ViewAttachment[] = [
      { type: "deal" },
      lost,
      event,
      companyWon,
    ];
    expect(eventAttachmentsFor(attach, "deal.won")).toEqual([
      event,
      companyWon,
    ]);
    expect(eventAttachmentsFor(attach, "unknown")).toEqual([]);
    expect(eventAttachmentsFor(attach)).toEqual([lost, event, companyWon]);
    expect(eventAttachmentsFor([])).toEqual([]);
  });
});
