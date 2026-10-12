/**
 * Re-export the reserved-name helpers the server actually uses.
 * Canonical definitions live in `@lobu/core`.
 */
export {
  isReservedConnectorKey,
  isReservedEntityTypeSlug,
  normalizeEntityTypeSlug,
  OWNER_ROUTE_SEGMENTS,
  REMOVED_OWNER_SEGMENTS,
  RESERVED_ENTITY_TYPE_SLUGS,
  RESERVED_PATHS_SET,
} from "@lobu/core";
