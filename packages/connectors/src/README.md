# Connector SDK

Connectors are TypeScript modules that sync data from external services into Lobu, read configured feeds directly from their source, and optionally execute write-back actions. Each connector has a `.ts` entry point whose default export is either a `defineConnector({ ... })` spec or a class extending `ConnectorRuntime` from `@lobu/connector-sdk`; the entry point may import sibling modules, which the compiler bundles. This document covers the SDK/runtime contract for bundled built-ins and child-process execution; the project-level authoring flow (`connectorFromFile` + `lobu apply`) is in `docs/connector-authoring.md`.

## Quick Start

```typescript
import {
  defineConnector,
  type EventEnvelope,
} from '@lobu/connector-sdk';

export default defineConnector({
  key: 'my_connector',
  name: 'My Connector',
  description: 'Fetches data from My Service.',
  version: '1.0.0',
  faviconDomain: 'example.com',
  authSchema: { methods: [{ type: 'none' }] },
  feeds: {
    items: {
      name: 'Items',
      description: 'Sync items from the service.',
      configSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
      },
      eventKinds: {
        item: {
          description: 'An item from the service',
          metadataSchema: {
            type: 'object',
            properties: {
              score: { type: 'number' },
            },
          },
        },
      },
      sync: async (ctx) => {
        const query = ctx.config.query as string;
        // Fetch data, transform to events...
        const events: EventEnvelope[] = [];

        return {
          events,
          checkpoint: { last_sync_at: new Date().toISOString() },
          metadata: { query, items_found: events.length },
        };
      },
    },
  },
});
```

## Connector Spec

The object passed to `defineConnector` declares connector metadata, auth,
handler-bearing feeds, actions, and optional connection-level handlers:

```typescript
interface ConnectorSpec {
  key: string;                              // Unique identifier (e.g. 'github', 'rss')
  name: string;                             // Display name
  description?: string;                     // What this connector does
  version: string;                          // Semver
  faviconDomain?: string;                   // Domain for favicon lookup (e.g. 'github.com')
  authSchema?: ConnectorAuthSchema;         // Authentication configuration
  feeds?: Record<string, ConnectorFeedSpec>; // Per-feed sync/read handlers
  actions?: Record<string, ConnectorActionSpec>; // Write-back handlers
  automationEvents?: ConnectorAutomationEvent[]; // Explicit Automation trigger catalog
  optionsSchema?: Record<string, unknown>;  // Global connector options (JSON Schema)
  mcpConfig?: { upstreamUrl: string };      // Proxy an upstream MCP server
  openapiConfig?: {                         // Generate actions from an OpenAPI spec
    specUrl: string;
    includeOperations?: string[];
    excludeOperations?: string[];
    includeTags?: string[];
    serverUrl?: string;
  };
  query?(ctx: QueryContext): Promise<QueryResult>; // Connection-level SQL/warehouse pushdown
}
```

### MCP Config

Set `mcpConfig` to proxy an upstream MCP server through Lobu. The connector acts as a bridge, exposing the MCP server's tools as connector actions. Useful for wrapping existing MCP servers with Lobu's auth, approval, and audit trail.

### OpenAPI Config

Set `openapiConfig` to auto-generate connector actions from an OpenAPI specification. The platform fetches the spec, filters operations by `includeOperations`/`excludeOperations`/`includeTags`, and exposes them as actions. Useful for REST APIs that already have OpenAPI docs.

## Authentication

The `authSchema.methods` array declares which auth methods your connector supports. Users configure credentials via auth profiles in the UI. A connector can support multiple methods (e.g. OAuth primary + env_keys fallback).

### `none` - No authentication

```typescript
authSchema: { methods: [{ type: 'none' }] }
```

### `env_keys` - API keys / tokens

```typescript
authSchema: {
  methods: [{
    type: 'env_keys',
    required: true,
    scope: 'connection',         // 'connection' (default) or 'organization'
    description: 'API key for authentication.',
    fields: [
      {
        key: 'API_KEY',          // Key name, accessed via ctx.config
        label: 'API Key',        // UI label
        description: 'Your service API key',
        example: 'sk-...',       // Placeholder hint
        secret: true,            // Mask in UI
        required: true,          // Whether this field is required
      },
    ],
  }],
}
```

When `scope` is `'organization'`, the auth profile is shared across all connections in the org. Default is `'connection'` (per-connection credentials).

### `oauth` - OAuth providers

```typescript
authSchema: {
  methods: [{
    type: 'oauth',
    provider: 'github',           // Built-in: github | google | reddit
    requiredScopes: ['repo', 'read:user'],
    required: false,              // Whether OAuth is mandatory or optional
    scope: 'connection',          // 'connection' or 'organization'
    description: 'Enables private repo access.',
    setupInstructions: 'Create an OAuth App at ... Set callback URL to {{redirect_uri}}.',
    // For custom OAuth providers (not built-in):
    authorizationUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientIdKey: 'EXAMPLE_CLIENT_ID',       // Env key for client ID
    clientSecretKey: 'EXAMPLE_CLIENT_SECRET', // Env key for client secret
  }],
}
```

The OAuth token is available at `ctx.credentials?.accessToken`. The full credentials shape:

```typescript
interface SyncCredentials {
  provider: string;              // e.g. 'github'
  accessToken: string;           // Opaque per-run placeholder for the OAuth access token (see below)
  refreshToken?: string | null;  // Never populated for a run (see below)
  expiresAt?: string | null;     // Token expiration (ISO string)
  scope?: string | null;         // Granted scopes
}
```

A run never receives a refresh token: the gateway refreshes tokens itself and
the wire contract carries the access token alone.

Send the token in a request header, the way `createHttpClient({ token })` and
`requireBearerClient` do. On the isolate lane `accessToken` is a
`lobu_secret_<uuid>` placeholder: the host swaps the real value back into the
header after the request passes the egress policy, so a token that reaches a
log, a checkpoint or an event is a handle that dies with the run. A placeholder
in a URL is refused before the request leaves (`EgressDenied`), and one in a
request body goes upstream verbatim (the provider rejects it). Over plain
`http:` it is resolved only for the run's own machine: a loopback or reserved
address the allowlist names exactly.

### Browser authentication

Browser connectors use the paired Chrome extension and its signed-in session.
Declare `{ type: 'none', label: 'Paired Chrome extension' }` when no separate
Lobu-stored credential is required, and call the extension bridge for browser
operations. Custom connectors that explicitly consume stored session cookies
may still declare `type: 'browser'` with `requiredDomains`; they own their
session authorization instructions.

## Feeds

Each feed is one configured data surface with a `sync` handler, a `read`
handler, or both. `defineConnector` derives the published `operations` metadata
from those handlers, so authors do not declare a separate mode:

```typescript
type ConnectorFeedSpec = {
  name: string;
  description?: string;
  displayNameTemplate?: string;   // "{repo_owner}/{repo_name} issues"
  configSchema?: object;          // JSON Schema for persisted feed-instance config
  userManaged?: boolean;          // Do not create automatically
  eventKinds?: Record<string, {   // Durable event types produced by sync
    description?: string;
    metadataSchema?: object;
  }>;
} & (
  | { sync: FeedSyncHandler; read?: FeedReadHandler }
  | { sync?: FeedSyncHandler; read: FeedReadHandler }
);
```

The record key becomes the feed key. A `sync` handler publishes
`operations: ['sync']`, a `read` handler publishes `['read']`, and defining both
publishes `['sync', 'read']`. Metadata-only device or MCP connector definitions
declare `operations` explicitly because their executable handlers live outside
the connector process.

`configSchema` describes the persisted feed instance, not one operation. Its
top-level `required` fields are therefore enforced for read-only, sync-only,
and hybrid feeds alike. If an input is optional for one handler, model that
optionality in the schema instead of relying on the feed's capabilities.

Capabilities and storage are independent. `sync` may materialize events for
local search and relational queries; `read` returns source-owned rows without
persisting them. Webhooks are a delivery path, not another feed mode.

```typescript
feeds: {
  issues: {
    name: 'Issues',
    configSchema: {
      type: 'object',
      required: ['project'],
      properties: { project: { type: 'string' } },
      additionalProperties: false,
    },
    eventKinds: {
      issue: { description: 'An issue changed' },
    },
    // Incremental materialization for local search and Automations.
    sync: async (ctx) => ({
      events: await fetchChangedIssues(ctx.config.project, ctx.checkpoint),
      checkpoint: { synced_at: new Date().toISOString() },
    }),
    // Direct source read with native filtering and pagination.
    read: async (ctx) => {
      const page = await queryIssues({
        project: ctx.config.project,
        query: ctx.query,
        cursor: ctx.cursor,
        limit: ctx.limit,
      });
      return { rows: page.rows, nextCursor: page.nextCursor };
    },
  },
}
```

A feed's `eventKinds` are also the **default Automation trigger catalog**. The first successful non-dry sync establishes a baseline without activation; later inserts whose kind matches a declared `eventKinds` key activate subscribers. A non-empty `automationEvents` declaration (camelCase in `ConnectorDefinition`, persisted as `automation_events` in the catalog) replaces that derived catalog in the trigger picker. Keys that differ from the feed's `eventKinds` fire only when the emitted `EventEnvelope` carries matching `automation_signals`.

## Syncing Data

The worker calls the selected feed's `sync` handler for scheduled,
webhook-triggered, and manually triggered sync runs. It receives a `SyncContext`
and returns a `SyncResult`.

### SyncContext

```typescript
interface SyncContext {
  feedKey: string;                          // Which feed to sync
  feedId?: number;                          // Stable configured feed-instance ID
  config: Record<string, unknown>;          // Feed + connector config merged
  checkpoint: Record<string, unknown> | null; // Previous checkpoint (null on first sync)
  credentials: SyncCredentials | null;      // OAuth/session credentials; env_keys are in config
  entityIds: number[];                      // Linked entity IDs
  sessionState?: Record<string, unknown>;   // Browser session state (cookies, tokens)
  emitEvents?: (events: EventEnvelope[]) => Promise<void>;      // Stream events mid-sync
  updateCheckpoint?: (cp: Record<string, unknown>) => Promise<void>; // Save progress mid-sync
}
```

### SyncResult

```typescript
interface SyncResult {
  events: EventEnvelope[];                  // Events to ingest
  checkpoint: Record<string, unknown> | null; // Updated checkpoint to persist
  auth_update?: Record<string, unknown>;    // Updated session state (browser cookies, etc.)
  metadata?: {
    items_found?: number;
    items_skipped?: number;
    [key: string]: unknown;
  };
}
```

### EventEnvelope

Each piece of content is an `EventEnvelope`:

```typescript
interface EventEnvelope {
  origin_id: string;           // Stable source-item ID, scoped to its feed/connection
  origin_type?: string;        // Source-native type (must match a key in eventKinds)
  payload_text: string;        // Main text content
  title?: string;              // Title / subject
  author_name?: string;        // Author
  source_url?: string;         // Link to original
  occurred_at: Date;           // When the content was created
  semantic_type?: string;      // Semantic type (e.g. 'content', 'note', 'summary', 'fact')
  score?: number;              // Engagement score (0-100)
  origin_parent_id?: string;   // Parent reference for threaded content
  metadata?: Record<string, unknown>; // Matches the eventKind's metadataSchema
  embedding?: number[];        // Pre-computed embedding vector (optional)
  automation_signals?: ConnectorAutomationSignalDraft[]; // Explicit Automation activations
}
```

### Checkpointing

Use checkpoints to implement incremental sync. Common patterns:

- **Timestamp-based**: Store `last_sync_at` and use it as a `since` filter on the next sync (see `github.ts`)
- **ID-based**: Store a list of seen IDs for deduplication, trimmed to a max size to prevent unbounded growth (see `rss.ts`)

For long-running syncs, use `ctx.emitEvents()` to stream event batches to the platform as they're collected, and `ctx.updateCheckpoint()` to persist progress. If the sync crashes mid-way, the next run resumes from the last saved checkpoint.

## Reading from the Source

The platform invokes a feed's `read` handler only through an explicit source
read such as `client.feeds.readMany`. Local `search_memory` does not call source
systems; its coverage result tells the agent which visible feeds it may choose
to read.

```typescript
interface FeedReadContext {
  feedId?: number;
  feedKey: string;
  query?: string;
  cursor?: string;                         // Opaque source continuation token
  config: Record<string, unknown>;
  credentials: SyncCredentials | null;
  sessionState?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

interface FeedReadResult {
  rows: Record<string, unknown>[];
  columns?: Array<{ name: string; type: string }>;
  total?: number;
  nextCursor?: string;
  hasMore?: boolean;
}
```

Push filtering, sorting, pagination, and SQL into the provider when it supports
them. A connection-level `query` handler remains a separate seam for governed
ad-hoc SQL and warehouse pushdown; configured feed reads belong on
`feeds[key].read`.

## Actions

Actions let connectors write back to external services (e.g. create a GitHub
issue). Define them in the `actions` record passed to `defineConnector`. The
record key becomes the action key and `requiresApproval` defaults to `false`:

```typescript
interface ConnectorActionSpec {
  name: string;                   // Display name
  description?: string;           // What this action does
  requiresApproval?: boolean;     // Whether user must approve before execution
  inputSchema?: object;           // JSON Schema for action input
  outputSchema?: object;          // JSON Schema for action output
  annotations?: {                 // MCP tool annotations for client-side UX
    destructiveHint?: boolean;    // Action deletes or modifies data irreversibly
    openWorldHint?: boolean;      // Action interacts with external systems
    idempotentHint?: boolean;     // Safe to retry without side effects
  };
  execute(ctx: ActionContext): Promise<ActionResult>;
}
```

Example:

```typescript
actions: {
  create_issue: {
    name: 'Create Issue',
    description: 'Create a new issue in the repository.',
    requiresApproval: true,
    annotations: {
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        issue_number: { type: 'integer' },
        url: { type: 'string' },
      },
    },
    execute: async (ctx) => {
      const result = await createIssue(ctx.input.title, ctx.input.body);
      return {
        success: true,
        output: { issue_number: result.number, url: result.url },
      };
    },
  },
}
```

If your connector doesn't support actions, omit the `actions` record entirely.

## Options Schema

The `optionsSchema` defines global connector-level configuration (JSON Schema) that applies across all feeds. This is typically a superset of the common fields shared across feeds. It powers the connection setup UI — when a user creates a new connection, they fill out a form generated from this schema.

## Engagement Scoring

The SDK exports `calculateEngagementScore()` for normalizing platform-specific engagement metrics to a 0-100 score:

```typescript
import { calculateEngagementScore } from '@lobu/connector-sdk';

const score = calculateEngagementScore('reddit', {
  score: 1500,       // Reddit karma (upvotes - downvotes)
  upvotes: 1600,
  downvotes: 100,
  reply_count: 42,
});
// => 15 (capped at 100)

const score2 = calculateEngagementScore('trustpilot', {
  rating: 4,         // Star rating (1-5)
  helpful_count: 10, // Helpful votes
});
// => 45 (rating * 10 + helpful * 0.5)
```

Signature:

```typescript
function calculateEngagementScore(
  connectorKey: string,
  engagementData: {
    score?: number;
    upvotes?: number;
    downvotes?: number;
    rating?: number;
    helpful_count?: number;
    reply_count?: number;
  }
): number; // 0-100
```

Platform-specific logic:
- **reddit**: `min(max(score, 0), 10000) / 100`
- **Rating-based** (reviews): `rating * 10 + helpful_count * 0.5`, capped at 100
- **Score-based** (default): `min(score, 100)`

## Browser-Based Connectors

Use `extensionDomScrape` or `extensionNetworkSync` from `@lobu/connector-sdk`.
They run through the paired Chrome extension on the connection's configured
device. Validate caller-provided URLs with `validateUrlDomain` or
`validatePublicUrl` before requesting browser work.

The standalone `@lobu/connector-sdk/browser` exports have been retired. A
connector must use the extension bridge for page and network operations.
Scrape-owned scratch tabs may be created and closed automatically; interactive
drafts wait for the user to visit their pending URL and are never auto-submitted.

## Worker Sandbox Environment

Connector code runs in a V8 isolate with an explicit capability boundary. Key things to know:

- **No ambient environment**: the guest sees only the explicit values in `job.env`, never the host environment. `WORKER_API_TOKEN` is deliberately excluded.
- **Credentials via ctx**: OAuth/session credentials flow through `ctx.credentials`; `env_keys` values are injected into `ctx.config`, and interactive auth receives `previousCredentials`.
- **No filesystem persistence**: Don't write to disk expecting it to survive between syncs. Use `checkpoint` for state.

## npm Dependencies

Declare npm dependencies at exact versions in the project/package `package.json`; the connector compiler resolves them from `node_modules` and bundles them:

```typescript
import TurndownService from 'turndown';
```

`npm:` specifiers are also accepted, but they resolve against the installed package; the `package.json` entry remains the authoritative version pin.

## Build & Installation

### Generating the catalog

Build the workspace packages first so the generator can resolve the shared connector compiler:

```bash
make build-packages
```

The server build generates all catalog manifests. Once the shared packages are already built, rerun only that generator with `bun packages/server/scripts/build-catalog-manifests.ts`. Its connector pass compiles each `.ts` file in this directory via esbuild, extracts the `definition` metadata, and writes `packages/server/dist/catalogs/connectors.json`. The connector manifest is a metadata-only index — it does not contain compiled code — and the runtime loads configured manifests through `LOBU_CATALOG_URIS`.

### Project-local custom connectors

A project authors its own connector at `connectors/<name>.connector.ts` and registers it in `lobu.config.ts` with `connectorFromFile("./connectors/<name>.connector.ts")`. `lobu apply` compiles it with the project's dependencies and installs the resulting bundle in the target organization; model it on `examples/lobu-crm/npm-downloads.connector.ts`. See `docs/connector-authoring.md`.

### Auto-install per org

Connectors are **not** pre-installed globally. When an org first uses a connector, `ensureConnectorInstalled()` checks if the org already has it. If not, it:

1. Reads the `.ts` source from `connectors/` on disk
2. Compiles it temporarily via esbuild to extract metadata (key, name, feeds, etc.)
3. Stores the metadata in `connector_definitions` scoped to that org
4. Stores a `source_path` reference (e.g. `github.ts`) in `connector_versions` — **compiled code is NOT stored**

Connectors can also be installed manually via `client.connections.installConnector(...)` from inside an `execute` script (or the equivalent admin REST endpoint), passing a `connector_id`, `source_url`/`source_uri`, inline `source_code`, or `mcp_url`. Manual installs store compiled code in the database as before. Agents drive the full validate → install → test → iterate loop through `manage_connections`; see `docs/connector-authoring.md` ("The MCP loop").

### How connector code runs

1. For fleet workers and embedded-mode hosts (worker + gateway share a host), the gateway sends only `connector_key` in the worker-poll response — both runtimes have the `.ts` source on disk, and the worker compiles locally via the shared pipeline at `@lobu/connector-worker/compile`. For DB-only / device workers without source on disk, the gateway sends `compiled_code` inline.
2. The bundle is self-contained — the SDK and every pure-JS dependency are inlined — and is evaluated inside a V8 isolate in the worker process. The isolate has no module loader, so a bundle that still `require()`s a Node builtin is rejected before it runs.
3. Host and guest speak the SDK shapes (`SyncContext` / `ActionContext` / `AuthContext` in, `SyncResult` / `ActionResult` / `AuthResult` out, no envelope) across named host capabilities. Sync events stream up as the connector emits them.
4. `IsolateExecutor` defaults to a 10-minute wall clock and a 512 MB heap for every run; interactive auth runs disable the fixed timeout while waiting for the user.
5. The guest has no filesystem, no ambient environment, and no socket of its own: everything it can reach is a named capability the host granted — `fetch` and, for the DB connectors, a host-dialled TCP socket — plus the explicit values supplied in `job.env`.
6. Connection credentials and config flow through the typed job context (`ctx.credentials`, `ctx.config`, or auth's `previousCredentials`). The worker API token is never forwarded to connector code. `ctx.credentials.accessToken` is a per-run placeholder the host resolves at the wire (see "`oauth` - OAuth providers" above); `ctx.config` and `previousCredentials` still carry real values.

For source-backed bundled connectors, the worker recompiles a `.ts` file after its mtime changes. Built deployments still require rebuild/redeploy, while project-local connector changes require another `lobu apply` to install a new organization-scoped version.

## Existing Connectors

| Connector | Auth | Feeds | Actions |
|-----------|------|-------|---------|
| `github` | app_installation/oauth/env_keys | issues, PRs, comments, discussions, commits, stargazers | create/comment/close/reopen issues; create/merge PRs |
| `hackernews` | none | stories, front page, comments | - |
| `market.quotes` | none | - | quote (read-only, quotes returned to the caller, never persisted) |
| `producthunt` | env_keys | posts & comments | - |
| `reddit` | oauth/none | posts, comments, user activity | - |
| `rss` | none | articles | - |
| `x` | browser/oauth | tweets, own posts, likes, bookmarks, DMs, home timeline | prepare reply |
| `youtube` | oauth (Google) | liked videos, playlists, subscriptions, videos | search, get_video, search_liked_videos, list_playlists, get_playlist |
