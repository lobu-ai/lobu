import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  GetEntityAction,
  LinkEntitiesAction,
  ListLinksAction,
} from "../contracts/tools/manage-entity";

describe("entity references", () => {
  it("accepts typed source keys on the existing entity fields", () => {
    expect(
      Value.Check(GetEntityAction, {
        action: "get",
        entity_id: "123",
        entity_type: "catalog-item",
      })
    ).toBe(true);
    expect(
      Value.Check(ListLinksAction, {
        action: "list_links",
        entity_id: "a:b/C",
        entity_type: "catalog-item",
      })
    ).toBe(true);
    expect(
      Value.Check(LinkEntitiesAction, {
        action: "link",
        from_entity_id: "source-a",
        from_entity_type: "catalog-item",
        to_entity_id: "source-b",
        to_entity_type: "catalog-item",
        relationship_type_slug: "related-to",
      })
    ).toBe(true);
  });
  it("preserves numeric callers and rejects fractional ids", () => {
    expect(Value.Check(GetEntityAction, { action: "get", entity_id: 42 })).toBe(
      true
    );
    expect(
      Value.Check(GetEntityAction, { action: "get", entity_id: 4.2 })
    ).toBe(false);
    expect(
      Value.Check(LinkEntitiesAction, {
        action: "link",
        from_entity_id: 4.2,
        to_entity_id: 42,
        relationship_type_slug: "related-to",
      })
    ).toBe(false);
  });
});
