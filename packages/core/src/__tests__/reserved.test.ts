import { describe, expect, it } from "bun:test";
import {
  isReservedEntityTypeSlug,
  isSystemEntityType,
  normalizeEntityTypeSlug,
  RESERVED_ENTITY_TYPE_SLUGS,
  RESERVED_PATHS,
} from "../reserved";

describe("isSystemEntityType", () => {
  it("is solely the $ slug prefix", () => {
    expect(isSystemEntityType({ slug: "$member" })).toBe(true);
    expect(isSystemEntityType({ slug: "$resource" })).toBe(true);
    expect(isSystemEntityType({ slug: "channel" })).toBe(false);
    expect(isSystemEntityType({ slug: "person" })).toBe(false);
    expect(isSystemEntityType({})).toBe(false);
  });
});

describe("isReservedEntityTypeSlug", () => {
  it("blocks $ prefix and reserved names", () => {
    expect(isReservedEntityTypeSlug("$member")).toBe(true);
    expect(isReservedEntityTypeSlug("$resource")).toBe(true);
    expect(isReservedEntityTypeSlug("memory")).toBe(true);
    expect(isReservedEntityTypeSlug("person")).toBe(false);
    expect(isReservedEntityTypeSlug("channel")).toBe(false);
  });

  it("blocks live routes missing from OWNER_ROUTE_SEGMENTS and deleted legacy segments", () => {
    // Live routes absent from OWNER_ROUTE_SEGMENTS. `entity-types` and `chat`
    // have no index route, so an entity type with either slug would still
    // list, but /$owner/entity-types/$slug and /$owner/chat/$agentId outrank
    // the `/$owner/$` splat on every one of its detail pages.
    expect(isReservedEntityTypeSlug("entity-types")).toBe(true);
    expect(isReservedEntityTypeSlug("chat")).toBe(true);
    // /$owner/recent is the dedicated Recent page and IS an index route, so it
    // shadows the list page itself.
    expect(isReservedEntityTypeSlug("recent")).toBe(true);
    // Deleted legacy routes stay reserved via REMOVED_OWNER_SEGMENTS so old
    // bookmarks and chat links can never resolve as an unrelated entity type.
    expect(isReservedEntityTypeSlug("inference-providers")).toBe(true);
    expect(isReservedEntityTypeSlug("environments")).toBe(true);
    expect(isReservedEntityTypeSlug("infrastructure")).toBe(true);
  });

  it("blocks the view path marker, which would turn a type's list page into a view path", () => {
    expect(isReservedEntityTypeSlug("-")).toBe(true);
  });

  it("checks the slug create would STORE, so a spelling that normalizes onto a reserved name is blocked", () => {
    // Create rewrites every character outside [a-z0-9-] to `-`.
    expect(isReservedEntityTypeSlug("!")).toBe(true);
    expect(isReservedEntityTypeSlug("entity_types")).toBe(true);
    expect(isReservedEntityTypeSlug("Data")).toBe(true);
    expect(isReservedEntityTypeSlug("my_type")).toBe(false);
  });
});

describe("normalizeEntityTypeSlug", () => {
  it("matches stored domain slugs without rewriting system slugs", () => {
    expect(normalizeEntityTypeSlug("Stock_Movement")).toBe("stock-movement");
    expect(normalizeEntityTypeSlug("stock--movement!")).toBe(
      "stock--movement-"
    );
    expect(normalizeEntityTypeSlug("$MEMBER")).toBe("$member");
  });
});

describe("lists", () => {
  it("exports path and entity-type reserved sets", () => {
    expect(RESERVED_PATHS).toContain("memory");
    expect(RESERVED_PATHS).toContain("www");
    expect(RESERVED_ENTITY_TYPE_SLUGS).toContain("organization");
  });
});
