/**
 * Shared magic-string constants for tool handlers.
 *
 * Centralizes well-known slugs and semantic types that were previously
 * repeated as string literals across tool files.
 */

/** Slug of the built-in workspace-member entity type. */
export const MEMBER_ENTITY_TYPE_SLUG = '$member';

/** Semantic type of tombstone events that supersede "deleted" events. */
export const TOMBSTONE_SEMANTIC_TYPE = 'tombstone';

/** Semantic type of tool-invocation audit events. */
export const AUDIT_SEMANTIC_TYPE = 'audit';
