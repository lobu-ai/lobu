import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ViewAttachmentSchema } from "../contracts/tools/manage-views";

const accepts = (attach: unknown) => Value.Check(ViewAttachmentSchema, attach);

describe("ViewAttachmentSchema", () => {
  it("accepts one page per entry", () => {
    expect(accepts({ record: "deal" })).toBe(true);
    expect(accepts({ record: "deal", id: 7 })).toBe(true);
    expect(accepts({ collection: "deal" })).toBe(true);
    expect(accepts({ collection: "deal", when: { tier: "gold" } })).toBe(true);
    expect(accepts({ workspace: true })).toBe(true);
    expect(accepts({ event: "deal.won" })).toBe(true);
    expect(accepts({ event: "deal.won", type: "deal" })).toBe(true);
  });

  it("rejects an entry naming two pages or a key of another page", () => {
    expect(accepts({ record: "deal", collection: "deal" })).toBe(false);
    expect(accepts({ record: "deal", when: { tier: "gold" } })).toBe(false);
    expect(accepts({ collection: "deal", id: 7 })).toBe(false);
    expect(accepts({ event: "deal.won", record: "deal" })).toBe(false);
    expect(accepts({ workspace: true, record: "deal" })).toBe(false);
  });

  it("rejects the retired type/entity/placement/surface/event_kind shapes", () => {
    expect(accepts({ type: "deal" })).toBe(false);
    expect(accepts({ type: "deal", placement: "tab" })).toBe(false);
    expect(accepts({ type: "deal", surface: "record" })).toBe(false);
    expect(accepts({ entity: 7 })).toBe(false);
    expect(accepts({ record: "deal", placement: "overview" })).toBe(false);
    expect(accepts({ workspace: true, placement: "tab" })).toBe(false);
    expect(accepts({ event_kind: "deal.won" })).toBe(false);
  });

  it("rejects blank or malformed subjects", () => {
    expect(accepts({ record: "" })).toBe(false);
    expect(accepts({ record: "deal", id: 0 })).toBe(false);
    expect(accepts({ event: "" })).toBe(false);
    expect(accepts({ event: "not a kind" })).toBe(false);
    expect(accepts({ workspace: false })).toBe(false);
  });
});
