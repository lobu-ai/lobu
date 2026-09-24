import { createHash } from "node:crypto";
import type { RetainedSource } from "./source-files";

/**
 * Content identity for Lobu views, shared by the server (compile-at-save)
 * and the CLI (diff-before-apply): ONE function derives the key on both
 * sides, never read off whatever carried it. The hash covers the source, the
 * declared metadata that affects the stored row (name, description, attach,
 * params, actions), the retained files and dependencies when present, AND
 * the digest of the executable browser bundle. The
 * bundle matters because the CLI resolves relative imports and view npm deps
 * where node_modules exists: two different executable artifacts built from
 * the same entry source must never compare identical. `last_writer` is
 * provenance of the last write, not content: including it would defeat no-op
 * detection, since every apply run mints a new apply_id.
 *
 * Canonicalization: `source` verbatim; metadata via `stableStringify`
 * (object keys sorted, arrays in order); the artifact as the full hex
 * sha256 of its UTF-8 bytes. Same bytes on either path (a CLI-supplied
 * `compiled_code` or a server-side compilation) converge on the same
 * identity; byte-identical source/metadata/artifact and retained source stays a no-op.
 */

/** Deterministic JSON for hashing: object keys sorted, arrays kept in order. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Declared metadata that affects the stored view (everything but provenance). */
export interface ViewContentMetadata {
  name: string;
  description: string;
  attach: unknown;
  params: unknown;
  actions: unknown;
}

/**
 * sha256 of the source plus the declared metadata plus the compiled
 * artifact's digest and retained files/dependencies, first 16 hex. Identical
 * source, metadata, bundle and retained source means nothing is written.
 */
export function contentHash(
  source: string,
  metadata: ViewContentMetadata,
  compiledCode: string,
  retainedSource?: RetainedSource
): string {
  const artifactDigest = createHash("sha256")
    .update(compiledCode, "utf8")
    .digest("hex");
  const hash = createHash("sha256")
    .update(source)
    .update("\n")
    .update(stableStringify(metadata ?? null))
    .update("\n")
    .update(artifactDigest);
  if (retainedSource) hash.update("\n").update(stableStringify(retainedSource));
  return hash.digest("hex").slice(0, 16);
}
