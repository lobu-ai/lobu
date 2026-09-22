/**
 * The view content hash is the diff/no-write key on BOTH sides (server
 * compile-at-save, CLI diff-before-apply), so it lives here once. These pin
 * the exact semantics the two callers rely on: metadata changes the hash,
 * key order does not, and provenance is not an input.
 */
import { describe, expect, test } from "bun:test";
import {
  contentHash,
  stableStringify,
  type ViewContentMetadata,
} from "../contracts/tools/view-content-hash.js";

const SOURCE = `export default function V() { return null; }\n`;

function meta(
  overrides: Partial<ViewContentMetadata> = {}
): ViewContentMetadata {
  return {
    name: "pipeline",
    description: "",
    attach: [{ type: "deal" }],
    params: {},
    actions: {},
    ...overrides,
  };
}

describe("stableStringify", () => {
  test("sorts object keys and keeps array order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
    expect(stableStringify([2, 1])).toBe("[2,1]");
    expect(stableStringify(undefined)).toBe("null");
  });
});

describe("contentHash", () => {
  test("is 16 hex and stable for identical inputs", () => {
    const a = contentHash(SOURCE, meta());
    const b = contentHash(SOURCE, meta());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a metadata-only change rehashes (the fixed-source bug)", () => {
    const before = contentHash(SOURCE, meta());
    const after = contentHash(
      SOURCE,
      meta({ attach: [{ type: "deal", placement: "tab" }] })
    );
    expect(after).not.toBe(before);
  });

  test("a dependency-only bundle change rehashes", () => {
    const before = contentHash(SOURCE, meta({ compiledCode: "bundle-a" }));
    const after = contentHash(SOURCE, meta({ compiledCode: "bundle-b" }));
    expect(after).not.toBe(before);
  });

  test("key order does not rehash (wire order is not content)", () => {
    const a = contentHash(SOURCE, meta({ params: { x: { type: "string" } } }));
    const reordered = JSON.parse(
      '{"params":{"x":{"type":"string"}},"name":"pipeline","description":"","attach":[{"type":"deal"}],"actions":{}}'
    ) as ViewContentMetadata;
    expect(contentHash(SOURCE, reordered)).toBe(a);
  });
});
