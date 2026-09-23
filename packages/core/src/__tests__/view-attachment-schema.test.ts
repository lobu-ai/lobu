import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ViewAttachmentSchema } from "../contracts/tools/manage-views";

const accepts = (attach: unknown) => Value.Check(ViewAttachmentSchema, attach);

describe("ViewAttachmentSchema", () => {
  it("accepts an event attachment: an event kind plus the linked entity type", () => {
    expect(accepts({ event_kind: "deal.won", type: "deal" })).toBe(true);
  });

  it("rejects an event attachment without its entity type", () => {
    expect(accepts({ event_kind: "deal.won" })).toBe(false);
  });

  it("rejects an event attachment with a placement or another subject", () => {
    // Without the guard these would validate as a type/entity attachment and
    // render as a tab on the type or record page.
    expect(
      accepts({ event_kind: "deal.won", type: "deal", placement: "tab" })
    ).toBe(false);
    expect(
      accepts({ event_kind: "deal.won", type: "deal", placement: "overview" })
    ).toBe(false);
    expect(accepts({ event_kind: "deal.won", type: "deal", entity: 1 })).toBe(
      false
    );
    expect(
      accepts({ event_kind: "deal.won", type: "deal", workspace: true })
    ).toBe(false);
  });

  it("keeps the subject attachments", () => {
    expect(accepts({ type: "deal", placement: "tab" })).toBe(true);
    expect(accepts({ entity: 7, placement: "overview" })).toBe(true);
    expect(accepts({ entity: "acme" })).toBe(true);
    expect(accepts({ workspace: true })).toBe(true);
    expect(accepts({ event_kind: "", type: "deal" })).toBe(false);
  });
});
