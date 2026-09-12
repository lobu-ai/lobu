# Connector authoring

When to write a connector, the three authoring surfaces, and the SDK contract.
The full SDK reference is `packages/connectors/src/README.md` in the repo
(`github.com/lobu-ai/lobu/blob/main/packages/connectors/src/README.md`); the
seed example is `examples/lobu-crm/npm-downloads.connector.ts`.

## When to write a connector

Search the catalog first: `client.catalog.listInstalled({ kinds: ["connectors"] })`,
then `client.catalog.listCatalog(...)` if it is not installed. If a matching
connector exists, connect to it. If none matches the data source, do **not**
conclude "no integration exists" — author a custom connector (in the project,
or over MCP, below).

## Authoring surfaces

1. **Project-local custom connectors** (`connectors/<name>.connector.ts`) —
   registered in `lobu.config.ts` with
   `connectorFromFile("./connectors/<name>.connector.ts")` and compiled by
   `lobu apply`. Model on `examples/lobu-crm/npm-downloads.connector.ts`.
2. **Bundled built-ins** (`packages/connectors/src/<name>.ts`) — compiled into
   the platform catalog and auto-installed per org on first use. Only for
   connectors shipped with the platform itself.
3. **Over MCP, no CLI** — an agent drives the whole loop through
   `manage_connections` tool actions (see below).

### The MCP loop

All of these are `manage_connections` actions available to agents:

1. **`validate_connector_source`** — compile-checks raw `source_code` (or a
   `source_url`) and returns diagnostics plus the extracted actions, scopes,
   and feed keys. Nothing is installed; this is the dry run.
2. **`install_connector`** — installs from exactly one of `connector_id`
   (reviewed catalog), `source_code`, `source_url`, `source_uri`, or
   `mcp_url` (proxy an external MCP server as a connector). Org-scoped;
   compiled code is stored in `connector_versions` with prior versions
   retained.
3. **`test`** — live probe of the connection's auth.
4. **Read/sync once** — a one-shot `read_feeds` source read (or a manual sync)
   to watch the first events land before trusting it.
5. **Iterate** — `get_connector_source` → `update_connector_source` (each
   update re-validates), with `rollback_connector_version` to revert.

Prefer validate → install → test → read over installing blind. Two gates are
deliberately human-only: `connection.config.action_modes` (approval overrides)
and connector-run approvals.

## The contract

A connector default-exports either a `defineConnector({ ... })` spec or a class
extending `ConnectorRuntime` from `@lobu/connector-sdk`. In the functional
form below, feed and action keys come from their record keys. In both forms,
each feed declares its own `sync` and/or `read` handler:

```ts
import { defineConnector } from "@lobu/connector-sdk";

export default defineConnector({
  key: "my_connector",
  name: "My Connector",
  version: "1.0.0",
  authSchema: { methods: [{ type: "none" }] },
  feeds: {
    items: {
      name: "Items",
      configSchema: {
        type: "object",
        required: ["scope"],
        properties: { scope: { type: "string" } },
        additionalProperties: false,
      },
      eventKinds: { item: { description: "An item from the service" } },
      sync: async () => ({
        events: [],
        checkpoint: { last_sync_at: new Date().toISOString() },
      }),
      read: async () => ({
        rows: [],
        hasMore: false,
      }),
    },
  },
  actions: {
    create_item: {
      name: "Create item",
      requiresApproval: true,
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      execute: async (ctx) => ({
        success: true,
        output: { name: ctx.input.name },
      }),
    },
  },
});
```

Optional top-level handlers (`authenticate`, `query`,
`reflectMetrics`, `registerWebhook`, `unregisterWebhook`) dispatch through the
corresponding `ConnectorRuntime` methods.

### Feed capabilities and storage

Handlers are the capability contract. A feed with `sync` publishes
`operations: ['sync']`; one with `read` publishes `['read']`; defining both
publishes `['sync', 'read']`. Connector authors do not declare a separate feed
mode. Only metadata-only device or MCP definitions declare `operations`
directly because their executable handlers live elsewhere.

- **`sync`** returns event envelopes and a checkpoint. The platform may persist
  those events for local search, entities, relationships, and Automations.
- **`read`** pushes filtering and pagination to the source and returns rows to
  the caller without persisting them.
- **Both** lets a connector maintain a small, searchable index while retaining
  an explicit path to source-owned detail. Gmail can sync a filtered set of
  threads yet search the wider mailbox on demand; SQL and warehouse connectors
  can materialize selected queries while pushing ad-hoc compute to the
  database.

`configSchema` governs the persisted feed instance across every handler.
Top-level `required` fields are enforced for read-only, sync-only, and hybrid
feeds alike. Model operation-specific optionality in the schema itself.

Agents read source-owned data explicitly:

```ts
const result = await client.feeds.readMany({
  reads: [{ feed_id: 123, query: "open", limit: 25 }],
  timeout_ms: 10_000,
});
```

`search_memory` remains local and reports visible, unqueried source feeds in its
coverage result. Each `readMany` entry is independently bounded by the per-feed
timeout, and one failure does not discard successful results from the others.

### What a feed sync must get right

- **`origin_id` stability.** Keep `origin_id` identical for the same source item
  across syncs. Ingestion may supersede the prior row and allocate a new
  `events.id`; cross-sync dedupe relies on `origin_id`, never the row id. Change
  it only when source identity genuinely changes.
- **Checkpointing.** Return `checkpoint` (timestamp- or id-based) for incremental
  sync; use `ctx.emitEvents` / `ctx.updateCheckpoint` mid-sync for long runs so a
  crash resumes from the last saved point.
- **`eventKinds`.** Declare the event types the feed can emit. A feed's
  `eventKinds` are also the default Automation trigger catalog: each kind becomes
  a subscribable event type. The first successful non-dry sync establishes the
  feed's baseline without activation; later inserts activate subscribers. The
  derived path fires feed `eventKinds` only — if you declare explicit
  `automationEvents` keys that differ from your feed `eventKinds`, attach matching
  `automation_signals` to each emitted `EventEnvelope`, or those triggers never
  fire (the picker advertises them but ingestion never emits them).
- **Entity relationships.** Give the event kind's attribution rules stable
  `name` values, then reference those names from `relationships`:

  ```ts
  eventKinds: {
    invoice: {
      attributions: [
        {
          name: "invoice",
          role: "belongs_to",
          target: { entityType: "invoice", identities: [/* ... */] },
        },
        {
          name: "customer",
          role: "about",
          target: { entityType: "customer", identities: [/* ... */] },
        },
      ],
      relationships: [
        { type: "invoice_customer", from: "invoice", to: "customer" },
      ],
    },
  }
  ```

  Install preflight requires the relationship type to be active in the target
  organization and rejects authorization-bearing types. On ingestion, Lobu
  resolves the named attributions and reconciles the event's complete edge set
  atomically with its event row. Ownership follows `(connection_id, origin_id)`,
  so resync changes retract only that source item's claim; another source or a
  manual claim can retain the same graph fact. Deleting the connection retracts
  its remaining claims.
- **No real credentials in code.** Secrets flow through `ctx.credentials` /
  `ctx.config`; workers never receive durable stored credentials.

### Actions (write-back)

Declare `actions` with an `inputSchema`, `requiresApproval`, and annotations
(`destructiveHint`, `openWorldHint`, `idempotentHint`); handle them in
`execute(ctx)`. Omit it entirely if the connector has no actions.

For binary inputs, use `fileInputSchema` from `@lobu/connector-sdk` on the
file-valued field, for example `image: fileInputSchema({ maxBytes: 5 * 1024 *
1024, contentTypes: ["image/png", "image/jpeg"] })`. Callers pass a reusable
`{ $file: "lobu://file/<id>", ... }` reference; `execute(ctx)` receives
`{ base64, filename, content_type }` at that field. Existing inline base64 inputs
also work and obey the declared size and media-type limits.

Clients can upload repeated multipart `files` fields to
`POST /api/<workspace>/files` using their normal authenticated API session and
write scope. The response contains a `files` array of references. ChatGPT can
instead attach files directly to `run_sdk`; select `file_organization` on an
account-scoped connection, then use `ctx.files` in the script. Upload references
are also returned when the script fails, so retry with those references.

Ingestion uses the shared artifact store and accepts up to 10 files, 50 MiB per
file and 100 MiB per batch. Connector execution accepts at most 12 MiB of file
data per operation, or the connector's smaller declared limit; the current
isolate bridge caps each base64 string at 16 MiB. References are bound to the uploading user,
workspace, and any agent or Automation identity. The existing operation queue
records file authorization before approval and resolves the same stored bytes
at execution; missing or substituted files fail before connector dispatch.

### Auth methods

`none`, `env_keys` (scope `connection` or `organization`), `oauth` (built-in or
custom provider with `clientIdKey`/`clientSecretKey`), and `browser` for custom
cookie-backed sessions. Paired-extension connectors use `none` when the browser
owns authentication. Full schemas are in the SDK reference.

### Dependencies and environment

- npm deps go in the project/package `package.json` and are bundled by esbuild;
  native deps go in `runtime.nix.packages` as nixpkgs refs.
- Connector code runs in a V8 isolate and sees only the explicit `job.env`
  values, without an ambient host environment or filesystem. Persist sync
  state in `checkpoint`.
- Browser scraping: use `extensionDomScrape` / `extensionNetworkSync` through
  the paired extension for page and network operations.

## Full reference

- `packages/connectors/src/README.md` — the complete SDK guide: definition,
  auth, feeds, sync, actions, scoring, worker sandbox.
- `packages/connector-sdk/` — the published contract (`ConnectorRuntime`,
  `defineConnector`, source primitives, browser layer).
- Seeds: `examples/lobu-crm/npm-downloads.connector.ts` (minimal, no auth),
  `examples/brand-intelligence/*.connector.ts` (richer: auth, actions, per-feed
  `eventKinds`).

### Windowed source reads

Feeds that can apply fixed source-time bounds declare `readWindowAxis` alongside
`read`. An Automation `@feed` source then uses the existing live reader without
persisting rows. `FeedReadContext.window` carries `{ start, end }`, a half-open
range fixed for the run. Compose it with configured filters on every page; do
not substitute a moving lookback or guess a timestamp column. Return
`window: { ...ctx.window, axis: 'updated_at' }` using the declared timestamp,
`hasMore`, and the native `nextCursor` when more pages remain. Empty pages may
still have a cursor. Propagate missing metadata, provider failures and capacity
limits; they must never certify an exhausted window. A reader that cannot honor
these bounds must reject the request. Time-based reads cover the declared source
timestamp, not all possible edits, deletions or late imports.
