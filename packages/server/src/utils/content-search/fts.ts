/**
 * Full-text search helpers and recall query budgets.
 */

const STOPWORDS = [
  'what',
  'who',
  'where',
  'when',
  'which',
  'why',
  'how',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'at',
  'on',
  'in',
  'after',
  'before',
  'now',
  'current',
  'latest',
  'approved',
  'made',
];
const STOPWORDS_SET = new Set(STOPWORDS);

/**
 * Build a `tsquery` *string* (OR of clean lexemes, e.g. `"project | codename"`)
 * from a free-text query — the JS mirror of NORMALIZED_QUERY_SQL/TSQUERY_SQL.
 * Returning a plain string lets callers bind it as a parameter to
 * `to_tsquery('english', $N)` so Postgres can use the fulltext GIN index
 * (the in-SQL CASE+regexp form is opaque to the planner). Returns `null` when
 * nothing usable survives normalization.
 */
export function buildTsqueryString(queryText: string): string | null {
  const tokens = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS_SET.has(t));
  return tokens.length > 0 ? tokens.join(' | ') : null;
}

// NOTE: the final `regexp_replace(..., '\\s+', ' ', 'g')` collapses ALL
// whitespace runs (incl. newlines/tabs) to a single space BEFORE trim. Postgres
// `trim()` only strips spaces, so without this a query with a leading newline or
// tab survives trim and the TSQUERY_SQL `\\s+ -> ' | '` step below turns it into
// a leading ' | ' — which makes `to_tsquery` throw a syntax error (a multi-line
// or content-derived read_knowledge query would 400). Collapsing first keeps the
// OR-of-lexemes semantics while making the tsquery robust to arbitrary input.
const NORMALIZED_QUERY_SQL = `trim(regexp_replace(regexp_replace(regexp_replace(lower($1), '\\m(${STOPWORDS.join('|')})\\M', ' ', 'g'), '[^a-z0-9\\s]+', ' ', 'g'), '\\s+', ' ', 'g'))`;
export const TSQUERY_SQL = `CASE WHEN NULLIF(${NORMALIZED_QUERY_SQL}, '') IS NOT NULL THEN to_tsquery('english', regexp_replace(${NORMALIZED_QUERY_SQL}, '\\s+', ' | ', 'g')) ELSE NULL END`;

export function buildSearchDocumentExpr(alias: string): string {
  // Reads the GENERATED STORED `search_tsv` column populated by the events
  // table — same shape (title weighted A, payload_text weighted B) the
  // expression used to compute inline, but precomputed at row insert so
  // retrieval (@@) and ranking (ts_rank_cd) hit the same indexed value
  // without rebuilding the vector per matched row.
  return `${alias}.search_tsv`;
}

// Per-source fan-out for the index-driven candidate path — a few hundred from
// each of the ivfflat ANN / fulltext GIN / trigram GIN is plenty for any sane
// content_limit while keeping each index scan cheap.
export const CANDIDATE_VECTOR_LIMIT = 200;
// Bound pathological candidate scans. Failures propagate to recall's existing
// partial-coverage handling rather than masquerading as successful empty results.
export const CANDIDATE_QUERY_TIMEOUT_MS = 6000;
// Probe more of the global IVFFlat index because workspace filtering can
// discard most of a single list's rows. The recall transaction disables
// iterative scanning so selective filters cannot expand this probe budget.
export const CANDIDATE_IVFFLAT_PROBES = 100;
