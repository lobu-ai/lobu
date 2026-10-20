import { describe, expect, test } from "bun:test";
import type { ViewAttachment } from "../contracts/tools/manage-views";
import {
  eventAttachmentsFor,
  hasWorkspaceAttachment,
  isEventAttachment,
  matchesCollection,
  matchesRecord,
} from "../contracts/tools/view-attach";

const record = { type: "deal", id: 7 };
const event: ViewAttachment = { event: "deal.won", type: "deal" };

describe("view attachment matching shared by server and web", () => {
  test("a record attachment shows on every record of its type", () => {
    expect(matchesRecord({ record: "deal" }, record)).toBe(true);
    expect(matchesRecord({ record: "company" }, record)).toBe(false);
  });

  test("an id pins it to that one record of the type", () => {
    expect(matchesRecord({ record: "deal", id: 7 }, record)).toBe(true);
    expect(matchesRecord({ record: "deal", id: 8 }, record)).toBe(false);
    expect(matchesRecord({ record: "company", id: 7 }, record)).toBe(false);
  });

  test("collection and record attachments name different pages", () => {
    expect(matchesCollection({ collection: "deal" }, "deal")).toBe(true);
    expect(matchesCollection({ collection: "deal" }, "company")).toBe(false);
    expect(matchesCollection({ record: "deal" }, "deal")).toBe(false);
    expect(matchesRecord({ collection: "deal" }, record)).toBe(false);
  });

  test("event attachments never match type, record or workspace pages", () => {
    expect(isEventAttachment(event)).toBe(true);
    expect(isEventAttachment({ record: "deal" })).toBe(false);
    expect(matchesCollection(event, "deal")).toBe(false);
    expect(matchesRecord(event, record)).toBe(false);
    expect(hasWorkspaceAttachment([event])).toBe(false);
    expect(matchesRecord({ workspace: true }, record)).toBe(false);
  });

  test("recognizes workspace attachments even among other subjects", () => {
    expect(hasWorkspaceAttachment([])).toBe(false);
    expect(
      hasWorkspaceAttachment([{ record: "deal" }, { collection: "deal" }])
    ).toBe(false);
    expect(hasWorkspaceAttachment([event, { workspace: true }])).toBe(true);
  });

  test("filters event candidates by kind", () => {
    const lost: ViewAttachment = { event: "deal.lost", type: "deal" };
    const companyWon: ViewAttachment = { event: "deal.won", type: "company" };
    const attach: ViewAttachment[] = [
      { record: "deal" },
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
