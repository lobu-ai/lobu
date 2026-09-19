/**
 * Workspace Instructions Builder
 *
 * Generates managed-agent instructions with workspace schema and operating
 * guidance, or a static capability description for direct MCP clients. All
 * entity-level data comes from tool calls at runtime, not from instructions.
 */

import { getDb } from '../db/client';
import logger from './logger';
import { loadOrgGuidanceBlock } from './org-guidance';
import { ACL_MANAGED_TYPE_SQL } from './relationship-validation';

/** Collapse whitespace/newlines so an authored description stays one line. */
function singleLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

const INTERNAL_AUTOMATION_SCHEMA_FIELDS = new Set([
  'acting_automation_id',
  'analyzed_by_automation_id',
  'exclude_automation_id',
  'source_automation_id',
  'automation_id',
  'automation_ids',
]);

function isInternalAutomationSchemaField(field: string): boolean {
  return INTERNAL_AUTOMATION_SCHEMA_FIELDS.has(field.toLowerCase());
}

/**
 * Render a metadata schema's fields as a compact `name (description)` list.
 * Accepts both a real JSON Schema (descends into `.properties` — the old
 * render printed the envelope keys "type, properties" instead) and a legacy
 * bare field map. Field descriptions are authored schema — surface them.
 */
function renderSchemaFields(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  const s = schema as Record<string, unknown>;
  let props: Record<string, unknown> | null = null;
  if (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) {
    props = s.properties as Record<string, unknown>;
  } else if (typeof s.type !== 'string') {
    // Legacy shape: the schema IS the field map.
    props = s;
  }
  if (!props) return '';
  return Object.entries(props)
    .filter(([field]) => !isInternalAutomationSchemaField(field))
    .map(([field, def]) => {
      const desc = singleLine((def as Record<string, unknown> | null)?.description);
      return desc ? `${field} (${desc})` : field;
    })
    .join(', ');
}

export type WorkspaceInstructionAudience = 'managed-agent' | 'direct-mcp';

const DIRECT_MCP_INSTRUCTIONS = [
  '## Lobu — Workspace Memory',
  '',
  "Lobu provides access to persistent workspace memory. Use Lobu's tools only when they are relevant to the user's request.",
  '',
  '### Read tools',
  '- `search_memory` searches saved workspace memory.',
  '- On a multi-workspace grant, `search_memory` accepts a singular `workspace` argument to narrow to one of the granted workspaces; every other tool stays in the current workspace.',
  '- `search_sdk` discovers documented SDK methods and connector capabilities.',
  '- `query_sdk` runs capability-scoped, read-only TypeScript.',
  '- `query_sql` runs member-safe, read-only SQL.',
  '- Use read tools to discover workspace-specific schema and capabilities instead of assuming they exist.',
  '',
  '### Writes and approvals',
  '- `save_memory` stores a requested fact or note. Use it only when the user asks to remember or save information, or explicitly confirms a proposed save.',
  '- `run_sdk` can create, update, or delete workspace data and can invoke connector operations. Use it only for a user-requested action; use `query_sdk` for reads and `dry_run=true` to preview supported writes.',
  '- For connector operations, treat `operation_key` as an opaque manifest identifier: copy it exactly from `operations.listAvailable` and never derive it from the display name. If no returned operation matches, refresh discovery instead of inventing a key.',
  '- A policy-gated operation returns `status: "pending_approval"` and a `run_id`. Call `get_approval` with that run id to show the canonical review card. Treat a pending operation as waiting, not failed.',
  '- Do not infer permission to store conversation details, preferences, personal information, relationships, or files merely because they were mentioned.',
  '- Do not request, expose, or return authentication secrets.',
].join('\n');

export async function buildWorkspaceInstructions(
  organizationId: string,
  options: { audience?: WorkspaceInstructionAudience } = {}
): Promise<string | null> {
  // Preserve the historical managed-agent prompt by default for internal
  // callers. Direct MCP sessions get an entirely static, directory-safe
  // capability description. Workspace-authored schema, connector descriptions,
  // and guidance are discoverable through explicit read tools instead of being
  // injected into an unrelated host's prompt.
  const managedAgent = options.audience !== 'direct-mcp';
  if (!managedAgent) return DIRECT_MCP_INSTRUCTIONS;

  const sql = getDb();

  try {
    // Entity/relationship COUNTS are deliberately excluded: this block is part
    // of the cached system prompt, and live counts would mutate it on every
    // memory write, busting the prompt cache (and all downstream message
    // history) on each context refresh. Only stable schema belongs here; the
    // agent gets live counts from tool calls at runtime. (Org guidance below
    // also qualifies: admin-authored text that only mutates on explicit edit.)
    const [entityTypeRows, relationshipTypes, orgGuidance] = await Promise.all([
      sql.unsafe(
        `SELECT slug, name, description, metadata_schema, event_kinds FROM entity_types
         WHERE deleted_at IS NULL
           AND organization_id = $1
         ORDER BY name ASC`,
        [organizationId]
      ),
      // `acl_managed` reuses the mutation guard's own predicate rather than a
      // second copy of it: `link`/`unlink` refuse these types through
      // assertNotAclManagedEdge, which is purpose-OR-slug, so a purpose-only
      // test here would still promise the agent a write it cannot make during
      // the window between a config declaring `member_of` and the first ACL
      // sync classifying it.
      sql.unsafe(
        `SELECT rt.slug, rt.name, rt.description, rt.is_symmetric, inv.slug as inverse_type_slug,
                ${ACL_MANAGED_TYPE_SQL} AS acl_managed
         FROM entity_relationship_types rt
         LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
         WHERE rt.status = 'active'
           AND rt.deleted_at IS NULL
           AND rt.organization_id = $1
         ORDER BY rt.name ASC`,
        [organizationId]
      ),
      loadOrgGuidanceBlock(organizationId),
    ]);

    const entityTypeLines = entityTypeRows.map((et: any) => {
      const desc = singleLine(et.description);
      const fields = renderSchemaFields(et.metadata_schema);
      return `- ${et.slug} ("${et.name}")${desc ? ` — ${desc}` : ''}${fields ? ` — fields: ${fields}` : ''}`;
    });

    // An inverse pair renders as one line, but `acl_managed` is decided per
    // type, so the halves can disagree: pairing is only refused against an
    // ALREADY-classified type, and classification later sets `purpose` without
    // touching `inverse_type_id`, so it lands on one half of a live pair.
    // Collapsing regardless drops whichever half loses the name ordering, and
    // when that is the ACL-managed half the agent never learns the slug exists,
    // let alone that writing it 403s. So collapse a pair only when both halves
    // carry the same rule. A slug not yet emitted maps to `undefined`, which
    // never equals a boolean — that is what keeps the first half of a pair (and
    // a type whose inverse is inactive, hence absent here) from skipping itself.
    const emittedRelAclManaged = new Map<string, boolean>();
    const relTypeLines: string[] = [];
    for (const rt of relationshipTypes) {
      const slug = rt.slug as string;
      const inverseSlug = rt.inverse_type_slug as string | null;
      const aclManaged = Boolean(rt.acl_managed);
      if (inverseSlug && emittedRelAclManaged.get(inverseSlug) === aclManaged) continue;
      emittedRelAclManaged.set(slug, aclManaged);
      const parts: string[] = [];
      if (rt.is_symmetric) parts.push('symmetric');
      if (inverseSlug) parts.push(`inverse: ${inverseSlug}`);
      // Annotated rather than filtered out: reading these edges is legitimate,
      // so hiding the type would blind the agent to real schema. Only the WRITE
      // is refused, so say exactly that.
      if (aclManaged) parts.push('read-only: access control');
      const meta = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      const desc = singleLine(rt.description);
      relTypeLines.push(`- ${slug}${meta}${desc ? ` — ${desc}` : ''}`);
    }

    // Assemble
    const sections: string[] = [
      '## Lobu — Your Persistent Memory',
      '',
      "You have persistent memory. Use it proactively — don't wait to be asked.",
      '',
      "When asked about workspace data — including people, leads, companies, connections, feeds, runs, or counts — query it before answering. On a direct bare OAuth connection, `search_memory` searches every currently accessible workspace the user granted and can be narrowed with its singular `workspace` argument; pinned connections and all other tools stay in the current workspace. Use `query_sdk` or `query_sql` for structured lookups and counts. Do not claim you can see only chat/Slack messages or channel members without querying workspace data first.",
    ];

    // Org-wide admin-authored context is agent policy, not MCP capability
    // documentation. It belongs in managed-agent prompts only; returning it to
    // a directory client would let tenant content steer an unrelated host.
    if (orgGuidance) {
      sections.push(
        '',
        '### Organization Context',
        'Org-wide guidance authored by workspace admins (event kind `guidance`; admins edit it via save_memory with supersedes_event_id).',
        orgGuidance
      );
    }

    if (entityTypeLines.length > 0) {
      sections.push('', '### Schema: Entity Types', ...entityTypeLines);
    }

    // Event kinds per entity type (only for types that define them)
    for (const et of entityTypeRows) {
      const eventKinds = et.event_kinds as Record<
        string,
        { description?: string; metadataSchema?: Record<string, unknown> }
      > | null;
      if (!eventKinds || typeof eventKinds !== 'object') continue;
      const kindEntries = Object.entries(eventKinds);
      if (kindEntries.length === 0) continue;

      const kindLines = kindEntries.map(([kind, def]) => {
        const desc = singleLine(def.description);
        const metaFields = def.metadataSchema?.properties
          ? Object.keys(def.metadataSchema.properties as Record<string, unknown>)
              .filter((field) => !isInternalAutomationSchemaField(field))
              .join(', ')
          : '';
        const parts = [desc, metaFields ? `metadata: ${metaFields}` : '']
          .filter(Boolean)
          .join(' — ');
        return `- ${kind}${parts ? ` — ${parts}` : ''}`;
      });
      sections.push(
        '',
        `### Event Semantic Types: ${et.slug}`,
        `Use these as the \`semantic_type\` parameter in save_memory for ${et.slug} entities.`,
        ...kindLines
      );
    }

    if (relTypeLines.length > 0) {
      sections.push('', '### Schema: Relationship Types', ...relTypeLines);
    }

    const operationConnections = await sql`
      SELECT DISTINCT ON (cd.key)
        cd.key,
        cd.name,
        cd.description,
        cd.actions_schema,
        cd.mcp_config,
        cd.openapi_config
      FROM connector_definitions cd
      WHERE cd.status = 'active'
        AND cd.organization_id = ${organizationId}
        AND (
          cd.actions_schema IS NOT NULL
          OR cd.mcp_config IS NOT NULL
          OR cd.openapi_config IS NOT NULL
        )
      ORDER BY cd.key
    `;

    if (operationConnections.length > 0) {
      sections.push(
        '',
        '### Connector Operations',
        // One path only: `run_sdk` → `client.operations.execute(...)` with the
        // REAL SDK signature (connection_id + operation_key — see
        // sandbox/namespaces/operations.ts). Deliberately NOT surfacing the
        // local/mcp/openapi backend split — that is internal plumbing
        // `execute` dispatches on, and showing it invites the agent to look
        // for a separate MCP/HTTP tool that does not exist.
        'Run any connector operation the same way: `run_sdk` → `client.operations.execute({ connection_id, operation_key, input })`. There is no separate per-connector tool.',
        'Discover capabilities with `query_sdk` → `client.operations.listAvailable({ query: "..." })`. It includes disconnected connectors, readiness, and every visible `execution_targets` entry; use the returned target directly instead of guessing a connection id.',
        'Treat `operation_key` as an opaque manifest identifier: copy it exactly from `operations.listAvailable` and reuse it unchanged in `operations.execute`. Never derive it from an operation display name (for example, a display name like "Check permissions" may have the manifest key `permissions`, not `check_permissions`). If no returned operation matches the requested display name, stop and refresh discovery instead of inventing a key.',
        'When readiness is disconnected, call the returned `next_action`. `connections.connect` / `connections.create` may return `status: "setup_required"`: show its resolved setup/install URL, follow `next_action`, then invoke `resume_call` or poll `completion_check` exactly as returned. When the result carries `self_install_url` (e.g. a Slack app when no hosted app is configured), offer that deep link to the user to create and install their own app and paste back the bot token / signing secret.',
        'When an existing operation or feed reports `setup_required`, show its `reason` / `attention_reason`, ask the user to finish setup on the paired device, then retry the original call. Do not repeatedly retry while setup is still required.',
        'Execution may be policy-gated: a gated op returns `status: "pending_approval"` and a `run_id` queued for a human. Call `get_approval` with that run id to show the canonical review card; treat it as waiting, not failed.'
      );
      for (const conn of operationConnections) {
        const localOps =
          conn.actions_schema && typeof conn.actions_schema === 'object'
            ? Object.keys(conn.actions_schema as Record<string, unknown>)
            : [];
        const hasMcp = !!conn.mcp_config;
        const hasOpenApi = !!conn.openapi_config;
        if (localOps.length === 0 && !hasMcp && !hasOpenApi) continue;
        // Prefer showing concrete operation names; fall back to a discovery
        // pointer when the ops live behind mcp/openapi backends (whose names
        // aren't in actions_schema — list_available resolves them).
        const detail =
          localOps.length > 0
            ? localOps.join(', ')
            : 'operations via `client.operations.listAvailable()`';
        const desc = singleLine(conn.description);
        sections.push(`- ${conn.key}${desc ? ` (${desc})` : ''}: ${detail}`);
      }
    }

    sections.push(
      '',
      '### Tool surface',
      'External MCP tools: `search_memory`, `save_memory`, `search_sdk` (SDK method + connector discovery — pass mode=read for query_sdk methods), `query_sdk` (read-only TS), `query_sql` (paginated SQL for all members), `run_sdk` (full TS writes). Discover with `search_sdk`, then act via `query_sdk` / `run_sdk`. Prefer `client.metrics.*` for governed metrics.',
      '### Connecting a data source (do NOT assume a source is unsupported — enumerate first)',
      'A connector may be INSTALLED for this org yet absent from the global catalog, so always check installed connectors before concluding a source is unsupported:',
      '- Find the connector: `search_sdk` with the source/topic word (e.g. "website", "slack") returns any matching live connector + its feed keys + lifecycle. Or list them: `query_sdk` → `client.catalog.listInstalled({ kinds: ["connectors"] })` (installed = ready to configure; each item\'s `detail.feeds_schema` keys are the feed_key values) and `client.catalog.listCatalog({ kinds: ["connectors"] })` (global, installable) and `client.connections.list()` (already configured).',
      '- Lifecycle: `run_sdk` → `client.connections.connect({ connector_key })` → `client.feeds.create({ connection_id, feed_key, config })` → `client.feeds.trigger({ feed_id })`; then verify with `query_sql` on the events table and search with `search_memory`.',
      'For reads beyond search_memory, prefer `query_sdk` with a TS script. For writes (entity CRUD, Automations, classifiers, connections, feeds, view templates, operations), use `run_sdk`. Use `search_sdk` to discover method names.',
      '### Returning a result the user can read',
      'The script return value IS the card the user sees. Write it for a person, not for your own bookkeeping:',
      '- Pass `title` on the call — a short heading for what this result is (e.g. "Companies missing a domain"). Without it the card has no subject line.',
      '- Return a bounded sample with the total, not only a bare count. `{ connections: 8 }` renders just the number 8; `{ total: 8, rows: [{ name: "Slack", state: "ok" }, ...] }` gives the user a sortable, expandable table.',
      '- Report what you wrote. A write loop that discards each result renders as "No return value." Collect save receipts under `events`; each receipt shows its title, type, and link, with extra fields expandable. For large batches, return a sample plus the total, since an oversized return is replaced by a truncated preview.',
      '- Use the collection keys `entities`, `events`, or `rows` when the result is a list of those; they get purpose-built rendering (tables, links, per-row detail) that an arbitrary key does not.',
      '- Say what an empty result means. `{ entities: [] }` alone is indistinguishable from a broken query — add a sibling `note` such as "all 24 companies already have a domain" so the user can tell a clean answer from a bug.',
      '',
      '### Saving (do this automatically)',
      'When the user shares any of these, save immediately:',
      '- Preferences, opinions, or personal details → `save_memory` to matching entity (create the entity first via `run_sdk({script: "client.entities.create(...)"})` if needed)',
      '- Facts about people, projects, or topics → `save_memory` to the relevant entity',
      '- Relationships between things → `run_sdk` calling `client.entities.link({...})`',
      '',
      "### Updating Facts (supersede, don't duplicate)",
      'When a fact changes (e.g. updated preference, corrected info):',
      '1. Search for the existing fact via `search_memory` or `query_sdk({script: "client.knowledge.read({...})"})`',
      '2. Save the updated fact with `supersedes_event_id` pointing to the old one in `save_memory`',
      'The old fact is automatically hidden from future searches. Never save a duplicate — always search first.',
      '',
      '### Recalling',
      '- Always search before creating to avoid duplicates',
      '- `search_memory(query=…, entity_type=…)` to find entities + semantic content matches; on a bare OAuth connection omit `workspace` to search all currently accessible granted workspaces, or pass one returned workspace slug to narrow',
      '- `query_sdk({script: "client.entities.listLinks({entity_id: ...})"})` to explore relationships',
      '',
      '### Full schema details',
      '- `query_sdk({script: "client.entitySchema.listTypes()"})` for entity types',
      '- `query_sdk({script: "client.entitySchema.listRelTypes()"})` for relationship types and rules'
    );

    return sections.join('\n');
  } catch (err) {
    logger.warn({ err, organizationId }, 'Failed to build workspace instructions');
    return null;
  }
}
