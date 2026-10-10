/**
 * Content Search Utilities
 *
 * Hybrid search: combines PostgreSQL ILIKE text matching with pgvector
 * cosine-distance semantic search when the embeddings service is available.
 * Falls back to ILIKE-only when embeddings cannot be generated.
 *
 * This file re-exports from the content-search/ submodules; all public
 * identifiers remain at the same import path.
 */

export type { EntityIdentityScope } from './content-search/entity-link';
export {
  buildEntityLinkBranches,
  buildEntityLinkUnion,
  entityLinkMatchSql,
  fetchEntityIdentityScopes,
  STANDARD_IDENTITY_NAMESPACES,
} from './content-search/entity-link';

export { buildConnectionVisibilityClause, buildOrgScopeWhere } from './content-search/visibility';

export { buildFutureOccurredAtClause } from './content-search/types';

import { getDb } from '../db/client';
import type { Env } from '../index';
import { listContentInternal } from './content-search/list-path';
import { searchContentBySingleQuery } from './content-search/search-path';
import type { ContentSearchOptions, ContentSearchResponse } from './content-search/types';

export async function searchContentByText(
  queryText: string | null,
  options: ContentSearchOptions & { offset?: number },
  env?: Env
): Promise<ContentSearchResponse> {
  const sql = getDb();
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;

  if (!queryText || queryText.trim().length < 3) {
    // Vector-only path: when the caller supplied a pre-computed embedding but
    // no usable text query, run the single-query ranker with empty text so the
    // cosine-distance branch drives retrieval (text ILIKE/tsquery are guarded
    // on LENGTH($1) > 0 and won't match).
    if (options.query_embedding?.length) {
      return await searchContentBySingleQuery(sql, '', options, env);
    }
    return await listContentInternal(sql, options, limit, offset);
  }

  // One pass through searchContentBySingleQuery. For an org-wide query it takes
  // the index-driven candidate path internally (ivfflat ANN ∪ fulltext GIN ∪
  // trigram GIN, merged + re-ranked); entity-scoped queries use the entity-link
  // join. The old per-variant retry loop is gone — the candidate query's
  // to_tsquery already ORs the query's tokens, which is what the variants were
  // approximating.
  return await searchContentBySingleQuery(sql, queryText, options, env);
}
