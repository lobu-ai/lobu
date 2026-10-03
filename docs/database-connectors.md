# Database connectors (Postgres) — design + gating

Bring an external database in as memory, and read it live (no copy) for derived
entities. V1 ships **Postgres**; Snowflake/BigQuery are additive (see end).

## The model: connectors push compute down; Lobu aggregates

The connector owns the DB connection — for *both* indexing and live reads. The
gateway never opens an external pool.

- **Sync** — a `postgres` connection + a `query` feed runs a
  read-only `SELECT` on a schedule, keyset-incremental, and emits one event per
  row → embedded, searchable memory. (`packages/connectors/src/postgres.ts`)
- **Feed source read (no copy)** — that same feed implements `read`, so its stored
  query can run live and return rows without persisting them. The platform invokes
  the per-feed handler through `readSourceFeed`; this is independent of whether
  the same feed is scheduled or manually synced.
- **Connection query (no copy)** — the connector's connection-level `query()`
  supports ad-hoc governed SQL through `runConnectorQuery`. This is deliberately
  separate from configured feed reads.
- **`query_sql({ connection })`** is the single door: with a `connection` slug it
  pushes the SQL down via `runConnectorQuery` (internal org-scoping skipped — it's
  the org's own DB); without, it runs the internal org-scoped path. There is no
  separate `query_entity_type` tool.
- **`client.feeds.readMany`** is the one explicit live-feed door. Each requested
  feed has its own source query, limit, and opaque cursor. `feeds.get` only reads
  feed metadata and recent sync runs; it never calls the source.
- **`SELECT FROM events` is persisted-only.** It reads synced/materialized content,
  not source-backed feeds. `search_memory` reports that boundary in `coverage`:
  local stores searched, `source_queried: false`, and the visibility-fenced
  source feeds an agent may choose to query with `client.feeds.readMany`.
- **Derived entity** — `defineEntityType({ backing: { sql, connection? } })`. With
  `connection`, the read is `get_type → query_sql({ sql: backing_sql, connection })`
  → pushdown. Without, it's the shipped internal view over `events`/`entities`.

Single-database only: every query targets one database; no cross-source joins
(that's a later DuckDB-class engine).

Feed capability comes from its connector definition: `operations: ['sync']`,
`['read']`, or both. Storage is not a mode choice. `sync` may materialize events;
`read` always queries the source and persists no result. Transparent SQL
federation and ambient cross-source fan-out are intentionally absent. Agents
decompose explicitly: search local knowledge, inspect its coverage, then query
selected sources with `client.feeds.readMany`.

## Agent-facing live feed reads

Agents can batch live feed reads through `manage_feeds({ action: 'read_feeds' })`
or the read-only SDK method:

```ts
export default async (_ctx, client) => {
  return client.feeds.readMany({
    reads: [
      { feed_id: 123, query: 'urgent', limit: 25 },
      { feed_id: 456, limit: 25 },
    ],
    timeout_ms: 10_000,
  });
};
```

`readMany` reads up to 10 feeds in parallel. Each feed returns independently as
`{ ok: true, rows, columns, next_cursor? }` or
`{ ok: false, error, error_code, retryable }`, so a missing or visibility-fenced
feed does not fail the whole batch. The per-feed timeout defaults to 10s and
clamps at 30s. It aborts device and HTTP transports and tears down compiled
connector runs at the deadline.

## SSRF / egress trust model

The DB socket lives in the **connector isolate**, behind the worker egress
controls — not the gateway. The dogfood reaches Lobu's own private PG, so the HTTP
scrapers' block-all-private-IPs rule can't be reused.

- **Self-hosted / first-party:** `DATABASE_URL` is an operator-set secret — same
  trust boundary as any other env secret. Private IPs allowed. Ships now.
- **Untrusted multi-tenant cloud:** a tenant-supplied `DATABASE_URL` (metadata
  IPs, internal CIDRs, another tenant's DB) is an exfil/scan vector. **Allowed,
  hardened.** Under `LOBU_CLOUD_MODE=1` the server injects the `block-private`
  egress policy on every run path; the isolate host then refuses internal
  addresses and dials only the validated IP, and the connector forces TLS
  (below). There is no per-connector cloud allow/deny list: every connector
  runs inside the isolate, so the egress policy is the boundary. The one
  connector-keyed registry left is `DB_EGRESS_HARDENED_CONNECTOR_KEYS`
  (`worker-api/connector-claim-lanes.ts`), which names the connectors that open
  a raw tenant-supplied DB socket, so in cloud mode only a fleet worker
  advertising `db_egress_hardening` may CLAIM one of their runs — it closes the
  rolling-deploy window where a new gateway hands a claimed run to an old
  worker. A future warehouse connector (Snowflake, BigQuery) joins it when it
  ships.

**Address policy (the host's, through the one egress transport).** The
connector never resolves or dials: every socket it opens is a host capability
(`socketOpen` in `packages/connector-worker/src/executor/isolate.ts`) that
resolves the `DATABASE_URL` host through `@lobu/connector-worker/egress`
(`resolveEgressAddresses`) — the same module the gateway proxy, the MCP proxy
and the isolate's `fetch` dial through — and dials only an address that passed.
The policy axis is `@lobu/connector-sdk/ip-reachability`'s
`EgressAddressPolicy`, read from `LOBU_DB_EGRESS_POLICY` (injected by the
server from cloud mode; on this axis a missing or misspelt value fails closed
to `block-private` — the connector-side TLS reader below defaults the other
way, to the trusted `allow-private`, so both job producers always set the key
rather than relying on either default):

- `allow-private` (self-hosted, the default off cloud) — allows loopback /
  RFC1918 / CGNAT / ULA, but still refuses link-local (`169.254/16`), cloud
  metadata in every spelling (the next bullet enumerates them), multicast, the
  reserved and broadcast range, and the unspecified address (no DB lives
  there).
- `block-private` (cloud) — refuses **every** non-public address unless the
  operator explicitly lists that exact URL host in the comma-separated
  `LOBU_DB_EGRESS_ALLOW_HOSTS` deployment variable. An exemption lowers only
  that host to the `allow-private` floor; metadata endpoints — including the
  ones that sit inside ranges the floor permits (AWS IMDS over IPv6 in ULA,
  Alibaba in CGNAT, Oracle) — remain refused. Hostnames are resolved once and
  refused if ANY returned address is blocked (multi-record rebind), with
  IPv4-mapped / NAT64 / zone-id normalization and fail-closed on malformed
  literals; `localhost` and the internal suffixes are refused by name before
  DNS.
- **Resolve-then-pin** is the transport's, not a driver option: the host dials
  exactly the address it validated, so the driver never re-resolves DNS and the
  rebind TOCTOU is closed across pool reconnects. The TLS `servername` stays
  the ORIGINAL hostname, so SNI-routed servers see the configured name.

**TLS (`packages/connectors/src/db-egress-guard.ts`).** The one policy piece
that stays connector-side, because nothing on the wire tells the host that a
socket carries database credentials and postgres.js only upgrades when the pool
was handed `ssl`:

- **Forced TLS under `block-private`:** the connection is encrypted regardless
  of URL params. `sslmode=disable` (or `ssl=false`) is rejected with a clear
  error before any socket opens; absent / `allow` / `prefer` / `require`
  become `require` (encrypt always). The floor is `require` rather than
  `verify-full` because tenant DBs commonly present self-signed / private-CA
  certs — upgrading the floor once per-connection CA upload exists is the noted
  follow-up.
- **Verification the lane cannot deliver is refused under every policy:** the
  guest's `startTls` carries only the server name, so a URL asking for
  `verify-ca` / `verify-full` (or `sslrootcert=system`) fails closed rather
  than connecting encrypted-but-unverified behind a verifying-looking URL.

The allow-host setting is global operator deployment config, not connection or
tenant config. Entries must match the bare host from `DATABASE_URL` exactly
(IPv6 without URL brackets); CIDRs, wildcards, ports, and bracketed IPv6 forms
are rejected at parse time so a typo cannot leave an exemption silently
inactive. Exempted names are still resolved once, validated against the floor,
and dialled at the validated address with forced TLS.

**Deferred (explicit follow-up):** a per-org destination allowlist ("this org
may only reach these DB hosts"). block-private + host-side pinning + forced TLS
protects the platform boundary; an allowlist is an enterprise policy feature
layered on top later.

## Entitlement boundary (design-only — not yet built)

Gate advanced database connectivity behind a paid tier. Seam: `organization.plan`
(`free` | `pro` | `enterprise`) + a check in the `multi-tenant.ts` auth resolver.

| Capability | Tier |
| --- | --- |
| Postgres connector + memory feeds | free / pro |
| Internal derived entities | free / pro |
| External-backed (live) derived entities — `backing.connection` set | pro / enterprise |
| Warehouse connectors (Snowflake, BigQuery), source reads + federated search | enterprise |

Enforcement points when built: connector install, connection count, and presence
of `backing.connection`.

## Snowflake / BigQuery forward-compat

No redesign needed: each is a new bundled connector implementing per-feed
`sync` + `read`, plus connection-level `query`, with `env_keys` carrying its credentials
(Snowflake account/user/keypair/warehouse/role; BigQuery service-account JSON).
The pushdown plumbing (`runConnectorQuery`, the `query` run-mode, `query_sql`'s
`connection`) is dialect-agnostic — only the connector's own `query()` differs.
Metered warehouses make "live, every read" costly → those lean on the indexed
(memory-feed) path or materialization.
