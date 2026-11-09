import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { recordKey } from "../contracts/entity-reference";
import {
  GetEntityAction,
  LinkEntitiesAction,
  ListLinksAction,
} from "../contracts/tools/manage-entity";

describe("entity references", () => {
  it("accepts discovered type IDs without coercing string source keys", () => {
    expect(
      Value.Check(GetEntityAction, {
        action: "get",
        entity_id: "007",
        entity_type: 101,
      })
    ).toBe(true);
    expect(
      Value.Check(LinkEntitiesAction, {
        action: "link",
        from_entity_id: 10,
        to_entity_id: "007",
        to_entity_type: 101,
        relationship_type_slug: "related-to",
      })
    ).toBe(true);
    expect(
      Value.Check(ListLinksAction, {
        action: "list_links",
        entity_id: "007",
        entity_type: 101,
      })
    ).toBe(true);
    for (const type of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        Value.Check(GetEntityAction, {
          action: "get",
          entity_id: "007",
          entity_type: type,
        })
      ).toBe(false);
    }
  });

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
  it("only advertises keys that fit the resolver and relationship storage", () => {
    for (const key of [" ", "007", "é".repeat(512), 0, 42]) {
      expect(recordKey({ key }, "key")).toBe(String(key));
    }
    for (const key of [
      "",
      "a\0b",
      "x".repeat(1025),
      "é".repeat(513),
      NaN,
      Infinity,
    ]) {
      expect(recordKey({ key }, "key")).toBeNull();
    }
  });
});
