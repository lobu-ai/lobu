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
const COMPILED = `globalThis.VIEW_BUNDLE="pinned";`;

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
    const a = contentHash(SOURCE, meta(), COMPILED);
    const b = contentHash(SOURCE, meta(), COMPILED);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a metadata-only change rehashes (the fixed-source bug)", () => {
    const before = contentHash(SOURCE, meta(), COMPILED);
    const after = contentHash(
      SOURCE,
      meta({ attach: [{ type: "deal", placement: "tab" }] }),
      COMPILED
    );
    expect(after).not.toBe(before);
  });

  test("key order does not rehash (wire order is not content)", () => {
    const a = contentHash(
      SOURCE,
      meta({ params: { x: { type: "string" } } }),
      COMPILED
    );
    const reordered = JSON.parse(
      '{"params":{"x":{"type":"string"}},"name":"pipeline","description":"","attach":[{"type":"deal"}],"actions":{}}'
    ) as ViewContentMetadata;
    expect(contentHash(SOURCE, reordered, COMPILED)).toBe(a);
  });
});

describe("artifact-inclusive identity (PR2 round-1 F1)", () => {
  const COMPILED_A = `globalThis.REVIEW_BUNDLE="A";`;
  const COMPILED_B = `globalThis.REVIEW_BUNDLE="B";`;

  test("a bundle-only change rehashes (the imported-leaf bug)", () => {
    const before = contentHash(SOURCE, meta(), COMPILED_A);
    const after = contentHash(SOURCE, meta(), COMPILED_B);
    expect(after).not.toBe(before);
  });

  test("identical source/metadata/artifact is stable and 16 hex", () => {
    const a = contentHash(SOURCE, meta(), COMPILED_A);
    const b = contentHash(SOURCE, meta(), COMPILED_A);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the same executable bytes converge to one identity (CLI/server parity)", () => {
    // Both sides hash the same artifact bytes through the same function, so
    // a CLI-supplied bundle and a server compilation of the same bytes agree.
    expect(contentHash(SOURCE, meta(), COMPILED_A)).toBe(
      contentHash(SOURCE, meta(), COMPILED_A)
    );
    expect(contentHash(SOURCE, meta(), COMPILED_A)).not.toBe(
      contentHash(SOURCE, meta(), COMPILED_B)
    );
  });
});
