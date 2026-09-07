/**
 * Canonical reserved names and entity-type classification helpers.
 *
 * 1. System types — slug starts with `$` (`$member`, `$resource`, …)
 * 2. Reserved slug lists — illegal *names* for user create / routes
 *
 * Users cannot create `$…` types. Hide + prune use the `$` prefix only.
 */

// ── Entity type classification ──────────────────────────────────────────────

/**
 * True when a type is platform-owned (hidden from rail, never pruned).
 * Sole signal: slug starts with `$`.
 */
export function isSystemEntityType(et: { slug?: string | null }): boolean {
  return typeof et.slug === "string" && et.slug.startsWith("$");
}

// ── Route / path reserved names ─────────────────────────────────────────────

/**
 * Owner-level route segments under /$owner/. Entity type slugs and org slugs
 * must never collide with these.
 */
export const OWNER_ROUTE_SEGMENTS = [
  "activity",
  "agents",
  "connectors",
  "memory",
  "members",
  "settings",
] as const;

/**
 * Legacy page slugs removed from the UI router. Bookmarks and previously sent
 * chat messages can still contain URLs under these segments, so the segments
 * stay reserved: new entity types and orgs cannot claim their names, and the
 * SPA's entity-type/splat guards notFound() them instead of resolving them as
 * entities.
 */
export const REMOVED_OWNER_SEGMENTS = [
  "events",
  "automations",
  "connections",
  "sources",
  // Redirect-only shims deleted 2026-07-28: environments → connectors,
  // infrastructure/models + inference-providers(/new) → provider connector
  // detail. The provider URLs were emitted into chat messages (PRs #1766,
  // #1847), while environments may remain in bookmarks; these old links now
  // land on the router's global not-found page.
  "environments",
  "infrastructure",
  "inference-providers",
  // Removed 2026-07-31 by the connect-surface merge: the devices page folded
  // into /connectors (per-device detail lives at /connectors/device/{id}).
  "devices",
] as const;

/**
 * Reserved owner-slug / path names. Combines owner routes, removed legacy
 * pages, global prefixes, and infra subdomains that must not be claimed as
 * org slugs.
 */
export const RESERVED_PATHS = [
  ...OWNER_ROUTE_SEGMENTS,
  ...REMOVED_OWNER_SEGMENTS,
  "auth",
  "api",
  "inbox",
  "templates",
  "help",
  "account",
  "me",
  "admin",
  "health",
  "login",
  "logout",
  "signup",
  "register",
  "contents",
  "entity-types",
  "www",
  "mcp",
  "static",
  "assets",
  "cdn",
  "docs",
  "mail",
  // Top-level SPA routes that are NOT org namespaces (`packages/owletto/src/app`):
  // path parsing and the server's owner resolution must never read these as an
  // org slug. `connectors` is already reserved above as an owner route.
  "connector",
  "oauth",
  "orgs",
  "slack",
  "dashboard",
] as const;

export const RESERVED_PATHS_SET: ReadonlySet<string> = new Set(RESERVED_PATHS);

// ── Entity type create denylist ─────────────────────────────────────────────

/**
 * Slugs users cannot use when *creating* an entity type. Route collisions plus
 * product words that are not knowledge types. Create-time hygiene only — not
 * hide/prune policy (that is `$` prefix only).
 */
export const RESERVED_ENTITY_TYPE_SLUGS = [
  ...OWNER_ROUTE_SEGMENTS,
  ...REMOVED_OWNER_SEGMENTS,
  // Live /$owner/<segment> routes that are NOT owner-nav segments (so they are
  // absent from OWNER_ROUTE_SEGMENTS). Entity pages render through the
  // `/$owner/$` splat, which a static segment always outranks, so an entity
  // type with one of these slugs is permanently shadowed: `recent` loses its
  // list page to /$owner/recent, while `entity-types` and `chat` have no index
  // route and instead lose every detail page to /$owner/entity-types/$slug and
  // /$owner/chat/$agentId. Create-time hygiene only — deliberately not added to
  // OWNER_ROUTE_SEGMENTS, which also feeds the SPA's entity-splat routing
  // guard and would break any existing entity type already using the slug.
  "entity-types",
  "recent",
  "chat",
  // Product words that are not knowledge types.
  "organization",
  "user",
  "automation",
  "content",
  "source",
  "connector",
] as const;

/**
 * Whether a proposed entity-type slug is illegal for user/API create.
 * `$…` is reserved for platform-named types ($member, $resource).
 */
export function isReservedEntityTypeSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  if (s.startsWith("$")) return true;
  return (RESERVED_ENTITY_TYPE_SLUGS as readonly string[]).includes(s);
}

/**
 * Canonical stored form of an entity-type slug.
 *
 * Entity-type create has always rewritten anything outside `[a-z0-9-]` to `-`,
 * so a `snake_case` key from `lobu.config.ts` is STORED hyphenated. Every other
 * verb must resolve through this same function or it looks up a spelling that
 * was never written: `lobu apply` upserts by probing create and retrying as
 * update on the 409, so a one-sided normalization turned that retry into a 404
 * and halted apply for every snake_case entity key.
 *
 * `$` system slugs (`$member`, `$resource`) are passed through untouched —
 * they are stored WITH the sigil, so canonicalizing them would rewrite
 * `$member` to `-member` and strand every system-type lookup.
 *
 * Deliberately NOT `slugify()` from ./utils/slug — that one also strips
 * diacritics and trims edge hyphens, which would retarget slugs that existing
 * rows are already stored under.
 */
export function normalizeEntityTypeSlug(slug: string): string {
  const lower = slug.toLowerCase();
  return lower.startsWith("$") ? lower : lower.replace(/[^a-z0-9-]/g, "-");
}

// ── Inference-provider connector keys ───────────────────────────────────────

/**
 * Namespace prefix for a model provider's connector key. Provider slugs and
 * connector keys share one list and one detail route, so the prefix keeps a
 * provider named e.g. `slack` from colliding with the real Slack connector.
 * The prefixed key IS the routable connector key: `/$owner/connectors/
 * <prefix><slug>` renders the provider through the shared connector detail
 * page. Lives in core because both sides compose it — the server's URL
 * builders emit these links into chat messages, and the web app parses the
 * prefix back off the route param.
 */
export const INFERENCE_ROW_KEY_PREFIX = "inference-provider:";

/**
 * Namespace prefix for a remote-sandbox *instance* connector key. Sandboxes
 * live in their own table (vault-bound provider credentials) and are
 * synthesized into the connectors list the same way model providers are — a
 * read-layer union, not a data move. The remainder after the prefix is the
 * sandbox id.
 */
export const SANDBOX_ROW_KEY_PREFIX = "sandbox:";

/**
 * Namespace prefix for a sandbox *provider kind* (e.g. vercel). The kind is a
 * catalog entry — pick Vercel, fill its credentials, done. No second
 * "which provider?" step. The remainder is the provider id from the gateway
 * runtime registry (`listGatewayRuntimeProviderIds`).
 */
export const SANDBOX_PROVIDER_KEY_PREFIX = "sandbox-provider:";

/**
 * Path segments under `/connectors/` that are real routes, not connector keys:
 * `/connectors/device/{id}`, `/connectors/client/{id}`, `/connectors/app/{id}`,
 * plus the static `create` flow and `deployments` pages.
 *
 * Model providers and sandboxes are namespaced INTO the `$connectorKey` param
 * with a `prefix:` because they share that one detail route. Devices, clients
 * and first-party apps get their own static segments instead — readable URLs
 * with no percent-encoded colon — which means a connector may not claim these
 * keys: `/connectors/device/42` would resolve to the device route, and the
 * connection page it was meant to open would be unreachable. Enforced at
 * install time by `validateConnectorMetadata`.
 */
export const CONNECTOR_SUBROUTE_SEGMENTS = [
  "device",
  "client",
  "app",
  "create",
  "deployments",
] as const;

/**
 * Whether a connector key would be shadowed by a `/connectors/*` subroute.
 * Compared lowercased: the router matches static segments case-insensitively
 * (no `caseSensitive` option is set), so `Device` is shadowed like `device`.
 */
export function isReservedConnectorKey(key: string): boolean {
  return (CONNECTOR_SUBROUTE_SEGMENTS as readonly string[]).includes(
    key.toLowerCase()
  );
}
