import { createHash } from "node:crypto";

/**
 * Content identity for Lobu views, shared by the server (compile-at-save)
 * and the CLI (diff-before-apply): ONE function derives the key on both
 * sides, never read off whatever carried it. The hash covers the source plus
 * the declared metadata that affects the stored row (name, description,
 * attach, params, actions). `last_writer` is provenance of the last write,
 * not content: including it would defeat no-op detection, since every apply
 * run mints a new apply_id.
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
  /** Browser bundle bytes. Dependency-only changes must change identity. */
  compiledCode?: string;
}

/**
 * sha256 of the source, browser bundle, and declared metadata, first 16 hex.
 * Same source, bundle, and metadata means the row is current. Including the
 * bundle makes a relative-import-only change observable to diff/apply.
 */
export function contentHash(
  source: string,
  metadata?: ViewContentMetadata
): string {
  return createHash("sha256")
    .update(source)
    .update("\n")
    .update(stableStringify(metadata ?? null))
    .digest("hex")
    .slice(0, 16);
}
