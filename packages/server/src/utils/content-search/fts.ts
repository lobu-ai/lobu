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
 * The clean words of a free-text query (`[a-z0-9]+`, stopwords removed) — the
 * JS mirror of NORMALIZED_QUERY_SQL/TSQUERY_SQL. Joined with ` | ` they form a
 * tsquery string callers bind to `to_tsquery('english', $N)`, so Postgres can
 * use the fulltext GIN index (the in-SQL CASE+regexp form is opaque to the
 * planner). The characters kept cannot form tsquery syntax.
 */
export function tsqueryTokens(queryText: string): string[] {
  return queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS_SET.has(t));
}

/**
 * Most event rows the fulltext candidate arm may have to rank for one query.
 * The arm ranks EVERY row matching the OR of the query's words before keeping
 * its top N, so its cost is the sum of each word's matches: one word that is in
 * a fifth of a large workspace's events took the arm alone past the recall
 * timeout. On production a query cut to about 100k estimated matches ranked in
 * under two seconds, leaving the whole recall statement near half its budget.
 */
export const CANDIDATE_TEXT_MATCH_BUDGET = 100_000;

/** One query word with the `events.search_tsv` statistics for its lexemes. */
export interface QueryWordFrequency {
  token: string;
  /** The word's english lexemes; empty for a word the parser drops. */
  lexemes: string[];
  /** Highest share of rows holding one of its lexemes, if any is a most-common element. */
  frequency: number | null;
  /** Lowest share among the most-common elements; null when the column has no statistics. */
  floor_frequency: number | null;
  /** The planner's row count for `events`. */
  total_rows: number;
}

/**
 * Choose the query words the fulltext candidate arm searches for, so the rows
 * it ranks stay within `budget`.
 *
 * Each word's matches are estimated from the column statistics the planner
 * itself uses: a most-common lexeme by its recorded share, any other lexeme at
 * half the smallest recorded share (the planner's own default for an element
 * missing from the list). The rarest words are kept first, the way relevance
 * weighs words by how few documents hold them; the dropped common words still
 * score every candidate through the full query, and the vector and substring
 * arms still find rows that only they match. Without statistics nothing can be
 * estimated, so every word is kept.
 */
export function selectCandidateWords(
  tokens: string[],
  frequencies: QueryWordFrequency[],
  budget: number = CANDIDATE_TEXT_MATCH_BUDGET
): string[] {
  const stats = frequencies[0];
  if (!stats || stats.floor_frequency == null || !(stats.total_rows > 0)) return tokens;
  const unlistedFrequency = stats.floor_frequency / 2;
  const seen = new Set<string>();
  const estimated: Array<{ token: string; rows: number; position: number }> = [];
  for (const word of frequencies) {
    // A word the parser drops matches nothing; one that stems like an earlier
    // word adds nothing to the query.
    const key = [...word.lexemes].sort().join(' ');
    if (word.lexemes.length === 0 || seen.has(key)) continue;
    seen.add(key);
    estimated.push({
      token: word.token,
      rows: (word.frequency ?? unlistedFrequency) * stats.total_rows,
      position: estimated.length,
    });
  }
  estimated.sort((a, b) => a.rows - b.rows || a.position - b.position);
  const kept = new Set<string>();
  let rows = 0;
  for (const word of estimated) {
    if (rows + word.rows > budget) break;
    rows += word.rows;
    kept.add(word.token);
  }
  return tokens.filter((token) => kept.has(token));
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
// Bound the work of comparing identical content. Heavy duplication or upstream
// candidate caps can still leave fewer than `limit` distinct results.
export const COLLAPSE_POOL_FACTOR = 20;
export const COLLAPSE_POOL_MAX = 1000;
// Bound pathological candidate scans. Failures propagate to recall's existing
// partial-coverage handling rather than masquerading as successful empty results.
export const CANDIDATE_QUERY_TIMEOUT_MS = 6000;
// Probe more of the global IVFFlat index because workspace filtering can
// discard most of a single list's rows. The recall transaction disables
// iterative scanning so selective filters cannot expand this probe budget.
export const CANDIDATE_IVFFLAT_PROBES = 100;
