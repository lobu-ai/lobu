import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ViewKeySchema, ViewScopeSchema } from "./view-scope";

// ============================================
// Workspace navigation: the sidebar's curated sections.
// ============================================
//
// A workspace-owned, versioned document. It only presents: a section is not a
// permission or an owner, and hiding a destination never authorizes or
// denies it. `null` (never set) means the automatic default — the workspace's
// attached views — and an empty `sections` array means deliberately no custom
// entries. The product shell (Home, Memory, Search, Settings) is never part of
// it, so no configuration can remove it.

/**
 * Resource ceilings, not product limits: a workspace with a thousand views can
 * nest and group them freely. The tree is recursive; these only stop a
 * document from being unbounded.
 */
/** Deepest item nesting: a section's items are level 1. */
export const NAVIGATION_MAX_DEPTH = 32;
export const NAVIGATION_MAX_SECTIONS = 100;
/** Items across every section and level. */
export const NAVIGATION_MAX_ITEMS = 5000;
/** The whole document, serialized as UTF-8 JSON. */
export const NAVIGATION_MAX_BYTES = 1024 * 1024;

const NavigationIdSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$",
  description:
    "Stable id, unique across the whole document (sections and items). It names the menu entry, not its destination: two entries may open the same page.",
});
const NavigationLabelSchema = Type.String({ minLength: 1, maxLength: 80 });
const NavigationIconSchema = Type.String({
  pattern: "^[a-z0-9-]{1,40}$",
  description:
    "A Lucide icon name in kebab-case (https://lucide.dev/icons), e.g. 'building-2'; former Lucide names resolve too. Unknown names render the default icon.",
});
const ScalarParamSchema = Type.Union([
  Type.String({ maxLength: 500 }),
  Type.Number(),
  Type.Boolean(),
]);

export const PageRefSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("view"),
        key: ViewKeySchema,
        scope: Type.Optional(
          Type.Object(ViewScopeSchema.properties, {
            additionalProperties: false,
          })
        ),
        params: Type.Optional(
          Type.Record(Type.String({ maxLength: 64 }), ScalarParamSchema, {
            maxProperties: 20,
            description:
              "Declared view params; validated against the view when resolved.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        kind: Type.Literal("collection"),
        entityType: Type.String({ minLength: 1, maxLength: 120 }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        kind: Type.Literal("record"),
        entityId: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        kind: Type.Literal("link"),
        href: Type.String({
          minLength: 1,
          maxLength: 2048,
          description:
            "Workspace-root-relative path (e.g. 'deal?stage=won', resolved under /<workspace>/) or an absolute https:// URL.",
        }),
      },
      { additionalProperties: false }
    ),
  ],
  {
    description:
      "{ kind: 'view', key, scope?, params? } | { kind: 'collection', entityType } | { kind: 'record', entityId } | { kind: 'link', href }",
  }
);
export type PageRef = Static<typeof PageRefSchema>;

export interface NavigationItem {
  id: string;
  label?: string;
  icon?: string;
  target?: PageRef;
  children?: NavigationItem[];
}

/**
 * One item. `children` holds items of this same shape; the wire schema
 * describes the shape once (no recursive `$ref`, which not every MCP host or
 * JSON-schema tool reads) and `validateNavigationConfig` checks every nested
 * item against it while it walks the tree.
 */
export const NavigationItemSchema = Type.Object(
  {
    id: NavigationIdSchema,
    label: Type.Optional(NavigationLabelSchema),
    icon: Type.Optional(NavigationIconSchema),
    target: Type.Optional(PageRefSchema),
    children: Type.Optional(
      Type.Array(Type.Unknown(), {
        description: "Nested items, each the same shape as this one.",
      })
    ),
  },
  { additionalProperties: false }
);

export const NavigationSectionSchema = Type.Object(
  {
    id: NavigationIdSchema,
    label: Type.Optional(NavigationLabelSchema),
    items: Type.Array(NavigationItemSchema),
  },
  { additionalProperties: false }
);
export interface NavigationSection {
  id: string;
  label?: string;
  items: NavigationItem[];
}

export const NavigationConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sections: Type.Array(NavigationSectionSchema, {
      maxItems: NAVIGATION_MAX_SECTIONS,
    }),
  },
  {
    additionalProperties: false,
    description:
      "{ schemaVersion: 1, sections: [{ id, label?, items: [{ id, label?, icon?, target?, children? }] }] }. An item without a target is a labeled group; with both, the label opens the target and a separate control expands the children.",
  }
);
export interface NavigationConfig {
  schemaVersion: 1;
  sections: NavigationSection[];
}

/** One rendered entry: what the sidebar draws after the server resolved it. */
export interface ResolvedNavigationItem {
  id: string;
  label: string;
  icon?: string;
  /** App path (`/<workspace>/...`, with query) or an external https URL. */
  href?: string;
  external?: boolean;
  children: ResolvedNavigationItem[];
}
export interface ResolvedNavigationSection {
  id: string;
  label?: string;
  items: ResolvedNavigationItem[];
}

// Children are typed opaque on the wire, as on the input side: a recursive
// schema publishes a `$ref` the OpenAPI document never defines.
const ResolvedItemSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  icon: Type.Optional(Type.String()),
  href: Type.Optional(Type.String()),
  external: Type.Optional(Type.Boolean()),
  children: Type.Array(Type.Unknown(), {
    description: "Nested items, each the same shape as this one.",
  }),
});
export const ResolvedNavigationSectionSchema = Type.Object({
  id: Type.String(),
  label: Type.Optional(Type.String()),
  items: Type.Array(ResolvedItemSchema),
});

// ============================================
// Destinations
// ============================================

export type NavigationDestination =
  | { kind: "internal"; path: string }
  | { kind: "external"; href: string };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// C0 controls, DEL and whitespace never belong in an authored path.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const UNSAFE_CHARS = /[\u0000- \u007f\\]/;

/**
 * Where a link may go, decided once for both authored navigation links and a
 * view's `openLink`: an absolute `https:` URL off this origin, or a path inside
 * `/<workspace>/` on it. Everything else is refused — other schemes
 * (`javascript:`, `data:`, `http:`), credentials in the URL, and any path that
 * resolves outside the workspace (another workspace, `/account`, `..`).
 */
export function linkDestination(
  url: string,
  origin: string,
  workspace: string
): NavigationDestination | null {
  let parsed: URL;
  try {
    parsed = new URL(url, `${origin}/${encodeURIComponent(workspace)}/`);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.origin === origin) {
    const root = `/${encodeURIComponent(workspace)}`;
    if (parsed.pathname !== root && !parsed.pathname.startsWith(`${root}/`)) {
      return null;
    }
    return {
      kind: "internal",
      path: parsed.pathname + parsed.search + parsed.hash,
    };
  }
  if (parsed.protocol !== "https:") return null;
  return { kind: "external", href: parsed.href };
}

/**
 * An authored `link` href: an absolute https URL, or a path explicitly relative
 * to the workspace root — no scheme, no leading slash, no `.`/`..` segment (in
 * any encoding), no backslash or control character.
 */
export function navigationHrefDestination(
  href: string,
  origin: string,
  workspace: string
): NavigationDestination | null {
  if (UNSAFE_CHARS.test(href)) return null;
  if (SCHEME.test(href)) {
    const destination = linkDestination(href, origin, workspace);
    return destination?.kind === "external" ? destination : null;
  }
  if (href.startsWith("/")) return null;
  const path = href.split(/[?#]/, 1)[0] ?? "";
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) {
      return null;
    }
  }
  return linkDestination(href, origin, workspace);
}

// ============================================
// Validation
// ============================================

/** Any origin works: validation only asks whether the href can resolve. */
const VALIDATION_ORIGIN = "https://workspace.invalid";

/**
 * The one validator every writer runs (server `set`, CLI apply and pull):
 * schema shape and bounds, then the rules a schema cannot say. Returns every
 * problem as `<path>: <message>`; empty means valid.
 */
export function validateNavigationConfig(config: unknown): string[] {
  const bytes = new TextEncoder().encode(JSON.stringify(config) ?? "").length;
  if (bytes > NAVIGATION_MAX_BYTES) {
    return [
      `navigation: ${bytes} bytes exceed the limit of ${NAVIGATION_MAX_BYTES}`,
    ];
  }
  const schemaErrors = (schema: TSchema, value: unknown, at: string) =>
    [...Value.Errors(schema, value)]
      .slice(0, 10)
      .map((e) => `${at}${e.path.split("/").join(".")}: ${e.message}`);
  if (!Value.Check(NavigationConfigSchema, config)) {
    return schemaErrors(NavigationConfigSchema, config, "navigation");
  }
  const doc = config as NavigationConfig;
  const errors: string[] = [];
  const seen = new Set<string>();
  let items = 0;
  const claim = (id: string, at: string) => {
    if (seen.has(id)) errors.push(`${at}: duplicate id '${id}'`);
    seen.add(id);
  };
  // Iterative, so a deep document cannot exhaust the stack; it stops at the
  // first ceiling it crosses.
  const stack: Array<{ item: unknown; at: string; depth: number }> = [];
  for (let s = doc.sections.length - 1; s >= 0; s -= 1) {
    const section = doc.sections[s];
    if (!section) continue;
    for (let i = section.items.length - 1; i >= 0; i -= 1) {
      stack.push({
        item: section.items[i],
        at: `navigation.sections[${s}].items[${i}]`,
        depth: 1,
      });
    }
  }
  doc.sections.forEach((section, s) => {
    claim(section.id, `navigation.sections[${s}]`);
  });
  while (stack.length > 0 && errors.length < 20) {
    const { item: node, at, depth } = stack.pop() as (typeof stack)[number];
    items += 1;
    if (items > NAVIGATION_MAX_ITEMS) {
      errors.push(
        `navigation: more than ${NAVIGATION_MAX_ITEMS} items exceed the limit`
      );
      break;
    }
    if (depth > NAVIGATION_MAX_DEPTH) {
      errors.push(
        `${at}: nesting deeper than ${NAVIGATION_MAX_DEPTH} levels exceeds the limit`
      );
      break;
    }
    if (!Value.Check(NavigationItemSchema, node)) {
      errors.push(...schemaErrors(NavigationItemSchema, node, at));
      continue;
    }
    const item = node as NavigationItem;
    claim(item.id, at);
    const children = item.children ?? [];
    if (!item.target && children.length === 0) {
      errors.push(`${at}: an item needs a target, children, or both`);
    }
    if (!item.target && !item.label) {
      errors.push(`${at}: a group without a target needs a label`);
    }
    if (item.target?.kind === "link" && !item.label) {
      // A plain link has no resource to name it.
      errors.push(`${at}: a link needs a label`);
    }
    if (
      item.target?.kind === "link" &&
      !navigationHrefDestination(item.target.href, VALIDATION_ORIGIN, "w")
    ) {
      errors.push(
        `${at}.target.href: must be a workspace-relative path without '..' or an https:// URL`
      );
    }
    if (item.target?.kind === "view") {
      const scope = item.target.scope ?? {};
      if (
        scope.event !== undefined &&
        (scope.type !== undefined || scope.entity !== undefined)
      ) {
        errors.push(`${at}.target.scope: event names the subject on its own`);
      }
      if (
        scope.collection !== undefined &&
        (!scope.type || scope.entity !== undefined || scope.event !== undefined)
      ) {
        errors.push(
          `${at}.target.scope: collection needs type without entity or event`
        );
      }
    }
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({
        item: children[i],
        at: `${at}.children[${i}]`,
        depth: depth + 1,
      });
    }
  }
  return errors;
}
