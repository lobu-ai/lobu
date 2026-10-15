# Workspace-bounded search and recall

Status: **Part 1 accepted 2026-10-15; Part 2 pending Part 1 measurements.**
Part 1 below is query-only; Part 2 adds an extension and two indexes, which is
a DB design change under the AGENTS.md rules and needs explicit confirmation.

Evidence was measured on 2026-10-15 against production running
[`9da1deb36`](https://github.com/lobu-ai/lobu/tree/9da1deb36c17a7eff5ce1ad610dfe8af21cdec73)
(the deployed revision at measurement time). Every number comes from read-only
`EXPLAIN (ANALYZE, BUFFERS)` or catalog queries, run inside `BEGIN READ ONLY`.
"Warm" means a repeat run with zero shared reads. Workspaces are named by
size, not by slug.

## Problem

`search_memory` recall uses the candidate path in
`utils/content-search/search-path.ts` (`useCandidatePath`). It unions three
capped candidate arms, then scores only those candidates:

- **Vector arm.** ANN over `idx_events_embedding`, an IVFFlat index
  (`lists=1000`). It covers every workspace's vectors, and `event_embeddings`
  has no `organization_id`, so the workspace filter runs *after* the index
  picks rows.
- **Full-text arm.** `search_tsv @@ tsquery` through the global
  `idx_events_search_tsv` GIN, ranked by `ts_rank_cd`, capped at 200.
- **Substring arm.** `payload_text ILIKE '%q%'` through the global trigram GIN
  `idx_events_raw_content_trgm`, capped at the newest 200.

The arms' indexes have no workspace in the key. The two problems that follow
were measured below.

### 1. Recall quality: the vector arm misses most of the right rows

The session default is `ivfflat.probes = 1` and `ivfflat.iterative_scan = off`.
One probe scans 1 of 1,000 lists, about 757 vectors. The workspace filter then
discards every vector from other workspaces. A workspace that owns a minority
of the corpus gets back few or wrong neighbours.

Vector distribution: 756,654 live vectors across 32 workspaces. The largest
workspace owns 53.7%, the second 26.6%, the third 6.9%. The median workspace
has 24 vectors.

**Full deployed recall query vs the exact path, top-30 overlap.** Both paths
come from the same builder, with the same captured query vector and public
scope.

| workspace | query | candidate vs exact overlap (probes=1) | with probes=32 + iterative scan |
|---|---|---|---|
| 2nd-largest by vectors (~1.39M events) | "lobu" | **4/30** | 26/30 |
| largest by events (~1.84M live events) | "lobu" | 30/30 | 30/30 |
| largest by events | "customer meeting" | 30/30 | 30/30 |

**Vector arm alone, in-workspace recall@30 vs an exact in-workspace sort.**
The query vectors are the workspace's own documents.

| workspace share of vectors | probes=1 | probes=1 + iterative | probes=10 | probes=32 | probes=100 |
|---|---|---|---|---|---|
| 26.6% (sample A) | 1/30 (only 124 rows returned) | 2/30 | 14/30 | 25/30 | — |
| 26.6% (sample B) | 29/30 | — | — | 30/30 | 30/30 |
| 26.6% (sample C) | 12/30 | — | — | 26/30 | 30/30 |
| 53.7% | 30/30 | 30/30 | 30/30 | 30/30 | — |

A query vector from a *different* topic (another workspace's document) did
much worse in the largest workspace: 67 of 200 rows came back and 0 overlapped
the exact top 200. With iterative scan, 200 rows came back and 3 overlapped.

For workspaces of about 50k vectors or fewer, the planner skipped the ANN index
and sorted the workspace's own vectors exactly. That gave 200/200 overlap in
1–840ms. **The quality gap hits the large workspaces, which are the ones with
the most to recall.**

Because there is no error, agents get plausible but wrong results. #4098 fixed
the timeout case, but this one is not a timeout.

### 2. Latency: text-arm cost grows with in-workspace match count

#4099 bounded the text arms by workspace scope. That fixed the 20–32s scans
from the 2026-10-13 handoff. Warm timings of the full deployed candidate query
now:

| workspace | query | candidate path | exact path (`read_knowledge`) |
|---|---|---|---|
| largest by events | "lobu" | 2.8–4.8s (2.8–3.3s warm) | 6.0–9.3s |
| largest by events | "customer meeting" | 2.0–2.7s | — |
| 2nd-largest | "lobu" | 1.2–2.1s | 5.0–5.1s |
| 2nd-largest | "customer meeting" | 1.7–2.6s | — |

`pg_stat_statements` covers successful runs since 2026-08-14: 3,000+ candidate
calls, means of 0.1–1.2s per statement shape, maxima of 5.0–5.8s. Cancelled
statements are not recorded there, and the Postgres log only holds about 40
minutes. **The current timeout rate is therefore unknown.** The worst warm run
measured uses about 80% of the 6s `CANDIDATE_QUERY_TIMEOUT_MS`.

Per-node breakdown, largest workspace, "lobu", warm, 3.3s total:

| node | rows | time |
|---|---|---|
| vector arm (IVFFlat index scan) | 586 | 21ms |
| FTS arm heap scan | 9,016 kept; 103,857 lossy-recheck removals; 32,801 filter removals | 1,715ms |
| └ `idx_events_search_tsv` (global posting list for "lobu") | 345,269 | 78ms |
| └ `idx_events_live_linked_org_ids`, **no index condition**, used only to prove `superseded_by IS NULL` | 1,282,602 | 339–556ms |
| └ `idx_events_organization_id` (includes superseded rows) | 3,139,395 | 211–276ms |
| substring arm heap scan | 10,765 kept; 121,682 lossy-recheck removals | 1,379ms |
| └ trigram GIN, global | 401,133 | 62ms |
| └ same live-linked full scan and org bitmap | | ~550ms |

Without the ACL filters, the full-text term matches 41,817 live events in that
workspace. Standalone probes of the FTS arm, at the same workspace and term:

- current shape: 2.0s
- the same query with the live-linked full scan removed: 1.9s
- plus `work_mem = 128MB`, so the bitmap is no longer lossy: 0.81s
- capping by newest match instead of rank: 0.13s

Raising `work_mem` to 64MB in the full query cut buffer hits 3–5× but did not
reduce wall time within measurement noise.

The remaining cost is per-match work inside the workspace: bitmap ANDs, lossy
rechecks, detoasting `payload_text` for the ILIKE recheck, and `ts_rank_cd`
over every match. It is bounded by the workspace, but grows with the
workspace's history. That conflicts with "request paths never aggregate
history" once a term is common.

### What has already shipped (not part of this design)

- **Honest failure (#4098).** The candidate transaction preserves the SQLSTATE,
  and `gatherLocalRecall` reports `coverage.status = 'partial'` with retry
  guidance instead of a complete empty answer. The tests are
  `tools/__tests__/search-partial-coverage.test.ts` and
  `search-memory-recall-contract.test.ts`. **No further PR is needed for the
  timeout case.** One residual: when no query embedding is available,
  `useCandidatePath` is false, so recall falls to the exact path with no 6s
  bound. That is a small query-only follow-up (see Part 1).
- **Workspace-scoped text arms (#4099)**, plus superseded-vector reclamation and
  the IVFFlat reindex (3.9GB index, down from 9.8GB).
- **DB resize.** Production already runs 4 CPU / 64G, `shared_buffers=16GB` and
  `effective_cache_size=48GB`. The 2026-10-13 handoff described this as held;
  it has since been applied. Vectors and indexes fit in cache, and warm runs
  above show zero shared reads.

## Current storage facts

| object | size | notes |
|---|---|---|
| `events` | 20GB total, 6.5GB heap | 5.06M rows, 2.47M live; 110k inserts/day, 753k/week |
| `event_embeddings` | 15GB total | 756,654 vectors (2.2GB of vector data), one model, one chunk per event, 0 superseded; 14.5k inserts/day |
| `idx_events_embedding` | 3.9GB | IVFFlat, lists=1000, global |
| `idx_events_search_tsv` | 1.3GB | GIN, global, includes superseded rows |
| `idx_events_raw_content_trgm` | 4.0GB | trigram GIN, global, includes superseded rows |
| `idx_events_live_linked_org_ids` | 5.7MB | partial GIN; 0 live events have a non-empty `linked_org_ids` today |
| `idx_events_live_org_effective_date` | 198MB | (org, effective date, id) where live |
| database | 39GB | 165GB free on the volume |

Extensions: pgvector 0.8.1, pg_trgm 1.6. `btree_gin` is not installed. The
server is PostgreSQL 18.1.

## Options

### Vector arm

**V1. Query-only probe budget (no schema change).** Inside the existing
candidate transaction, add `SET LOCAL ivfflat.probes = 32` and
`SET LOCAL ivfflat.iterative_scan = 'relaxed_order'`.

- Quality, measured: full-query overlap goes from 4/30 to 26/30. Vector-only
  recall goes from 1–29/30 to 25–30/30. Probes=100 reached 30/30 on every
  sample.
- Cost, measured: +0–1s on the largest workspace (3.7–4.3s vs 2.8–3.3s warm),
  and ±0 on the second-largest (1.5–2.3s vs 2.0–2.1s). Buffer hits go from
  about 380k to 400–670k.
- Write amplification: none. Migration: none.
- Risk: lower timeout headroom on the largest workspace, with a worst warm run
  of 4.9s against 6s. `relaxed_order` can return slightly out-of-order rows;
  the outer `GROUP BY … ORDER BY MIN(dist)` already re-sorts them.

**V2. Denormalise `organization_id` onto `event_embeddings`, with per-workspace
partial indexes or LIST partitions. Rejected.**

- The column alone gives no tenant-local ANN, because the index is still
  global.
- Per-workspace partial indexes or partitions are tenant-specific DDL. The
  AGENTS.md rule keeps tenant state out of shared migrations.
- Hash partitions still mix workspaces, so a small workspace's recall is no
  better than today.
- Linked-workspace visibility (`linked_org_ids`) cannot be expressed by one
  owner column, so the linked arm would still need the join.
- Measured cost of the exact in-workspace sort this would enable: 3.2–4.6s for
  the largest workspace's 406k vectors and 1.5–2.3s for 201k, single-threaded.
  That is too slow as the bounded path.
- Backfill would be 757k rows plus a `NOT NULL` validate.

**V3. HNSW with `hnsw.iterative_scan` and a workspace filter. Deferred
benchmark candidate.**

- Work is bounded by `ef_search` and iterative-scan limits, independent of a
  workspace's corpus share. That is the right long-term shape.
- Estimated cost:
  - index about 2.5–3.5GB (2.2GB of vector data plus the graph)
  - build 10–40 min with a session-level `maintenance_work_mem` of 4GB or more
    and `CREATE INDEX CONCURRENTLY`
  - inserts at about 0.2/s are negligible
- Main risk: vacuum and maintenance of HNSW under steady deletes from
  supersede reclamation. pgvector repairs neighbour lists on vacuum, which is
  much slower than IVFFlat.
- None of these numbers were measured here. Revisit only if V1's probe budget
  stops fitting the time budget as the corpus grows.

### Text arms

**T1. `btree_gin` plus two partial composite GIN indexes.** The SQL would be:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX CONCURRENTLY idx_events_live_org_search_tsv
  ON events USING gin (organization_id, search_tsv) WHERE superseded_by IS NULL;
CREATE INDEX CONCURRENTLY idx_events_live_org_payload_trgm
  ON events USING gin (organization_id, payload_text gin_trgm_ops) WHERE superseded_by IS NULL;
```

What it removes, measured on the largest workspace: the live-linked full scan
(339–602ms per arm), the 3.1M-row workspace bitmap that includes superseded
rows (211–276ms per arm), the 32–36k superseded filter removals, and most of
the lossy recheck. A precise bitmap of about 42k TIDs fits in 16MB of
`work_mem`. The standalone precise-bitmap proxy measured 0.81s against 2.0s.

What it does not remove: ranking and rechecking every match in the
workspace. Trigram ILIKE always rechecks, which detoasts `payload_text`. A
multicolumn GIN also intersects posting lists rather than isolating a tenant.

| | estimate |
|---|---|
| saving | 0.5–1.2s per text arm on the largest workspace; full query about 1.5–2.5s instead of 2.8–4.8s |
| size | about 0.7GB (tsv) plus about 2GB (trigram), since they cover live rows only (2.47M of 5.06M); the global indexes are 1.3GB and 4.0GB |
| write amplification | two more GIN updates per insert (110k/day). Supersede updates are already non-HOT because `superseded_by` is in existing partial predicates, so they add a removal from the partial set, not a new non-HOT update. GIN fastupdate pending lists absorb bursts. |
| build | `CREATE INDEX CONCURRENTLY` on a 20GB table: about 5–15 min (tsv) and 20–60 min (trigram) at the current 1GB `maintenance_work_mem`. No lock beyond SHARE UPDATE EXCLUSIVE. Disk headroom is 165GB. |
| backfill | none; the index build is the backfill |
| risk | the planner may keep choosing the old BitmapAnd. The verification plan checks the plan shape, and the existing CI guard `feed-query-plan.test.ts` gets an assertion. If the measured win is under 30%, drop both indexes; nothing else depends on them. |

**T2. Partition `events` by workspace. Rejected.** It rewrites the 20GB
append-only ledger and every index and foreign key, through a long migration.
LIST partitions per workspace are tenant DDL. It does not fix per-match ranking
either.

**T3. Bound per-arm work by capping matches before ranking. Not recommended
now.** For example, rank only the newest N matches. Measured 0.13s against
2.0s. But it changes which old, strong matches can surface, which is a product
change to recall semantics. Keep it as the next lever if T1 is not enough.

**T4. Raise `work_mem` inside the candidate transaction only (query-only). Not
recommended.** It removes the lossy bitmaps (3–5× fewer buffer hits) but showed
no wall-time win in the full query, and it raises worst-case memory per
connection.

### Failure reporting

**F1. Make a candidate timeout report incomplete coverage.** Already shipped in
#4098; see "What has already shipped".

**F2. Bound the embedding-less recall fallback.** When no query embedding is
available, recall uses the unbounded exact path. Run it under the same
`SET LOCAL statement_timeout` so it fails into partial coverage rather than
running 6–9s. It is query-only, with no schema or API change. Ship it as a
small PR alongside Part 1.

## Recommendation

Keep the indexes global and bound the work each query does, in two parts. No
new table and no new column.

1. **Part 1, query-only, can ship without the DB-design gate.** Set the
   candidate transaction's vector budget to `ivfflat.probes = 32` and
   `ivfflat.iterative_scan = 'relaxed_order'` (V1), and bound the
   embedding-less fallback (F2). This fixes the measured quality gap (4/30 to
   26/30) at a cost of up to 1s. Because it changes which results agents see,
   it still goes past Emre as a normal PR.
2. **Part 2, needs approval.** `CREATE EXTENSION btree_gin` plus the two partial
   composite GIN indexes (T1). They are built concurrently, benchmarked against
   the plan shapes below, and dropped if the win is under 30%. The global text
   indexes stay until Part 2 is proven.

Rejected: V2 and T2. Deferred: V3 (HNSW) and T3 (cap before rank). They are
the next levers if the 6s budget is threatened again as the corpus grows.

## What this lets us delete

- After Part 2 is proven and `pg_stat_user_indexes.idx_scan` stays flat for 14
  days:
  - **`idx_events_search_tsv`** (1.3GB) and **`idx_events_raw_content_trgm`**
    (4.0GB). Their only readers are the two text arms and the exact path's
    per-row predicates; the exact path filters rows rather than scanning these
    indexes.
  - The linked-org text arms would then filter the (small) linked set per row
    instead of AND-ing a global posting list. Today that set is 0 live rows.
  - Net change: about −2.6GB of index.
- The full scan of the `idx_events_live_linked_org_ids` partial index no longer
  appears in recall plans. The index itself stays, because the feed and count
  use it.
- Nothing is deleted on the vector side. `idx_events_embedding` stays.

## Migration plan for Part 2

- **Migration shape.** One migration per index, using the #4080/#4091 pattern:
  `-- migrate:up transaction:false`, `-- lobu:no-quiesce`, a heal-invalid guard
  that drops an `indisvalid = false` leftover before
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, and a `HEAL_MIGRATIONS` entry in
  `invalid-index-heal-migration.test.ts`.
- **Extension.** `CREATE EXTENSION IF NOT EXISTS btree_gin` goes in its own
  transactional migration first. The operator image already ships contrib.
- **Order.**
  1. Merge the tsv index first and measure it.
  2. Then the trigram index, which is the larger build.
  3. Each build runs off-peak; the deploy pipeline applies migrations on
     rollout.
- **Query change.** None should be needed: the arms already filter
  `organization_id = $org AND superseded_by IS NULL`. If the planner still
  prefers the BitmapAnd, change the direct arm's predicate shape. Never use a
  planner hint.
- **Rollback.** `DROP INDEX CONCURRENTLY` on both indexes, then
  `DROP EXTENSION btree_gin`. Nothing reads them by name.

## Verification plan

Capture the deployed builder SQL with `capture-search-sql.ts`
(`LOBU_LINKED_ORG_SCOPE=1`, `sort_by: 'score'`, `limit: 30`,
`include_total: false`, `min_similarity: 0.3`). Inputs:

- the largest workspace by live events and the second largest by vectors
- each with "lobu" and "customer meeting"
- one member-scope capture, not only public scope, because member ACL filters
  run per candidate

Run every probe 3× and report warm runs (zero shared reads). Never drop caches
to manufacture a cold run.

```sql
-- 0. Baseline facts (rerun before and after each part)
BEGIN READ ONLY;
SELECT count(*) FROM event_embeddings;
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE relname IN ('events','event_embeddings')
  AND indexrelname ~ 'search_tsv|trgm|embedding|live_linked|live_org';
SELECT calls, round(mean_exec_time), round(max_exec_time)
FROM pg_stat_statements WHERE query LIKE '%search_candidates%' ORDER BY calls DESC LIMIT 10;
ROLLBACK;

-- 1. Latency + plan: captured candidate SQL, literal-bound
BEGIN READ ONLY; SET LOCAL statement_timeout = '60s';
-- Part 1 "after" only:
-- SET LOCAL ivfflat.probes = 32; SET LOCAL ivfflat.iterative_scan = 'relaxed_order';
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <captured candidate SQL>;
ROLLBACK;
-- Record: Execution Time, total shared hit/read, and for each text arm
-- whether the plan still contains a Bitmap Index Scan on
-- idx_events_live_linked_org_ids with no Index Cond (Part 2 must remove it).

-- 2. Quality: top-30 overlap, candidate vs exact
BEGIN READ ONLY; SET LOCAL statement_timeout = '90s';
SELECT json_agg(id) FROM (<captured exact SQL>) q;
ROLLBACK;
BEGIN READ ONLY; SET LOCAL statement_timeout = '90s';
-- (+ the Part 1 SET LOCALs for "after")
SELECT json_agg(id) FROM (<captured candidate SQL>) q;
ROLLBACK;

-- 3. Vector-only recall@30 by workspace size (ranks 1, 2, 4, 8, 12; offsets 7/1000/20000)
BEGIN READ ONLY; SET LOCAL max_parallel_workers_per_gather = 0;
-- psql: \gset the org at rank :rk by live vector count, and a query vector :qv
SELECT array_agg(event_id) AS ex FROM (
  SELECT emb.event_id FROM event_embeddings emb JOIN events e ON e.id = emb.event_id
  WHERE e.organization_id = :'org' AND e.superseded_by IS NULL
  ORDER BY (emb.embedding <=> :'qv'::vector) + 0 LIMIT 30) x \gset
SET LOCAL ivfflat.probes = :probes; SET LOCAL ivfflat.iterative_scan = :'iter';
SELECT count(*) FILTER (WHERE event_id = ANY(:'ex'::bigint[])) FROM (
  SELECT emb.event_id FROM event_embeddings emb JOIN events e ON e.id = emb.event_id
  WHERE e.organization_id = :'org' AND e.superseded_by IS NULL
  ORDER BY emb.embedding <=> :'qv'::vector LIMIT 200) a;
ROLLBACK;

-- 4. Text-arm isolation (Part 2 before/after), largest workspace
BEGIN READ ONLY; SET LOCAL max_parallel_workers_per_gather = 0;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM events ce
WHERE ce.search_tsv @@ to_tsquery('english','lobu') AND ce.superseded_by IS NULL
  AND ce.organization_id = :'org'
ORDER BY ts_rank_cd(ce.search_tsv, to_tsquery('english','lobu')) DESC LIMIT 200;
ROLLBACK;
```

Pass criteria:

- **Part 1:**
  - top-30 overlap of at least 25/30 on every captured query
  - largest-workspace candidate path at most 4.5s warm
  - no new `57014` in the slow log during a 24h watch
  - live `search_memory` returns complete coverage on the large workspaces
- **Part 2:**
  - the live-linked full scan is gone from the text arms
  - largest-workspace candidate path at least 30% faster than Part 1's "after"
  - identical top-30 IDs to before Part 2, since the indexes must not change
    results
  - feed and count plans unchanged (`feed-query-plan.test.ts`)
- **Live:** paired-browser `search_memory` calls on both large workspaces,
  checked after the squash commit is an ancestor of the deployed `/health`
  revision.

## Open questions

1. **Probe budget.** 32 measured as the knee: 25–30/30 recall for up to +1s.
   100 reached 30/30 everywhere but was not timed in the full query. Is
   25/30 acceptable, or should Part 1 measure 64?
   **Answer:** probes = 32; Part 1 also times 64 and records both.
2. **Timeout rate.** It is unmeasurable today, because the log keeps about 40
   minutes and `pg_stat_statements` omits cancels. Should Part 1 also count
   candidate-path failures by SQLSTATE in the existing metrics, with no new
   table? Without that, the value of Part 2 is only estimated.
3. **HNSW (V3).** Should it be benchmarked on a restored snapshot instead of
   prod? The restore-drill job is currently failing, so that would need fixing
   first.
4. **Exact path.** `read_knowledge` scoring still aggregates every in-scope row
   (5–9s). That is a separate design (product/API semantics of totals and
   offsets) and is out of scope here. Confirm it should stay separate.
   **Answer:** exact path stays a separate design.
