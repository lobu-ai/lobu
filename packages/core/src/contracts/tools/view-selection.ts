/**
 * How a page's current selection travels in `?view=` and in component values.
 *
 * An authored view is its bare key; a host-owned built-in mode carries a `b:`
 * prefix. `ViewKeySchema` forbids `:` in a key, so the two spaces can never
 * overlap, and the host can add a built-in mode later without capturing a key
 * some organization already authored. The stored key is untouched by this —
 * the key is the identity, and this is only how a selection is written down.
 *
 * Browser-safe: no Node built-ins, no imports. Both the web host and any other
 * link producer format selections here rather than concatenating prefixes.
 */

/** Marks the value as one of the host's own modes, never an authored key. */
export const BUILTIN_SELECTION_PREFIX = "b:";

export type ViewSelection =
  | { kind: "builtin"; name: string }
  | { kind: "view"; key: string };

/** The `?view=` value for a selection. */
export function formatViewSelection(selection: ViewSelection): string {
  return selection.kind === "builtin"
    ? `${BUILTIN_SELECTION_PREFIX}${selection.name}`
    : selection.key;
}

/**
 * Read a `?view=` value. `null` means "nothing selected" — the caller applies
 * the page's own default rather than guessing one here. A bare `b:` names no
 * mode and is treated as nothing selected.
 */
export function parseViewSelection(
  raw: string | null | undefined
): ViewSelection | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.startsWith(BUILTIN_SELECTION_PREFIX)) {
    const name = raw.slice(BUILTIN_SELECTION_PREFIX.length);
    return name === "" ? null : { kind: "builtin", name };
  }
  return { kind: "view", key: raw };
}
