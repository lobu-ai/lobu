/**
 * A reference to a record of a connection-backed (remote) entity type:
 * `<type>:<key>`. The type is an entity-type slug of the caller's own org and
 * never contains `:`; the key is the source's record key and may. This pair is
 * the only way refs are built or read, so every producer (saves, ingest) and
 * consumer (activity, links, the web app) agrees on one spelling.
 *
 * Dependency-free so the web app and connector isolate can bundle it.
 */

export interface EntityRef {
  type: string;
  key: string;
}

/** Longest ref accepted, so a ref stays a pointer and never a payload. */
export const ENTITY_REF_MAX_LENGTH = 1024;

export function formatEntityRef(ref: EntityRef): string {
  if (!ref.type || ref.type.includes(":")) {
    throw new Error(`Entity ref type must be a non-empty slug without ':'`);
  }
  if (!ref.key) throw new Error("Entity ref key must be non-empty");
  return `${ref.type}:${ref.key}`;
}

/**
 * Split on the FIRST `:`. Returns null when either side is empty or the ref is
 * longer than {@link ENTITY_REF_MAX_LENGTH}.
 */
export function parseEntityRef(value: string): EntityRef | null {
  if (typeof value !== "string" || value.length > ENTITY_REF_MAX_LENGTH) {
    return null;
  }
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  return { type: value.slice(0, at), key: value.slice(at + 1) };
}
