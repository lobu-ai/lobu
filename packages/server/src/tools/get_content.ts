/**
 * Tool: read_knowledge
 *
 * List or search content for an entity.
 * Provide `query` parameter to perform semantic/full-text search.
 * Omit `query` to list all content with filters.
 *
 * Implementation lives in ./get_content/ (schema, query, render, handler,
 * automation-mode); this entry re-exports the public surface so existing
 * import paths stay stable.
 */

export { getAccountContent } from './get_content/account';
export { getContent } from './get_content/handler';
export {
  GetContentSchema,
  PublicGetContentSchema,
  getIncludeSupersededValidationErrors,
} from './get_content/schema';
export type { PublicGetContentArgs } from './get_content/schema';
export { GetContentResultSchema } from './get_content/types';
export type { ContentItem } from './get_content/types';
