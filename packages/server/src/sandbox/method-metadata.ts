/**
 * ClientSDK method metadata, keyed by dotted path. Drives the `search_sdk` MCP
 * tool, the read-only SDK filter (`access`), and the BANNED_PATHS guard.
 */

export type MethodAccess = "read" | "write" | "external" | "admin";

/**
 * A side effect and an authorization tier are different facts.
 *
 * `external` is a side-effect marker (this method calls out to an external
 * system), not a tier. It keeps a method write-VISIBLE so an owner/admin can
 * trigger the progressive mcp:admin OAuth challenge by calling it — but the
 * tier REPORTED to callers must match what the delegated `manage_*` action
 * actually enforces, or an admin-enforced method advertises "operate
 * (mcp:write)" and sends an mcp:write caller to retry into a hard
 * "requires an MCP session with admin access." dead end.
 *
 * So `external` must pair with the tier `getRequiredAccessLevel` returns for
 * its underlying action, and a plain tier must not carry a contradictory
 * override. access-model-cross-check.test.ts pins each value against the live
 * tier map; visibility is unchanged either way.
 */
export type MethodAccessMetadata =
	| { access: "external"; enforcedTier: Exclude<MethodAccess, "external"> }
	| { access: Exclude<MethodAccess, "external">; enforcedTier?: never };

/** The same required tier drives discovery and dry-run previews. */
export function requiredSdkAccess(metadata: MethodAccessMetadata): Exclude<MethodAccess, "external"> {
	if (metadata.access !== "external") return metadata.access;
	if (!metadata.enforcedTier) throw new Error("External SDK method has no enforced tier");
	return metadata.enforcedTier;
}

export type MethodMetadata = MethodAccessMetadata & {
	summary: string;
	/** Exact callable signature when the method shape is easy to misinfer. */
	signature?: string;
	throws?: readonly string[];
	/** Single-line copy-pasteable snippet. */
	example?: string;
	/** Multi-line example surfaced by `search_sdk` for hot-path methods. */
	usageExample?: string;
	/** Cost hint: 'cheap' | 'normal' | 'expensive'. Normal if omitted. */
	cost?: "cheap" | "normal" | "expensive";
};

/** Runtime helpers passed through `ctx`, not dispatchable ClientSDK methods. */
export const RUNTIME_HELPER_METADATA: Record<string, MethodMetadata> = {
	"ctx.sleep": {
		summary:
			"Pause a sandbox script for 0–30000ms. The wait aborts at the script's overall timeout; use it between SDK reads when polling.",
		access: "read",
		example: "await ctx.sleep(1000);",
		usageExample: `// Poll a run without exposing unrestricted timer globals.
export default async (ctx, client) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const run = await client.operations.getRun(123);
    if (run.status !== 'pending') return run;
    await ctx.sleep(1000);
  }
  throw new Error('Run did not finish in time');
};`,
	},
};

export const METHOD_METADATA: Record<string, MethodMetadata> = {
	// organizations
	"organizations.list": {
		summary:
			"List organizations the authenticated user belongs to, plus public orgs they can read. Public managed-OAuth providers carry structured managed_auth metadata with connector keys, the connect method, consent/login requirements, and the local bootstrap command.",
		access: "read",
		example: "const orgs = await client.organizations.list();",
	},
	"organizations.current": {
		summary: "Return the selected workspace, or null on an account client before client.org(target).",
		access: "read",
		example: "const org = await client.organizations.current();",
	},

	// devices
	"devices.list": {
		summary:
			"List the caller's own registered devices, most-recently-seen first. Each carries the `id` that `automations.device_worker_id` and `connections.device_worker_id` take when pinning work to a machine, plus `agent_kinds` (which agent CLIs it advertised — null means it never advertised, so the Automation lane leaves it unrestricted), `capabilities`, `online`, and the workspace it is attached to. Owner-scoped: devices are user-owned, so this never lists a colleague's machines.",
		access: "read",
		example: "const devices = await client.devices.list();",
	},

	// entities
	"entities.manage": {
		summary: "Raw manage_entity action wrapper. Prefer named methods.",
		access: "admin",
	},
	"entities.list": {
		summary:
			"List entities in the current organization with optional filters. Returns `{ action, entities, metadata }` where `entities` is the page and `metadata` carries `total_count`, `has_more`, `limit`, `offset`.",
		access: "read",
		signature:
			"entities.list(input?: { entity_type?: string; parent_id?: number; search?: string; category?: string; main_market?: string; market?: string; limit?: number; offset?: number; sort_by?: string; sort_order?: 'asc' | 'desc' }): Promise<unknown>",
		example:
			"const { entities } = await client.entities.list({ entity_type: 'company' });",
		usageExample: `// All companies in the workspace, newest first.
export default async (_ctx, client) => {
  const { entities, metadata } = await client.entities.list({
    entity_type: 'company',
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  return { count: metadata.total_count, page: entities };
};`,
	},
	"entities.get": {
		summary: "Fetch a single entity by id.",
		access: "read",
		signature:
			"entities.get(input: { entity_id: number; include_deleted?: boolean }): Promise<unknown>",
		throws: ["EntityNotFound"],
		example: "const entity = await client.entities.get({ entity_id: 42 });",
		usageExample: `export default async (_ctx, client) => {
  const entity = await client.entities.get({ entity_id: 42 });
  return { id: entity.id, name: entity.name, type: entity.entity_type };
};`,
	},
	"entities.create": {
		summary:
			"Create an entity of a given type. The entity TYPE must exist first — if the type is new to this workspace, call `entitySchema.createType` before this (an unknown type fails with \"Unknown entity type '<slug>'\", surfaced as a ValidationError). Check `entitySchema.listTypes()` for existing types.",
		access: "write",
		throws: ["ValidationError"],
		example:
			"await client.entities.create({ entity_type: 'company', name: 'Acme', metadata: {} });",
		usageExample: `// Two-hop: ensure the entity type exists, THEN create the entity.
// A first-of-its-kind type must be created before any entity of it.
export default async (_ctx, client) => {
  const { entity_types } = await client.entitySchema.listTypes();
  if (!entity_types.some((t) => t.slug === 'company')) {
    try {
      await client.entitySchema.createType({
        slug: 'company',
        name: 'Company',
        metadata_schema: { type: 'object', properties: { team_size: { type: 'number' } } },
      });
    } catch (e) {
      // A concurrent caller may have created it first — the coded 409 is safe.
      if (!/entity_type_exists/.test(String(e && e.message))) throw e;
    }
  }
  return client.entities.create({
    entity_type: 'company',
    name: 'Acme',
    metadata: { team_size: 50 },
  });
};`,
	},
	"entities.update": {
		summary: "Update an existing entity.",
		access: "write",
	},
	"entities.delete": {
		summary:
			"Delete an entity. force_delete_tree hard-deletes the whole descendant tree (event history is kept, only detached); dry_run previews what would be removed/detached without mutating.",
		access: "admin",
		signature:
			"entities.delete(input: { entity_id: number; force_delete_tree?: boolean; dry_run?: boolean }): Promise<unknown>",
		example:
			"await client.entities.delete({ entity_id: 42, force_delete_tree: true, dry_run: true });",
	},
	"entities.link": {
		summary:
			"Create a relationship between two entities. Needs the two entity IDs AND a relationship TYPE that already exists — if the relationship type is new, call `entitySchema.createRelType` first; list existing ones with `entitySchema.listRelTypes()`. (`entitySchema.addRule` does NOT create a type; it restricts the allowed source/target entity-type pairs on a type that already exists.)",
		access: "write",
		signature:
			"entities.link(input: { from_entity_id: number; to_entity_id: number; relationship_type_slug: string; source?: 'ui' | 'llm' | 'feed' | 'api'; confidence?: number; metadata?: object }): Promise<unknown>",
		example:
			"await client.entities.link({ from_entity_id: 42, to_entity_id: 43, relationship_type_slug: 'customer_of' });",
		usageExample: `// Two-hop: the relationship TYPE must exist before linking. Ensure it
// (entitySchema.listRelTypes → createRelType), then resolve the two entity
// ids (entities.list / .get) and link. If a concurrent caller already created
// the type, createRelType returns a coded 409 ([relationship_type_exists]) —
// safe to ignore, the type is present either way.
export default async (_ctx, client) => {
  const { relationship_types } = await client.entitySchema.listRelTypes();
  if (!relationship_types.some((t) => t.slug === 'works_at')) {
    try {
      await client.entitySchema.createRelType({ slug: 'works_at', name: 'Works at' });
    } catch (e) {
      if (!/relationship_type_exists/.test(String(e && e.message))) throw e;
    }
  }
  const { entities: companies } = await client.entities.list({ entity_type: 'company', search: 'Acme' });
  const { entities: people } = await client.entities.list({ entity_type: 'person', search: 'Jane' });
  return client.entities.link({
    from_entity_id: people[0].id,
    to_entity_id: companies[0].id,
    relationship_type_slug: 'works_at',
  });
};`,
	},
	"entities.unlink": {
		summary: "Soft-delete an entity relationship.",
		access: "write",
	},
	"entities.updateLink": {
		summary: "Update metadata / confidence on an existing relationship.",
		access: "write",
	},
	"entities.listLinks": {
		summary: "List relationships for an entity.",
		access: "read",
		signature:
			"entities.listLinks(input: { entity_id: number; direction?: 'outbound' | 'inbound' | 'both'; relationship_type_slug?: string; source?: 'ui' | 'llm' | 'feed' | 'api'; confidence_min?: number; include_deleted?: boolean; limit?: number; offset?: number }): Promise<unknown>",
	},
	"entities.search": {
		summary:
			"Fuzzy search entities by name. POSITIONAL signature: search(query: string, options?: { limit?: number }). The query is the first positional argument — passing an object like { query: '...' } throws (the handler calls query.slice).",
		access: "read",
		example: "const hits = await client.entities.search('acme', { limit: 5 });",
		usageExample: `// Resolve a free-text mention into entity ids before linking knowledge to it.
// First arg is the query string; second is options. Do NOT pass { query }.
export default async (_ctx, client) => {
  return client.entities.search('Acme', { limit: 5 });
};`,
	},

	// entitySchema
	"entitySchema.manage": {
		summary: "Raw manage_entity_schema action wrapper. Prefer named methods.",
		access: "admin",
	},
	"entitySchema.listTypes": {
		summary:
			"List entity types. Defaults to accessible (current org plus public schemas); pass list_scope: 'organization' for only the bound org.",
		access: "read",
		signature:
			"entitySchema.listTypes(input?: { list_scope?: 'accessible' | 'organization' }): Promise<unknown>",
	},
	"entitySchema.getType": {
		summary:
			"Get an entity type by slug. A missing type resolves rather than throwing: check the nullable `entity_type` field to determine whether the type exists — do not truth-test the wrapper, which is always present.",
		access: "read",
		signature:
			"entitySchema.getType(slug: string): Promise<unknown> // or entitySchema.getType({ slug })",
		example:
			"const { entity_type } = await client.entitySchema.getType('company'); // null when absent",
	},
	"entitySchema.createType": {
		summary:
			"Create an entity type through the workspace write policy. The result is applied, pending_approval, or denied. The metadata shape goes in `metadata_schema` (a JSON Schema), NOT top-level `properties`.",
		access: "admin",
		example:
			"await client.entitySchema.createType({ slug: 'widget', name: 'Widget', metadata_schema: { type: 'object', properties: { color: { type: 'string' } } } });",
	},
	"entitySchema.updateType": {
		summary:
			"Update an entity type. An event_kinds object replaces the entire registry; call getType and read-merge-write to preserve existing kinds. Use null to clear or omit to leave unchanged.",
		access: "admin",
	},
	"entitySchema.deleteType": {
		summary: "Delete an entity type.",
		access: "admin",
		example: "await client.entitySchema.deleteType({ slug: 'widget' });",
	},
	"entitySchema.auditType": {
		summary: "List historical changes to an entity type.",
		access: "read",
		signature:
			"entitySchema.auditType(slug: string): Promise<unknown> // or entitySchema.auditType({ slug })",
		example: "const audit = await client.entitySchema.auditType('company');",
	},
	"entitySchema.listRelTypes": {
		summary:
			"List relationship types. Defaults to accessible (current org plus public schemas); pass list_scope: 'organization' for only the bound org.",
		access: "read",
		signature:
			"entitySchema.listRelTypes(input?: { list_scope?: 'accessible' | 'organization' }): Promise<unknown>",
	},
	"entitySchema.getRelType": {
		summary:
			"Get a relationship type by slug. A missing type resolves rather than throwing: check the nullable `relationship_type` field to determine whether the type exists — do not truth-test the wrapper, which is always present.",
		access: "read",
		signature:
			"entitySchema.getRelType(slug: string): Promise<unknown> // or entitySchema.getRelType({ slug })",
		example:
			"const { relationship_type } = await client.entitySchema.getRelType('works-at'); // null when absent",
	},
	"entitySchema.createRelType": {
		summary: "Create a relationship type.",
		access: "admin",
	},
	"entitySchema.updateRelType": {
		summary: "Update a relationship type.",
		access: "admin",
	},
	"entitySchema.deleteRelType": {
		summary: "Delete a relationship type.",
		access: "admin",
		example: "await client.entitySchema.deleteRelType({ slug: 'works-at' });",
	},
	"entitySchema.addRule": {
		summary:
			"Add an allowed source/target entity-type rule to a relationship type.",
		access: "admin",
	},
	"entitySchema.removeRule": {
		summary: "Remove a rule from a relationship type.",
		access: "admin",
	},
	"entitySchema.listRules": {
		summary: "List rules attached to a relationship type.",
		access: "read",
		example:
			"const rules = await client.entitySchema.listRules({ slug: 'works-at' });",
	},

	// knowledge
	"knowledge.search": {
		summary: "Semantic + structured search over stored knowledge events.",
		access: "read",
		example:
			"const hits = await client.knowledge.search({ query: 'revenue update', limit: 10 });",
		usageExample: `// Pull recent revenue updates across all Automation windows.
export default async (_ctx, client) => {
  return client.knowledge.search({ query: 'revenue update', limit: 10 });
};`,
	},
	"knowledge.save": {
		summary:
			"Persist a knowledge event, optionally associated with entities. For metadata-backed structured rendering from an event kind, set payload_type: 'empty'; the default text payload bypasses that renderer.",
		access: "write",
		example:
			"await client.knowledge.save({ entity_ids: [42], content: 'CEO confirmed Q4 revenue ...', semantic_type: 'fact' });",
		usageExample: `// Append a new fact. Pass \`supersedes_event_id\` to replace prior facts.
export default async (_ctx, client) => {
  return client.knowledge.save({ entity_ids: [42], content: 'CEO confirmed Q4 revenue $1.2M.', semantic_type: 'fact' });
};`,
	},
	"knowledge.read": {
		summary:
			"Read knowledge events by id (`content_ids`, an array — there is no singular `content_id` arg), or Automation-window context. Pass automation_id with run_id to bind the read to that queued run's persisted version, window, and trigger inputs.",
		access: "read",
		signature:
			"knowledge.read(input: { content_ids?: number[]; automation_id?: number; run_id?: number; semantic_type?: string | string[]; entity_id?: number; entity_types?: string[]; query?: string; since?: string; until?: string; limit?: number; ... }): Promise<unknown>",
		example: "await client.knowledge.read({ content_ids: [2321593] });",
	},
	"knowledge.delete": {
		summary:
			"Soft-delete one or more knowledge events your org owns by writing a tombstone superseding event. The original is hidden from default search/query/read paths via the `current_event_records` view; the full row stays on disk and is recoverable via `include_superseded`. Only events with `events.organization_id = caller` are touched — cross-org events visible via entity/connection bridges are reported in `not_found_ids`, and events already superseded come back as `already_superseded_ids`. Returns `{ deleted_ids, tombstone_ids, not_found_ids, already_superseded_ids }`. Pair with `knowledge.save({ supersedes_event_id, content: ... })` when you want to *replace* an event rather than just hide it.",
		access: "write",
		example: "await client.knowledge.delete(2321593);",
		usageExample: `// Hide a smoke-test write that should not have landed.
export default async (_ctx, client) => {
  const result = await client.knowledge.delete({
    content_ids: [2321593, 2321594],
    reason: 'smoke test cleanup',
  });
  return result;
};`,
	},

	// agents — admin tier for discovery; agent_config write-policy further
	// gates list/get (read) and create/update/delete for agent principals.
	"agents.manage": {
		summary: "Raw manage_agents action wrapper. Prefer named methods.",
		access: "admin",
	},
	"agents.list": {
		summary:
			"List agents the principal may read (agent_config read; default all). Org-read gated via requireOrgReadAccess.",
		access: "read",
		example: "const { agents } = await client.agents.list();",
	},
	"agents.get": {
		summary:
			"Fetch one agent by id when agent_config read allows that target. Org-read gated via requireOrgReadAccess.",
		access: "read",
		signature:
			"agents.get(agent_id: string): Promise<unknown> // or agents.get({ agent_id })",
		example: "const { agent } = await client.agents.get('builder');",
	},
	"agents.create": {
		summary:
			"Create an agent (queued for approval when invoked by an agent principal). Requires admin tier + agent_config create.",
		access: "admin",
		example:
			"await client.agents.create({ agent_id: 'researcher', name: 'Researcher' });",
	},
	"agents.update": {
		summary:
			"Update agent fields (may queue for approval). Requires admin tier + agent_config update.",
		access: "admin",
	},
	"agents.delete": {
		summary:
			"Delete an agent (may queue for approval). Requires admin tier + agent_config delete.",
		access: "admin",
		signature:
			"agents.delete(agent_id: string): Promise<unknown> // or agents.delete({ agent_id })",
		example: "await client.agents.delete('researcher');",
	},

	// conversations — an agent's durable threads (history + pinned sandbox realm).
	// list/get read the materialized `conversations` entity; send drives a turn.
	"conversations.manage": {
		summary: "Raw manage_conversations action wrapper. Prefer named methods.",
		access: "write",
	},
	"conversations.setTitle": {
		summary:
			"Set display-only text for the current MCP host conversation. Source, icon, location, and navigation remain server-owned.",
		access: "write",
		signature:
			"conversations.setTitle({ title: string }): Promise<{ title: string }>",
		example:
			"await client.conversations.setTitle({ title: 'Q3 launch research' });",
	},
	"conversations.list": {
		summary:
			"List an agent's conversations, newest-first (own threads for a member; all for admin).",
		access: "read",
		example:
			"const { conversations } = await client.conversations.list({ agent_id: 'researcher' });",
	},
	"conversations.get": {
		summary:
			"Fetch one conversation by (platform, conversation_id). platform defaults to 'web'.",
		access: "read",
		example:
			"const { conversation } = await client.conversations.get({ agent_id: 'researcher', conversation_id: 'researcher_u1_org1_daily' });",
	},
	"conversations.send": {
		summary:
			"Send a message to an agent conversation and (by default) await the reply. Runs the turn in the conversation's pinned sandbox realm. Pass wait:false to enqueue and return immediately.",
		access: "write",
		cost: "expensive",
		usageExample: `// Send a message and get the agent's reply back.
export default async (ctx, client) => {
  const res = await client.conversations.send({
    agent_id: 'researcher',
    thread: 'daily',
    text: 'Summarize today’s new signups.',
  });
  if (res.status === 'complete') return res.reply;
  if (res.status === 'error') throw new Error(res.error);
  // status 'timeout' — the turn is still running (it is NOT lost). Raise
  // timeout_ms for a longer wait; the reply is not retrievable through get
  // (get returns only conversation metadata).
  return { pending: res.conversation_id };
};`,
	},

	// schedules
	"schedules.manage": {
		summary: "Raw manage_schedules action wrapper. Prefer named methods.",
		access: "admin",
	},
	"schedules.list": {
		summary:
			"List scheduled jobs with optional filters. Results are scoped to the caller's organization. Requires admin (schedule rows carry agent prompts and delivery context).",
		access: "admin",
		example:
			"const { schedules } = await client.schedules.list({ agent_id: 'builder' });",
	},
	"schedules.create": {
		summary:
			"Create a one-shot or recurring schedule (send_notification or wake_agent). Requires admin. REQUIRES description, run_at (ISO timestamp of the first/only firing), and payload — the payload's `type` discriminant selects the handler and its required fields.",
		access: "admin",
		signature:
			"schedules.create(input: { description: string; run_at: string /* ISO */; cron?: string; timezone?: string /* IANA, for cron */; until_at?: string; idempotency_key?: string; payload: { type: 'send_notification'; title: string; body?: string; recipients?: 'admins' | 'all' | string[]; resource_url?: string } | { type: 'wake_agent'; agent_id: string; prompt: string; thread_id?: string; reason?: string; model?: string } }): Promise<unknown>",
		example: `await client.schedules.create({
  description: 'Follow up in 1h',
  run_at: '2026-07-05T12:00:00Z',
  payload: { type: 'wake_agent', agent_id: 'builder', prompt: 'Check inbox' },
});`,
		usageExample: `// One-shot notification (recurring: add cron + optional timezone/until_at).
export default async (_ctx, client) => {
  return client.schedules.create({
    description: 'Standup reminder',
    run_at: '2026-07-16T09:00:00Z',
    cron: '0 9 * * MON-FRI',
    timezone: 'Europe/London',
    payload: { type: 'send_notification', title: 'Standup in 15m', recipients: 'all' },
  });
};`,
	},
	"schedules.update": {
		summary:
			"Patch a schedule (next run, cron, wake_agent prompt). The schedule is addressed by `id` (not `schedule_id`). Requires admin.",
		access: "admin",
		signature:
			"schedules.update(input: { id: string; description?: string; run_at?: string; cron?: string | null; prompt?: string; model?: string }): Promise<unknown>",
		example:
			"await client.schedules.update({ id: 'schedule-id', run_at: '2026-07-22T09:00:00Z' });",
	},
	"schedules.pause": {
		summary:
			"Pause or resume a schedule, addressed by `id` (not `schedule_id`). Requires admin.",
		access: "admin",
		signature:
			"schedules.pause(input: { id: string; paused?: boolean }): Promise<unknown>",
		example: "await client.schedules.pause({ id: 'schedule-id' });",
	},
	"schedules.cancel": {
		summary:
			"Permanently delete a schedule, addressed by `id` (not `schedule_id`). Requires admin.",
		access: "admin",
		signature: "schedules.cancel(input: { id: string }): Promise<unknown>",
		example: "await client.schedules.cancel({ id: 'schedule-id' });",
	},

	// notifications
	"notifications.list": {
		summary:
			"List the caller's in-app inbox notifications (same store as REST GET /notifications). Keyset-paginated by event id; optional unread_only filter. Returns `{ notifications, nextCursor }`.",
		access: "read",
		signature:
			"notifications.list(input?: { cursor?: number | null; limit?: number; unread_only?: boolean }): Promise<{ notifications: object[]; nextCursor: number | null }>",
		example:
			"const { notifications, nextCursor } = await client.notifications.list({ unread_only: true, limit: 20 });",
		usageExample: `// Read unread inbox items without changing their state.
export default async (_ctx, client) => {
  const { notifications, nextCursor } = await client.notifications.list({
    unread_only: true,
    limit: 20,
  });
  return { notifications, nextCursor };
};`,
	},
	"notifications.markRead": {
		summary:
			"Mark one of the caller's notifications as read (same store as REST PATCH /notifications/:id/read). Accepts a positional id or `{ notification_id }`. Returns `{ success: true }` or throws when missing/already read. Use via run_sdk because it changes inbox state.",
		access: "write",
		signature:
			"notifications.markRead(notification_id: number): Promise<{ success: true }> // or notifications.markRead({ notification_id })",
		example: "await client.notifications.markRead({ notification_id: 42 });",
	},
	"notifications.send": {
		summary:
			"Send a notification to org users. With a flat object `input_schema`, it becomes a human question on the existing approval/rejection rail: in-app surfaces render answer controls, chat delivery links to Lobu when input is needed, and the returned `run_id` can be read with `operations.getRun` until its output contains `{ answer: ... }`. Supported answer schemas contain primitive fields, scalar enum choices, string or scalar-enum arrays, and optional nullable wrappers; nested objects, references, combinators other than those nullable wrappers, constants, and string/number/array constraints are rejected. An unsupported `input_schema` fails the call with HTTP 422. Without `input_schema`, it sends an FYI. With `semantic_type`, the notification renders as a content event through the event-kind pipeline: `data` feeds the kind's `jsonTemplate` in the Memory/Events view, the inbox keeps the markdown `body`, and the kind is validated against `$member.event_kinds` (422 on an unregistered kind or invalid non-empty data). Both fan out to active bot connections. Pass `automation_source` from a reaction for feedback attribution.",
		access: "write",
		signature:
			"notifications.send(input: { title: string; body?: string; card?: CardElement; recipients?: 'admins' | 'all' | string[]; resource_url?: string; idempotency_key?: string; connection_id?: string; data?: object; semantic_type?: string; input_schema?: object; automation_source?: { automation_id: number; run_id: number } }): Promise<{ notified_count: number; event_id: number | null; url: string | null; run_id?: number }>",
		example:
			"await client.notifications.send({ title: 'Choose a launch window', input_schema: { type: 'object', properties: { window: { enum: ['Monday', 'Friday'] } }, required: ['window'] } });",
		usageExample: `// Ask a human and return the durable handle the caller can poll.
export default async (_ctx, client) => {
  const pending = await client.notifications.send({
    title: 'Choose a launch window',
    body: 'Both candidates passed the release checks.',
    input_schema: {
      type: 'object',
      properties: { window: { title: 'Launch window', enum: ['Monday', 'Friday'] } },
      required: ['window'],
    },
  });
  return pending; // When run_id is present, read it later with operations.getRun.
};`,
	},

	// Automations
	"automations.manage": {
		summary:
			"Raw manage_automations action wrapper. Prefer named methods such as automations.trigger or automations.createVersion.",
		access: "external",
		enforcedTier: "admin",
		example:
			"await client.automations.manage({ action: 'trigger', automation_id: '42' });",
	},
	"automations.list": {
		summary:
			"List Automations, optionally filtered by entity. Returns `{ automations: [...] }`.",
		access: "read",
		example:
			"const { automations } = await client.automations.list({ entity_id: 42 });",
		usageExample: `export default async (_ctx, client) => {
  const { automations } = await client.automations.list({ entity_id: 42 });
  return automations;
};`,
	},
	"automations.get": {
		summary: "Fetch an Automation by id.",
		access: "read",
		throws: ["AutomationNotFound"],
		example:
			"const automation = await client.automations.get({ automation_id: '42' });",
	},
	"automations.create": {
		summary:
			"Create an Automation. Successful creates return the canonical `{ action: 'create', automation_id, version, status }` receipt; policy-gated creates return a pending approval receipt with `run_id`. Requires slug and managed_agent_id; window/manual Automations also need prompt, skills, or a reaction script. Use device_worker_id to pin execution to a registered device and agent_kind to select its interchangeable local CLI. Declare named outputs as `{ entity, key, name? }` or `{ event }`, or omit outputs for a run-result/reaction-only Automation. Event output rows are standard drafts with required content and optional title, metadata, author, source_url, occurred_at, parent_event_id, payload_type, and idempotency_key. Outputs require window execution. Each sources[] entry requires `name` and a read-only SELECT/WITH `query` projecting an `id` column; optional `context: true` marks the source as context-only. entity_id is optional for an org-scoped Automation.",
		access: "admin",
		throws: ["EntityNotFound"],
		signature:
			"automations.create(input: { slug: string; managed_agent_id: string; prompt?: string; device_worker_id?: string | null; agent_kind?: 'claude-code' | 'codex' | 'opencode' | 'pi' | 'agy' | null; ... }): Promise<{ action: 'create'; automation_id: string; version: number; status: string; ... } | { action: 'create'; status: 'pending_approval'; run_id: number; ... }>",
		example:
			"const created = await client.automations.create({ slug: 'pricing', managed_agent_id: 'agt_123', device_worker_id: 'device-worker-uuid', agent_kind: 'opencode', prompt: 'Extract pricing records and notable changes.', outputs: { prices: { entity: 'price', key: ['sku'] }, alerts: { event: 'observation' } }, sources: [{ name: 'content', query: 'SELECT id, content FROM events ORDER BY occurred_at DESC' }] }); const automationId = 'automation_id' in created ? created.automation_id : undefined; // undefined when the create was policy-gated into an approval",
		usageExample: `// Stand up an Automation that extracts pricing entities from recent events.
// The output contract is derived from the \`price\` entity type metadata_schema;
// sources[].query is a read-only SELECT projecting \`id\` (a URL here would be rejected).
export default async (_ctx, client) => {
  return client.automations.create({
    slug: 'pricing',
    managed_agent_id: 'agt_123',
    prompt: 'Extract current pricing records from the window content.',
    outputs: { prices: { entity: 'price', key: ['sku'] } },
    sources: [
      { name: 'content', query: 'SELECT id, content FROM events ORDER BY occurred_at DESC' },
    ],
  });
};`,
	},
	"automations.update": {
		summary:
			"Update runtime config only: triggers, managed_agent_id, model_config, execution_config, device_worker_id, agent_kind, delivery_target, min_cooldown_seconds, tags. delivery_target is a strict bound chat destination `{ connection_id, channel_id }`; null clears it. Version-owned fields (name, description, prompt, sources) are immutable here — use createVersion. Status is not patchable here (an Automation is retired via delete → archived).",
		access: "admin",
	},
	"automations.createVersion": {
		summary:
			"Create a new Automation version. Version-owned fields include name, description, prompt, skills, sources, outputs, classifiers, and reactions guidance. Outputs use the same entity/event contract as create and require window execution.",
		access: "admin",
	},
	"automations.trigger": {
		summary:
			"Create or reuse an immediate Automation run. The typed result identifies the durable execution owner. Pending runs use their persisted managed_agent, device_worker, or external_client lane. An existing external lease returns owner caller with a resume_claim action when this caller owns it, or owner another_caller with handled_elsewhere. A pending external_client run uses next_action.read (knowledge.read with automation_id + run_id) then automations.completeWindow. created is false when an active run was reused.",
		access: "external",
		enforcedTier: "write",
		signature:
			"automations.trigger(input: { automation_id: string }): Promise<AutomationTriggerResult>",
		example:
			"const run = await client.automations.trigger({ automation_id: '42' });",
		usageExample: `export default async (_ctx, client) => {
  const run = await client.automations.trigger({ automation_id: '42' });
  if (run.execution.lane !== 'external_client') return run;
  if (run.execution.next_action.kind === 'handled_elsewhere') return run;
  if (run.execution.next_action.kind === 'resume_claim') {
    return client.automations.claimNextWindow(run.execution.next_action.input);
  }

  const context = await client.knowledge.read(run.execution.next_action.read.input);
  // Analyze context, then submit the result with the returned run_id and window_token:
  return client.automations.completeWindow({
    automation_id: run.automation_id,
    run_id: run.run_id,
    window_token: context.window_token,
    extracted_data: { /* match context.extraction_schema */ },
  });
};`,
	},
	"automations.delete": {
		summary:
			"Archive one or more Automations (soft delete): sets status='archived' and stops scheduling. The row and its versions are retained; there is no hard delete.",
		access: "admin",
		example: "await client.automations.delete({ automation_ids: ['42'] });",
	},
	"automations.setReactionScript": {
		summary:
			"Attach a raw TS reaction script (fires on window completion). The source goes in `reaction_script`; empty string removes it.",
		access: "admin",
		signature:
			"automations.setReactionScript(input: { automation_id: string; reaction_script: string }): Promise<unknown>",
		example:
			"await client.automations.setReactionScript({ automation_id: '42', reaction_script: 'export default async (ctx, client) => { /* … */ };' });",
		throws: ["CompileError"],
	},
	"automations.completeWindow": {
		summary:
			"Submit LLM-extracted data for an Automation window and advance the Automation arrival mark. Requires a signed window_token. Required after every claimNextWindow, including when the window held nothing actionable: the mark moves only inside this call, so an unfinished claim lets the lease expire, times the run out, and serves the same content again on the next claim.",
		access: "write",
	},
	"automations.claimNextWindow": {
		summary:
			"Atomically claim the Automation unclaimed arrival window and return bounded source context plus a fenced window_token. The window is [arrival mark, now - settle) over events.created_at, not a calendar period. The caller MUST finish the claim with completeWindow, even for an empty or non-actionable window. Pass run_id and context.page.next_cursor to continue a multi-page claim.",
		access: "write",
		signature:
			"automations.claimNextWindow(input: { automation_id: string; lease_seconds?: number; limit?: number; run_id?: number; before_occurred_at?: string; before_id?: number }): Promise<AutomationClaimNextWindowResult>",
		example:
			"const claim = await client.automations.claimNextWindow({ automation_id: '42' });",
	},
	"automations.getVersions": {
		summary: "List template versions for an Automation.",
		access: "read",
		signature:
			"automations.getVersions(automation_id: string): Promise<unknown> // or automations.getVersions({ automation_id })",
		example: "const versions = await client.automations.getVersions('42');",
	},
	"automations.getVersionDetails": {
		summary: "Fetch a specific Automation template version.",
		access: "read",
	},
	"automations.getComponentReference": {
		summary: "Return Automation UI/component reference documentation.",
		access: "read",
	},
	"automations.submitFeedback": {
		summary: "Submit field-level corrections for an Automation window.",
		access: "admin",
	},
	"automations.getFeedback": {
		summary:
			"Read field-level feedback for an Automation, optionally scoped to a window.",
		access: "read",
	},
	"automations.createFromVersion": {
		summary:
			"Create Automations for multiple entities from an existing Automation version.",
		access: "admin",
	},

	// connections
	"connections.manage": {
		summary: "Raw manage_connections action wrapper. Prefer named methods.",
		access: "external",
		enforcedTier: "admin",
	},
	"connections.list": {
		summary: "List configured connections in the current organization.",
		access: "read",
		signature:
			"connections.list(input?: { connector_key?: string; status?: string; setup_attempt_id?: string; limit?: number; offset?: number }): Promise<unknown>",
	},
	"catalog.listCatalog": {
		summary:
			"List global catalog entries. `kinds` values are plural: 'connectors', 'skills', 'automations' (defaults to all).",
		access: "read",
		signature:
			"catalog.listCatalog(input?: { kinds?: Array<'connectors' | 'skills' | 'automations'> }): Promise<unknown> // not paginated",
		example: "await client.catalog.listCatalog({ kinds: ['connectors'] });",
	},
	"catalog.listInstalled": {
		summary:
			"List installed resources. `kinds` values are plural: org kinds 'connectors'/'automations', agent kinds 'skills'/'providers'/'guardrails' (agent kinds need `agent_id`). Pass `include_catalog: true` to merge global catalog entries with installed/installable flags. Each connector entry carries identity + capability flags. For an INSTALLED connector's full auth/feeds/actions/options schema, query it directly with `query_sql` → `SELECT auth_schema, feeds_schema, actions_schema, options_schema FROM connector_definitions WHERE key = '<connector>' AND status = 'active'` instead of pulling every connector's schemas through this list; for an AVAILABLE (not-yet-installed) connector, its schema is on the `list_catalog` entry's `detail`.",
		access: "read",
		signature:
			"catalog.listInstalled(input?: { kinds?: string[]; agent_id?: string; include_catalog?: boolean }): Promise<unknown>",
		example:
			"await client.catalog.listInstalled({ kinds: ['connectors'], include_catalog: true });",
	},
	"connections.get": {
		summary: "Get a connection by id.",
		access: "read",
		signature:
			"connections.get(connection_id: number): Promise<unknown> // or connections.get({ connection_id })",
		example: "await client.connections.get(42);",
	},
	"connections.create": {
		summary:
			"Create from an existing auth profile. Setup gaps return a structured setup_required continuation with next_action and an optional resume_call/completion_check.",
		access: "write",
	},
	"connections.connect": {
		summary:
			"Recommended connector setup entry point. Handles every auth family; the result's `status` tells you what to do next. status 'active' (auth-none, e.g. rss or hackernews) or 'pending_auth' (OAuth waiting on the user) BOTH carry a `connection_id`. status 'setup_required' is a continuation — `connection_id` is OPTIONAL there (may be absent); follow `next_action` / `resume_call` / `completion_check`. After auth is complete, create a feed and either schedule or trigger it; connect() alone syncs nothing.",
		access: "admin",
		example:
			"const c = await client.connections.connect({ connector_key: 'rss' }); // c.connection_id",
		usageExample: `// Three-hop: connect() creates the connection, feeds.create() defines the
// sync target, and feeds.trigger() collects now. The feed can instead carry a
// schedule. Use the returned connection_id with a connector-declared feed_key
// (search_sdk '<connector>' lists the feed keys, e.g. rss → 'articles').
export default async (_ctx, client) => {
  const c = await client.connections.connect({ connector_key: 'rss' });
  // Auth-none connectors are active immediately; auth-gated ones return a
  // connect_url / pending_auth for the user to finish first.
  // The feed's config keys come from the connector's feeds_schema — inspect it
  // via client.catalog.listInstalled({ kinds: ['connectors'] }) (each entry's
  // detail.feeds_schema[feed_key]) if you're unsure what to pass. For rss's
  // 'articles' feed that's { feed_urls: [...] }.
  const { feed } = await client.feeds.create({
    connection_id: c.connection_id,
    feed_key: 'articles',
    config: { feed_urls: ['https://example.com/feed.xml'] },
  });
  return client.feeds.trigger({ feed_id: feed.id });
};`,
	},
	"connections.connectManaged": {
		summary:
			"Use a live managed OAuth offer from organizations.list. Validates the public provider, automatically joins the signed-in user to that org, and returns a consent URL. The cloud keeps only the caller-owned consent grant with zero feeds; after consent, `lobu init --from-org <managed_by_org>` generates the local `managedBy` connection config so data access runs locally.",
		access: "write",
		signature:
			"connections.connectManaged(input: { managed_by_org: string; connector_key: string; display_name?: string; slug?: string; config?: object }): Promise<unknown>",
		example:
			"await client.connections.connectManaged({ managed_by_org: '<organizations.list offer>', connector_key: 'google.gmail' });",
	},
	"connections.update": {
		summary:
			"Update a connection's config, auth profile, status, slug, or device binding. The label field is `display_name` (not `name`). `config` merges into the stored config by default; pass `replace_config: true` alongside it to store exactly the object you send. `device_worker_id` reassigns which device runs this connection; null moves it back to the server (serverless), which the connector must not require a capability for.",
		access: "write",
		signature:
			"connections.update(input: { connection_id: number; display_name?: string; slug?: string; status?: string; agent_id?: string | null; auth_profile_slug?: string | null; app_auth_profile_slug?: string | null; config?: object; entity_ids?: number[]; device_worker_id?: string | null; replace_config?: boolean }): Promise<unknown>",
		example:
			"await client.connections.update({ connection_id: 42, display_name: 'Team calendar' });",
	},
	"connections.delete": {
		summary: "Delete a connection.",
		access: "admin",
		signature:
			"connections.delete(connection_id: number): Promise<unknown> // or connections.delete({ connection_id })",
		example: "await client.connections.delete(42);",
	},
	"connections.reauthenticate": {
		summary:
			"Start a fresh auth flow for an existing OAuth-account or interactive connection. Returns connect_url for OAuth or auth_run_id for interactive pairing.",
		access: "write",
		signature:
			"connections.reauthenticate(connection_id: number): Promise<unknown> // or connections.reauthenticate({ connection_id })",
		example: "await client.connections.reauthenticate(42);",
	},
	"connections.test": {
		summary:
			"Inspect a connection's authentication or device availability: OAuth token validity/expiry, env/app-auth presence, browser-session cookies, or (for an auth-free connection pinned to a device) whether the paired device is online. Only the browser-session CDP path makes an outbound network probe; the rest are metadata checks.",
		access: "external",
		enforcedTier: "admin",
		signature:
			"connections.test(connection_id: number): Promise<unknown> // or connections.test({ connection_id })",
		example: "await client.connections.test(42);",
	},
	"connections.installConnector": {
		summary:
			"Enable a reviewed catalog connector with connector_id, or install a connector definition from exactly one explicit source (source_url | source_uri | source_code | mcp_url). Organization-local: if the key is already installed for this org the active definition is updated in place (prior versions stay retained for rollbackConnectorVersion); the global catalog is never modified. To change an existing connector's source, prefer validateConnectorSource then updateConnectorSource.",
		access: "admin",
		signature:
			"connections.installConnector(input: { connector_id?: string; source_url?: string; source_uri?: string; source_code?: string; compiled?: boolean; mcp_url?: string; auth_values?: Record<string, string> }): Promise<unknown>",
		example:
			"await client.connections.installConnector({ connector_id: 'google.gmail' });",
	},
	"connections.uninstallConnector": {
		summary: "Uninstall a connector definition.",
		access: "admin",
		signature:
			"connections.uninstallConnector(connector_key: string): Promise<unknown> // or connections.uninstallConnector({ connector_key })",
		example: "await client.connections.uninstallConnector('rss');",
	},
	"connections.getConnectorSource": {
		summary:
			"Read the installed source for a connector in this organization (organization-local): the active (or a specific retained) version's source_code/source_path, its code hash, and the retained version history usable with rollbackConnectorVersion.",
		access: "admin",
		signature:
			"connections.getConnectorSource(input: { connector_key: string; version?: string }): Promise<unknown>",
		example:
			"const src = await client.connections.getConnectorSource({ connector_key: 'google.gmail' });",
	},
	"connections.validateConnectorSource": {
		summary:
			"Compile connector source and return extracted metadata or compiler diagnostics WITHOUT persisting anything — the safe preflight before updateConnectorSource. Returns { valid: false, diagnostics } on compile/metadata failure; on success reports the extracted key/name/version, whether that key is installed in this org, and whether the version collides with a retained version.",
		access: "admin",
		signature:
			"connections.validateConnectorSource(input: { source_code: string; compiled?: boolean }): Promise<unknown>",
		example:
			"const check = await client.connections.validateConnectorSource({ source_code });",
	},
	"connections.updateConnectorSource": {
		summary:
			"Replace an installed connector's source (organization-local; never the global catalog). The source's definition.key must equal connector_key and definition.version must be bumped when the code changes — the prior version stays retained for rollbackConnectorVersion. Existing connections, feeds, and credentials stay attached. Pass expected_version for an optimistic concurrency check.",
		access: "admin",
		signature:
			"connections.updateConnectorSource(input: { connector_key: string; source_code: string; compiled?: boolean; expected_version?: string }): Promise<unknown>",
		example:
			"await client.connections.updateConnectorSource({ connector_key: 'google.gmail', source_code, expected_version: '1.4.2' });",
	},
	"connections.rollbackConnectorVersion": {
		summary:
			"Re-activate a previously installed version of a connector in one operation (organization-local). The retained code is re-validated before the definition flips; existing connections and feeds stay attached. List retained versions with getConnectorSource.",
		access: "admin",
		signature:
			"connections.rollbackConnectorVersion(input: { connector_key: string; version: string }): Promise<unknown>",
		example:
			"await client.connections.rollbackConnectorVersion({ connector_key: 'google.gmail', version: '1.4.2' });",
	},
	"connections.toggleConnectorLogin": {
		summary: "Enable/disable the login-with-connector flow.",
		access: "admin",
	},
	"connections.updateConnectorAuth": {
		summary: "Update org-wide auth config for a connector.",
		access: "admin",
	},
	"connections.updateConnectorDefaultConfig": {
		summary: "Update a connector definition's default connection config.",
		access: "admin",
	},

	// operations
	"operations.manage": {
		summary: "Raw manage_operations action wrapper. Prefer named methods.",
		access: "external",
		enforcedTier: "write",
	},
	"operations.listAvailable": {
		summary:
			"Search declared connector capabilities, including disconnected connectors. Pass connection_id to list the operations declared by that connection's connector with that connection's per-target readiness (errors if the connection is not visible); connector_key/query/kind filter the wider catalog. Returns readiness plus every visible execution target; backend configuration is never exposed.",
		access: "read",
	},
	"operations.execute": {
		summary:
			"Execute a connector action. OBJECT signature: execute({ connection_id: number, operation_key: string, input?: object, idempotency_key?: string, automation_source?: { automation_id: number, run_id: number } }). connector_key is not accepted. A durable idempotency_key replays the original run instead of repeating the external request.",
		access: "external",
		enforcedTier: "write",
		cost: "expensive",
		example:
			"await client.operations.execute({ connection_id: 42, operation_key: 'create_issue', input: { title: 'Follow up' } });",
	},
	"operations.listRuns": {
		summary:
			"List past operational runs. Filters: run_types, connector_key, operation_key, connection_id(s), feed_ids, automation_ids, status, created_after/created_before. Chat-message transport runs (streaming deltas) are excluded by default — pass run_types: ['chat_message'] for the low-level trace view.",
		access: "read",
		example:
			"await client.operations.listRuns({ connector_key: 'github', status: 'failed', created_after: '2026-07-01T00:00:00Z' });",
	},
	"operations.getRun": {
		summary: "Get a single run by id.",
		access: "read",
		signature:
			"operations.getRun(run_id: number): Promise<unknown> // or operations.getRun({ run_id })",
		example: "const run = await client.operations.getRun(123);",
	},
	"operations.approve": {
		summary: "Approve a pending run that required human approval.",
		access: "write",
	},
	"operations.reject": {
		summary: "Reject a pending run.",
		access: "write",
	},

	// feeds
	"feeds.manage": {
		summary: "Raw manage_feeds action wrapper. Prefer named methods.",
		access: "external",
		enforcedTier: "admin",
	},
	"feeds.list": {
		summary:
			"List data-sync feeds. `status` filters by lifecycle (active|paused); `health` filters active feeds on non-paused connections by runtime health ('failing' = last sync failed or consecutive failures, 'healthy' = otherwise) — use it to find active-but-failing feeds the status filter cannot surface. Paused feeds and feeds on paused connections are excluded. Result carries `total` and `has_more`.",
		access: "read",
		signature:
			"feeds.list(input?: { connection_id?: number; status?: 'active' | 'paused'; health?: 'healthy' | 'failing'; feed_ids?: number[]; entity_id?: number; limit?: number; offset?: number }): Promise<unknown>",
	},
	"feeds.get": {
		summary:
			"Get feed metadata and recent sync runs without querying its source. Search local knowledge with knowledge.search; query source-backed feeds explicitly with feeds.readMany.",
		access: "read",
		signature:
			"feeds.get(input: { feed_id: number }): Promise<unknown>",
		example: "const feed = await client.feeds.get({ feed_id: 42 });",
	},
	"feeds.readMany": {
		summary:
			"Explicitly query several source-backed feeds in parallel. Each read has its own query, sort, limit, and opaque cursor; sources are deadline-bounded and fail independently.",
		access: "read",
		signature:
			"feeds.readMany(input: { reads: Array<{ feed_id: number; query?: string; sort?: { column: string; order: 'asc' | 'desc' }; limit?: number; cursor?: string }>; timeout_ms?: number }): Promise<unknown>",
		example:
			"const feeds = await client.feeds.readMany({ reads: [{ feed_id: 42, query: 'urgent', limit: 25 }, { feed_id: 43 }] });",
	},
	"feeds.create": {
		summary:
			"Create a configured feed for a connection. Its connector-declared operations decide whether it can sync, read from the source, or do both. A syncable feed has no cron unless `schedule` is set; call feeds.trigger to sync immediately. Needs the `connection_id` from connections.connect and a connector-declared `feed_key` (search_sdk '<connector>' lists the keys, e.g. rss → 'articles'). Pass connector-specific settings in `config`.",
		access: "admin",
		signature:
			"feeds.create(input: { connection_id: number; feed_key: string; display_name?: string; entity_ids?: number[]; config?: object; schedule?: string | null; timezone?: string }): Promise<unknown>",
		example:
			"await client.feeds.create({ connection_id: 42, feed_key: 'articles', config: { feed_urls: ['https://example.com/feed.xml'] } });",
	},
	"feeds.update": {
		summary: "Update a feed.",
		access: "admin",
		signature:
			"feeds.update(input: { feed_id: number; display_name?: string; status?: 'active' | 'paused'; entity_ids?: number[]; config?: object; replace_config?: boolean; schedule?: string | null; timezone?: string | null }): Promise<unknown>",
	},
	"feeds.delete": {
		summary: "Delete a feed.",
		access: "admin",
		example: "await client.feeds.delete({ feed_id: 42 });",
	},
	"feeds.trigger": {
		summary:
			"Trigger an immediate sync for a feed (external side-effect). Pass dry_run: true to execute the connector for real but persist nothing — no events, entities or attachments, and the feed's checkpoint and sync state do not move; the run executes asynchronously, and once it completes a capped preview of what would have been ingested is on its dry_run_preview, readable via feeds.get. Use it to test a feed's config or credentials without writing to the workspace. Two limits: it cannot undo side effects the connector causes UPSTREAM (marking a message read, etc.), and it occupies the feed's single active-sync slot while it runs.",
		access: "external",
		enforcedTier: "admin",
		signature:
			"feeds.trigger(input: { feed_id: number; dry_run?: boolean }): Promise<unknown>",
		example:
			"await client.feeds.trigger({ feed_id: 42 });\n// Validate without writing anything; read the preview via feeds.get once the run completes:\nawait client.feeds.trigger({ feed_id: 42, dry_run: true });",
	},

	// authProfiles
	"authProfiles.manage": {
		summary: "Raw manage_auth_profiles action wrapper. Prefer named methods.",
		access: "external",
		enforcedTier: "admin",
	},
	"authProfiles.list": {
		summary: "List reusable auth profiles.",
		access: "read",
		signature:
			"authProfiles.list(input?: { connector_key?: string; provider?: string; profile_kind?: 'env' | 'oauth_app' | 'oauth_account' | 'browser_session' }): Promise<unknown> // not paginated",
	},
	"authProfiles.get": {
		summary:
			"Get an auth profile by slug. Returns the sanitized serialization only — never raw credentials or auth_data.",
		access: "read",
		signature:
			"authProfiles.get(auth_profile_slug: string): Promise<unknown> // or authProfiles.get({ auth_profile_slug })",
		example: "await client.authProfiles.get('google-calendar-account');",
	},
	"authProfiles.test": {
		summary: "Test auth-profile credentials.",
		access: "external",
		enforcedTier: "admin",
		signature:
			"authProfiles.test(auth_profile_slug: string): Promise<unknown> // or authProfiles.test({ auth_profile_slug })",
		example: "await client.authProfiles.test('google-calendar-account');",
	},
	"authProfiles.create": {
		summary: "Create an auth profile.",
		access: "write",
	},
	"authProfiles.update": {
		summary:
			"Update an auth profile. Set reconnect=true on an OAuth-account profile to issue a fresh connect_url.",
		access: "write",
		signature:
			"authProfiles.update(input: { auth_profile_slug: string; display_name?: string; slug?: string; credentials?: Record<string, string>; auth_data?: Record<string, unknown>; requested_scopes?: string[]; status?: string; reconnect?: boolean }): Promise<unknown>",
		example:
			"await client.authProfiles.update({ auth_profile_slug: 'google-calendar-account', reconnect: true });",
	},
	"authProfiles.delete": {
		summary: "Delete an auth profile.",
		access: "admin",
		signature:
			"authProfiles.delete(auth_profile_slug: string, options?: { force?: boolean }): Promise<unknown> // or authProfiles.delete({ auth_profile_slug })",
		example: "await client.authProfiles.delete('google-calendar-account');",
	},

	// classifiers
	"classifiers.manage": {
		summary: "Raw manage_classifiers action wrapper. Prefer named methods.",
		access: "admin",
	},
	"classifiers.list": {
		summary: "List classifier templates.",
		access: "read",
		signature:
			"classifiers.list(input?: { entity_id?: number; status?: string }): Promise<unknown> // not paginated",
	},
	"classifiers.create": {
		summary:
			"Create a classifier template. Requires `slug`, `name`, `attribute_key`, and `attribute_values`. `attribute_values` is an OBJECT keyed by value slug — each entry needs a `description` and `examples` (string array), not a flat list. OMIT `automation_id` for an org-level classifier, which is the only kind `apply` and the reconciliation job can match; pass it only to scope the classifier to one Automation.",
		access: "admin",
		signature:
			"classifiers.create(input: { slug: string; name: string; attribute_key: string; attribute_values: Record<string, { description: string; examples: string[]; embedding?: number[] | null }>; automation_id?: string; entity_id?: number; description?: string; min_similarity?: number; fallback_value?: unknown; created_by?: string; embedding_model?: string }): Promise<unknown>",
		example:
			"await client.classifiers.create({ slug: 'sentiment', name: 'Sentiment', attribute_key: 'sentiment', attribute_values: { positive: { description: 'Positive tone', examples: ['Great work!'] } } });",
	},
	"classifiers.generateEmbeddings": {
		summary:
			"Generate embeddings for attribute values (cost-heavy). `embedding_model` picks the vector space; it defaults to the deployment's configured model, and must match the model the events were embedded under or `apply` will match nothing.",
		access: "admin",
		cost: "expensive",
		signature:
			"classifiers.generateEmbeddings(input: { classifier_id: number; force_regenerate?: boolean; embedding_model?: string }): Promise<unknown>",
	},
	"classifiers.delete": {
		summary: "Delete a classifier.",
		access: "admin",
		example: "await client.classifiers.delete({ classifier_id: 42 });",
	},
	"classifiers.classify": {
		summary:
			"Apply a manual classification to one or many content records (single or batch). The classifier is addressed by `classifier_slug` (a string — NOT the numeric `classifier_id` other CRUD methods use); `source` accepts only 'llm' or 'user'.",
		access: "admin",
		signature:
			"classifiers.classify(input: { classifier_slug: string; content_id?: number; value?: string | null; reasoning?: string; classifications?: Array<{ content_id: number; value: string | null; reasoning?: string }>; source?: 'llm' | 'user' }): Promise<unknown>",
		example:
			"await client.classifiers.classify({ classifier_slug: 'sentiment', content_id: 101, value: 'positive', source: 'user' });",
	},
	"classifiers.apply": {
		summary:
			"Run a classifier's embedding match over content ids you supply and STORE the labels. Needs no entity link, so this is how org-scoped feed content gets classified. Returns `classified` plus a `skipped` breakdown (not_in_organization | superseded | not_embedded | below_threshold) — a zero result always says why. Only matches org-level classifiers (those created without `automation_id`). `embedding_model` selects the vector space for BOTH the labels and the events; ids with no vector in that model are reported `not_embedded`.",
		access: "admin",
		cost: "expensive",
		signature:
			"classifiers.apply(input: { classifier_slug: string; content_ids: number[]; embedding_model?: string }): Promise<unknown>",
		example:
			"await client.classifiers.apply({ classifier_slug: 'sentiment', content_ids: [101, 102, 103] });",
	},

	// viewTemplates
	"viewTemplates.manage": {
		summary: "Raw manage_view_templates action wrapper. Prefer named methods.",
		access: "admin",
	},
	"viewTemplates.get": {
		summary:
			"Get the active view template for a resource. Params: { resource_type: 'entity' | 'entity_type', resource_id, tab_name? } — resource_id is the entity id (number) for resource_type 'entity', or the entity-type slug (string) for 'entity_type'. Both resource_type and resource_id are required.",
		access: "read",
		example:
			"await client.viewTemplates.get({ resource_type: 'entity', resource_id: 42 });",
	},
	"viewTemplates.set": {
		summary:
			"Create or update a view template version. Params: { resource_type: 'entity' | 'entity_type', resource_id, json_template, tab_name?, tab_order?, change_notes? }. json_template is a DSL node tree (nodes: text | data | if | each | component; a `text` node carries its string in `content` — not `text`; a `data` node takes an optional `format`: currency|date|url|enum|boolean|number|auto|text) and may nest a `data_sources` key of named read-only SQL queries. The node tree is validated on set — a malformed template is rejected, not stored.",
		access: "admin",
		example:
			"await client.viewTemplates.set({ resource_type: 'entity_type', resource_id: 'deal', tab_name: 'Pipeline', json_template: { type: 'div', data_sources: { rows: { query: \"SELECT name, metadata->>'arr' AS arr FROM entities WHERE entity_type = 'deal'\" } }, children: [ { type: 'each', items: 'rows', as: 'r', render: { type: 'card', children: [ { type: 'data', path: 'r.name' }, { type: 'data', path: 'r.arr', format: 'currency' } ] } } ] } });",
	},
	"viewTemplates.rollback": {
		summary:
			"Roll back to a previous template version. Takes `version` — the version NUMBER, not a `version_id` row id.",
		access: "admin",
		signature:
			"viewTemplates.rollback(input: { resource_type: 'entity' | 'entity_type'; resource_id: string | number; version: number; tab_name?: string }): Promise<unknown>",
		example:
			"await client.viewTemplates.rollback({ resource_type: 'entity_type', resource_id: 'deal', version: 3 });",
	},
	"viewTemplates.removeTab": {
		summary:
			"Remove a named tab from a template. `tab_name` is required; the default/overview tab has no name and is nulled with `viewTemplates.manage({ action: 'clear', ... })` instead.",
		access: "admin",
		signature:
			"viewTemplates.removeTab(input: { resource_type: 'entity' | 'entity_type'; resource_id: string | number; tab_name: string }): Promise<unknown>",
	},

	// metrics — governed measures (prefer over client.query / query_sql)
	"metrics.list": {
		summary:
			"Discover governed declared and SQL-derived business metrics such as spend or net worth, with available measures, dimensions, and segments. Keyword-search with `q`, then call `metrics.query`.",
		access: "read",
		signature:
			"metrics.list(input?: { entity_type?: string; q?: string }): Promise<unknown> // not paginated",
		example:
			"const { entity_types } = await client.metrics.list({ q: 'net worth' });",
		usageExample: `// Discover governed measures before running one.
export default async (_ctx, client) => {
  const { entity_types } = await client.metrics.list({ entity_type: 'company' });
  return { types: entity_types.map((t) => t.entity_type) };
};`,
	},
	"metrics.query": {
		summary:
			"Run a governed declared or SQL-derived measure such as spend or net worth. Pass entity_type + measure; optional by, segment, entity_id. Prefer this over client.query when a measure exists.",
		access: "read",
		example:
			"await client.metrics.query({ entity_type: 'company', measure: 'spend', by: ['month'] });",
		usageExample: `export default async (_ctx, client) => {
  const { rows, row_count } = await client.metrics.query({
    entity_type: 'company',
    measure: 'spend',
    by: ['month'],
  });
  return { row_count, sample: rows[0] };
};`,
	},
	"metrics.series": {
		summary:
			"Run read-only time-bucketed SQL for sparklines. Returns { columns, rows, data_quality } tabular output; data_quality flags NULL/unparseable/out-of-range bucket timestamps against a bounded range (default 2000-01-01 … now+1d; override with start/end). Pass exclude_invalid_timestamps to drop flagged rows or strict to fail on them. Member-safe column allowlist; 5s timeout, 2000-row cap.",
		access: "read",
		example:
			"await client.metrics.series({ sql: \"SELECT date_trunc(\\'day\\', created_at) AS bucket, COUNT(*)::int AS n FROM events GROUP BY 1 ORDER BY 1\", exclude_invalid_timestamps: true });",
	},

	// top-level
	query: {
		summary:
			"Run a simple read-only SQL string scoped to the org (member-safe column allowlist). For pagination or connection pushdown use the `query_sql` MCP tool; query source-backed feeds explicitly with feeds.readMany. Prefer `client.metrics.query` for declared measures.",
		access: "read",
		example:
			"const rows = await client.query(\"SELECT id, name FROM entities WHERE entity_type = 'company' LIMIT 10\");",
		usageExample: `// Simple internal SQL read — use query_sql for pagination/pushdown.
export default async (_ctx, client) => {
  return client.query("SELECT id, name FROM entities WHERE entity_type = 'company' LIMIT 10");
};`,
	},
	org: {
		summary:
			"Select a granted workspace and return its SDK (OAuth on bare /mcp only). Required before workspace methods on an account client. Enforces current membership and the consent grant; scoped endpoints and PATs retain their bound client.",
		access: "read",
		example:
			"const otherSdk = await client.org('acme'); const rows = await otherSdk.entities.list();",
		usageExample: `// Select an explicit workspace (OAuth on bare /mcp).
export default async (_ctx, client) => {
  const acme = await client.org('acme');
  return acme.entities.list({ entity_type: 'company' });
};`,
	},
	log: {
		summary:
			"Emit a structured log line (captured in the invocation audit row).",
		access: "read",
		cost: "cheap",
	},
};

/** Paths that must never appear as SDK methods. Enforced by the coverage test. */
export const BANNED_PATHS = [
	"execute",
	"client.execute",
	"sdk.execute",
] as const;
