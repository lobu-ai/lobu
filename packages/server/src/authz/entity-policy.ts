/**
 * Entity mutation policy — the single decision layer for whether an agent or
 * automation write to an entity applies immediately or queues a durable approval.
 *
 * Two inputs, one decision:
 *  - Built-in invariants that no org policy can disable: writes never cross
 *    organizations, and a non-human write to a human-owned field always needs
 *    approval (field ownership is how a user pins a value).
 *  - The org's persisted `write_approval_policies` rows: per-action
 *    auto/approval modes, scoped global → entity type → field → single entity
 *    (entity_id), most specific row wins. Rows also carry the Slack delivery
 *    target for approval notifications.
 *
 * Human edits are never gated here — role restrictions for humans live in the
 * tool-access tier (e.g. manage_entity delete is owner/admin).
 *
 * Gated paths: manage_entity create/update/delete and automation window promotion
 * (promote-keyed-entities). Ingestion-infrastructure writes (entity-link-upsert
 * identity stubs, classifier extraction) are exempt BY DESIGN — they are
 * high-volume provenance plumbing, not collaboration edits; gating them would
 * flood approvals. Any new user-facing entity write path MUST call this module.
 */
import { type DbClient, getDb, pgBigintArray, pgTextArray } from "../db/client";
import { resolveEntityCreator } from "../utils/resolve-entity-creator";
import {
	WRITE_ACTION_MANIFEST,
	type WriteAction,
	defaultEffectFor,
	isLegalActionEffect,
} from "./write-action-manifest";

export type EntityPolicyDecision = "allow" | "deny" | "require_approval";
export type EntityPolicyPrincipalKind = "user" | "agent" | "automation";
export type EntityMutationAction = "read" | "create" | "update" | "delete";
/**
 * A stored per-action mode. `auto`/`approval` are the two entity modes; `deny`
 * (a hard floor — the write never applies and no approval is queued) and
 * `disabled` (the action is turned off entirely, used by the connector-action
 * class) are admitted by the widened DB CHECK. The resolver maps each to an
 * {@link EntityPolicyDecision}; unknown values coerce to the caller's fallback
 * so a mode this build predates can never silently read as `allow`.
 */
export type EntityMutationMode = "auto" | "approval" | "deny" | "disabled";

/**
 * Which class of write a policy row governs. `entity` is the original class;
 * `agent_config` gates manage_agents read/list/get + create/update/delete;
 * `connector_action` gates connector operation execution. All three share this
 * table + resolver so a new class is a value, not a schema change (see
 * docs/plans/write-gate-generalization.md).
 */
export type WriteResourceClass =
	| "entity"
	| "agent_config"
	| "connector_action"
	| "entity_schema";

export function isWriteResourceClass(
	value: unknown,
): value is WriteResourceClass {
	return (
		value === "entity" ||
		value === "agent_config" ||
		value === "connector_action" ||
		value === "entity_schema"
	);
}

/** A non-human principal a policy row may target. NULL principal = any of this kind. */
export type PolicyPrincipalKind = "agent" | "automation";

export interface EntityApprovalDeliveryTarget {
	connectionId: string | null;
	channelId: string | null;
	teamId: string | null;
	channelName: string | null;
}

export interface EntityApprovalPolicy {
	id: number;
	organizationId: string;
	resourceClass: WriteResourceClass;
	/** Non-human principal this row targets; NULL = any principal of its kind. */
	principalKind: PolicyPrincipalKind | null;
	principalId: string | null;
	/** Connector operation this row scopes to (connector_action only); NULL = the
	 * blanket row governing every operation. */
	operationKey: string | null;
	/** agent_config exception: target agents.id; NULL = any target. */
	targetAgentId: string | null;
	entityTypeSlug: string | null;
	fieldPath: string | null;
	entityId: number | null;
	createMode: EntityMutationMode;
	updateMode: EntityMutationMode;
	deleteMode: EntityMutationMode;
	/**
	 * The effect this policy attaches to each action it declares, from the child
	 * write_policy_action_effects rows. The create/update/delete convenience
	 * fields above mirror this map (entity/agent_config); connector_action carries
	 * only `execute` here and leaves the mode fields at their class defaults.
	 */
	effects: Partial<Record<WriteAction, EntityMutationMode>>;
	deliveryTarget: EntityApprovalDeliveryTarget;
}

export interface EntityApprovalPolicyInput {
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
	/** Scopes a connector_action row to one operation (e.g. 'slack.send_message');
	 * null = the blanket row for every operation. */
	operationKey?: string | null;
	/** agent_config exception: target agent id; null = any target. */
	targetAgentId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
	createMode?: EntityMutationMode;
	updateMode?: EntityMutationMode;
	deleteMode?: EntityMutationMode;
	/**
	 * A raw per-action effect map. When present it is the source of truth for the
	 * persisted child rows (clamped to what the manifest declares legal for the
	 * class), letting a caller express `deny`/`disabled`/`execute` that the
	 * create/update/delete triple can't. When absent, effects derive from the mode
	 * triple (the legacy entity-settings path). Only actions the class governs are
	 * written; an illegal (action, effect) is clamped to the class default.
	 */
	effects?: Partial<Record<WriteAction, EntityMutationMode>>;
	approvalConnectionId?: string | null;
	approvalChannelId?: string | null;
	approvalTeamId?: string | null;
	approvalChannelName?: string | null;
	/**
	 * When true, an UPDATE of an existing header PRESERVES its stored approval
	 * delivery target instead of overwriting it with the (omitted → null) delivery
	 * fields above. The effect-only permissions PUT sets this: it never carries
	 * delivery, so without preservation each save would silently erase a configured
	 * Slack connection/channel/team/name. The entity-settings path leaves it unset —
	 * it always sends the delivery it wants and MEANS to write it (including clears).
	 * On INSERT this flag is a no-op (a brand-new row has no prior target to keep).
	 */
	preserveDelivery?: boolean;
}

/**
 * A header row from write_approval_policies, with its child action→effect rows
 * attached in `effects` by {@link attachEffects}. The header no longer carries
 * mode columns; every per-action decision reads `effects`.
 */
type EntityApprovalPolicyRow = {
	id: number;
	organization_id: string;
	resource_class: string;
	principal_kind: string | null;
	principal_id: string | null;
	/** Connector operation this row scopes to (e.g. 'slack.send_message'); NULL =
	 * the blanket row governing every operation. Only set for connector_action. */
	operation_key: string | null;
	target_agent_id: string | null;
	entity_type_slug: string | null;
	field_path: string | null;
	entity_id: number | null;
	approval_connection_id: string | null;
	approval_channel_id: string | null;
	approval_team_id: string | null;
	approval_channel_name: string | null;
	/** Populated post-query from write_policy_action_effects; empty until attached. */
	effects: Partial<Record<WriteAction, EntityMutationMode>>;
};

export function isEntityMutationMode(
	value: unknown,
): value is EntityMutationMode {
	return (
		value === "auto" ||
		value === "approval" ||
		value === "deny" ||
		value === "disabled"
	);
}

/**
 * Coerce user INPUT to a caller-chosen default when it isn't a legal mode.
 * (Stored effects READ from the DB fail closed differently — see
 * {@link attachEffects}, which drops an illegal (action, effect) tuple so the
 * resolver falls back to the class default rather than reading it as `allow`.)
 */
function normalizeMode(
	value: unknown,
	fallback: EntityMutationMode,
): EntityMutationMode {
	return isEntityMutationMode(value) ? value : fallback;
}

function normalizeResourceClass(value: unknown): WriteResourceClass {
	return isWriteResourceClass(value) ? value : "entity";
}

function normalizePrincipalKind(value: unknown): PolicyPrincipalKind | null {
	return value === "agent" || value === "automation" ? value : null;
}

/**
 * The stored effect a policy attaches to `action`, or the class default if the
 * policy declares no row for that action. A policy is a SPARSE override: a scope
 * that sets only `execute` (or only `delete`) leaves the other actions at their
 * class default rather than implicitly `auto`.
 */
function effectForRowAction(
	row: EntityApprovalPolicyRow,
	resourceClass: WriteResourceClass,
	action: WriteAction,
): EntityMutationMode {
	const stored = row.effects[action];
	if (stored !== undefined) return stored;
	return defaultEffectFor(resourceClass, action);
}

function rowToPolicy(row: EntityApprovalPolicyRow): EntityApprovalPolicy {
	const resourceClass = normalizeResourceClass(row.resource_class);
	return {
		id: Number(row.id),
		organizationId: row.organization_id,
		resourceClass,
		principalKind: normalizePrincipalKind(row.principal_kind),
		principalId: row.principal_id,
		operationKey: row.operation_key,
		targetAgentId: row.target_agent_id ?? null,
		entityTypeSlug: row.entity_type_slug,
		fieldPath: row.field_path,
		entityId: row.entity_id === null ? null : Number(row.entity_id),
		createMode: effectForRowAction(row, resourceClass, "create"),
		updateMode: effectForRowAction(row, resourceClass, "update"),
		deleteMode: effectForRowAction(row, resourceClass, "delete"),
		effects: { ...row.effects },
		deliveryTarget: {
			connectionId: row.approval_connection_id || null,
			channelId: row.approval_channel_id,
			teamId: row.approval_team_id,
			channelName: row.approval_channel_name,
		},
	};
}

export function defaultEntityApprovalPolicy(
	organizationId: string,
): EntityApprovalPolicy {
	return {
		id: 0,
		organizationId,
		resourceClass: "entity",
		principalKind: null,
		principalId: null,
		operationKey: null,
		targetAgentId: null,
		entityTypeSlug: null,
		fieldPath: null,
		entityId: null,
		createMode: "auto",
		updateMode: "auto",
		deleteMode: "approval",
		effects: { create: "auto", update: "auto", delete: "approval" },
		deliveryTarget: {
			connectionId: null,
			channelId: null,
			teamId: null,
			channelName: null,
		},
	};
}

/**
 * Who is performing this mutation, for policy purposes. Precedence is DELIBERATE
 * and security-relevant: a real agent run (trusted `agentId` on the context) is
 * classified as an agent EVEN IF the request also carries a `automation_source`.
 * `automation_source` is a caller-supplied arg (attribution, e.g. for card labels);
 * letting it override the trusted agent identity would let an agent escape its
 * own per-principal policy by tagging its write as an automation's. A genuine automation
 * promotion runs with no agentId, so it still classifies as an automation. A real
 * user session (userId, no agentId) is a human; everything else is an agent.
 */
export function classifyMutationPrincipal(args: {
	userId?: string | null;
	agentId?: string | null;
	automationSource?: unknown;
}): EntityPolicyPrincipalKind {
	// Trusted agent identity wins over the caller-supplied automation tag.
	if (args.agentId) return "agent";
	if (args.automationSource) return "automation";
	if (args.userId) return "user";
	return "agent";
}

/**
 * Stable identity of the acting non-human principal, for per-principal policy
 * matching. Mirrors {@link classifyMutationPrincipal}'s precedence: a trusted
 * `agentId` wins — an agent run resolves to its own agent id even when a
 * `automationId` (from a caller-supplied automation_source) is also present, so it
 * can't spoof `automation:<id>` to dodge its agent policy. Only a genuine automation
 * path (agentId null) resolves to `automation:<id>`; no id → null ("any agent").
 */
export function mutationPrincipalId(args: {
	agentId?: string | null;
	automationId?: number | null;
}): string | null {
	if (args.agentId) return args.agentId;
	if (args.automationId != null) return `automation:${args.automationId}`;
	return null;
}

/** Inverse of {@link mutationPrincipalId} for an automation: `automation:<id>` → id, else null. */
export function automationIdFromPrincipalId(
	principalId: string | null | undefined,
): number | null {
	if (!principalId?.startsWith("automation:")) return null;
	const id = Number(principalId.slice("automation:".length));
	return Number.isFinite(id) ? id : null;
}

/**
 * Resolve the optional managed agent attached to an Automation.
 *
 * The Automation itself is always the write principal (`automation:<id>`). When
 * `managed_agent_id` is present, its agent policy is folded in as a restrictive
 * ancestor. Automations with no managed agent are still valid principals and
 * resolve with no ancestor. Only a missing Automation row, or a
 * `managed_agent_id` whose agent row no longer exists, is unresolved and must
 * fail closed.
 *
 * `IS NULL` is the complete test for "no managed agent" because
 * `automations_managed_agent_id_nonempty` forbids the empty string. Before that
 * constraint existed, `agent_id = ''` read as a named owner, missed the `agents`
 * lookup, and deny-listed every entity write the Automation declared.
 */
export async function resolveAutomationOwner(
	sql: DbClient,
	automationId: number,
	organizationId: string,
): Promise<{ ownerAgentId: string | null; resolved: boolean }> {
	const rows = await sql<{
		managed_agent_id: string | null;
		owner_resolved: boolean;
	}>`
    SELECT
      w.managed_agent_id,
      CASE
        WHEN w.managed_agent_id IS NULL THEN true
        ELSE EXISTS (
          SELECT 1
          FROM agents a
          WHERE a.id = w.managed_agent_id
            AND a.organization_id = w.organization_id
        )
      END AS owner_resolved
    FROM automations w
    WHERE w.id = ${automationId}
      AND w.organization_id = ${organizationId}
    LIMIT 1
  `;
	if (rows.length === 0) return { ownerAgentId: null, resolved: false };
	return {
		ownerAgentId: rows[0].managed_agent_id ?? null,
		resolved: rows[0].owner_resolved === true,
	};
}

/** The fully-resolved acting principal for one write, ready to hand to the gate. */
export interface ActingPrincipal {
	kind: EntityPolicyPrincipalKind;
	/** `automation:<id>` / agent id / null ("any of this kind"). */
	id: string | null;
	/** Optional attached agent, folded max-restrictive for an Automation. */
	ownerAgentId: string | null;
	/**
	 * False only when an Automation row is missing, its non-empty attached agent no longer
	 * exists, or an authenticated agent session points at a deleted agent. The gate must
	 * fail closed in those cases. An existing agentless Automation is resolved and carries
	 * no agent ancestor.
	 */
	ownerResolved: boolean;
}

/**
 * Resolve WHO is performing a write, from the two channels an acting automation can
 * arrive on, in ONE place — so no call site has to merge them. An automation is
 * identified by `ctx.actingAutomationId` (the reaction session's own automation, stamped
 * by the reaction executor) OR by an explicit `automation_source.automation_id` (a tag
 * the caller passed, e.g. a keyed-promotion). The trusted SESSION automation wins:
 * a reaction script can't retag itself with a different (nonexistent or
 * less-restricted) automation to dodge its owning agent's envelope. Any automation
 * channel makes this an automation — which is strictly MORE restrictive, since it
 * folds the owning agent's rows in on top (an automation can only tighten, never
 * loosen, its agent), so there's no way to "spoof an automation tag" to escape agent
 * policy.
 *
 * When an Automation acts, this resolves its optional attached agent and folds that
 * agent's policy max-restrictively. This is THE seam every write surface
 * (manage_entity/agents/operations/automations,
 * promotion) resolves identity through.
 */
/** An automation acting principal, folding its (already-resolved) owner agent. */
function automationPrincipal(
	automationId: number,
	owner: { ownerAgentId: string | null; resolved: boolean },
): ActingPrincipal {
	return {
		kind: "automation",
		id: `automation:${automationId}`,
		ownerAgentId: owner.ownerAgentId,
		ownerResolved: owner.resolved,
	};
}

export async function resolveActingPrincipal(
	sql: DbClient,
	args: {
		organizationId: string;
		userId?: string | null;
		agentId?: string | null;
		explicitAutomationId?: number | null;
		sessionAutomationId?: number | null;
	},
): Promise<ActingPrincipal> {
	// The trusted SESSION automation (stamped by the reaction executor) always wins and
	// folds its owning agent. An EXPLICIT automation_source is caller-controlled, so it
	// can't override an authenticated agent's identity: honor it only when there is
	// no agent (the system/keyed-promotion path) OR when it genuinely belongs to that
	// agent (an agent tagging its own automation). Otherwise a restricted agent could
	// tag a foreign/nonexistent automation to null out ownerAgentId and skip its own
	// deny/approval rows — so we fall through to the agent as the principal.
	if (args.sessionAutomationId != null) {
		return automationPrincipal(
			args.sessionAutomationId,
			await resolveAutomationOwner(
				sql,
				args.sessionAutomationId,
				args.organizationId,
			),
		);
	}
	if (args.explicitAutomationId != null) {
		const owner = await resolveAutomationOwner(
			sql,
			args.explicitAutomationId,
			args.organizationId,
		);
		if (!args.agentId || owner.ownerAgentId === args.agentId) {
			return automationPrincipal(args.explicitAutomationId, owner);
		}
		// Caller-controlled tag that isn't this agent's own automation — ignore it.
	}
	const kind = classifyMutationPrincipal({
		userId: args.userId,
		agentId: args.agentId,
	});
	// A bound agent whose row was deleted out from under a still-live session must
	// FAIL CLOSED. Its envelope rows are gone (the delete trigger cascades them), so
	// gating would find no agent-specific policy and fall back to the looser org
	// default — most dangerously connector_action → auto. Mark it unresolved so every
	// gate denies, exactly as for an automation whose owner vanished. Users are never
	// existence-checked here (they aren't gated as a principal). null agentId (the
	// system/keyed path) has no row to check and stays resolved.
	const ownerResolved =
		kind === "agent" && args.agentId != null
			? await agentExistsInOrg(sql, args.agentId, args.organizationId)
			: true;
	return {
		kind,
		id: mutationPrincipalId({ agentId: args.agentId }),
		ownerAgentId: null,
		ownerResolved,
	};
}

/**
 * The user id to stamp as `created_by` on a HEADLESS (userId == null) write to a
 * table whose `created_by` is FK → "user"(id) — `entities` is the one such write
 * surface reached from the sandbox (`entities_created_by_fkey`, ON DELETE RESTRICT).
 *
 * An automation or agent is a policy principal, NOT a "user" row, so a headless
 * automation-driven write — a script executor runs with userId == null — cannot
 * attribute the row to itself, and the "system" sentinel has no user row either, so
 * it fails the FK. Attribute to the acting automation's OWNER, the human who created
 * that automation, exactly as the approval-apply path attributes an
 * automation-proposed create to the human who approved it (`entity-field-approval.ts`).
 *
 * Only the TRUSTED session automation (stamped by the reaction/script executor) is
 * used — never a caller-supplied `automation_source` tag, which is unverified here and
 * would let any org caller select another automation's owner as the creator. The
 * lookup JOINs "user" so a dangling `automations.created_by` (a deleted user, or a
 * historical "system"/agent value — that column has no FK of its own) is never stamped
 * back into the FK-constrained column. Anything unresolved falls back to
 * {@link resolveEntityCreator} (the org's longest-standing owner/admin), the same
 * attribution every other lazily-created system entity uses, so this never yields the
 * FK-invalid "system" sentinel. Returns null only for an org with no members at all.
 */
export async function resolveWriteCreatorUserId(
	sql: DbClient,
	args: {
		organizationId: string;
		userId?: string | null;
		sessionAutomationId?: number | null;
	},
): Promise<string | null> {
	if (args.userId) return args.userId;
	if (args.sessionAutomationId != null) {
		const rows = await sql<{ created_by: string }>`
    SELECT a.created_by
    FROM automations a
    JOIN "user" u ON u.id = a.created_by
    WHERE a.id = ${args.sessionAutomationId}
      AND a.organization_id = ${args.organizationId}
    LIMIT 1
  `;
		if (rows[0]?.created_by) return rows[0].created_by;
	}
	return resolveEntityCreator(sql, args.organizationId, null);
}

/** True iff an agent row with this id exists in the org. Org-scoped so a caller
 * can't probe another tenant's agent namespace. */
export async function agentExistsInOrg(
	sql: DbClient,
	agentId: string,
	organizationId: string,
): Promise<boolean> {
	const rows = await sql<{ one: number }>`
    SELECT 1 AS one FROM agents
    WHERE id = ${agentId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
	return rows.length > 0;
}

/**
 * The winning mode's effect on a mutation. `deny` and `disabled` both stop the
 * write with no approval queued; `approval` queues one; `auto` applies inline.
 * Centralized so the create/delete and per-field update paths agree — and so a
 * future mode can never be read as `allow` by omission.
 */
function modeToDecision(mode: EntityMutationMode): EntityPolicyDecision {
	if (mode === "deny" || mode === "disabled") return "deny";
	if (mode === "approval") return "require_approval";
	return "allow";
}

/**
 * Target-scope specificity: entity_id > field_path > entity_type > global. Weights
 * are strictly ordered so a more-specific scope always outranks a broader one.
 */
function scopeSpecificity(row: EntityApprovalPolicyRow): number {
	return (
		(row.entity_id !== null ? 4 : 0) +
		(row.field_path !== null ? 2 : 0) +
		// operation_key (connector_action), entity_type_slug (entity), and
		// target_agent_id (agent_config) are mutually exclusive scope dimensions on
		// disjoint classes; each is that class's finest non-instance scope, so they
		// share weight 1. A row with any set outranks the blanket row for delivery
		// target ordering (decision fold is still max-restrictive).
		(row.entity_type_slug !== null ? 1 : 0) +
		(row.operation_key !== null ? 1 : 0) +
		(row.target_agent_id !== null ? 1 : 0)
	);
}

/** Principal specificity: exact id > kind-wide > any. Used only to break scope ties. */
function principalSpecificity(row: EntityApprovalPolicyRow): number {
	return row.principal_id !== null ? 2 : row.principal_kind !== null ? 1 : 0;
}

/** Restrictive rank of a single stored mode — higher = more restrictive. */
function modeRestrictiveness(mode: EntityMutationMode): number {
	if (mode === "deny") return 3;
	if (mode === "disabled") return 3;
	if (mode === "approval") return 2;
	return 1; // auto
}

/**
 * The more-restrictive of two modes (deny/disabled > approval > auto).
 *
 * `deny` and `disabled` are equally restrictive (both stop the write), so a fold
 * that mixes them must pick one DETERMINISTICALLY — not by candidate order, which
 * would make the resolved effect depend on scope specificity and diverge from what
 * the UI (which folds the same rows without that ordering) shows. We break the tie
 * toward `deny`: it is the safer, more-visible outcome — `list_available` still
 * SURFACES the op and gates it, rather than silently hiding it as `disabled` does.
 * The UI mirrors this exact rule (see EFFECT_STRICTNESS + stricterEffect).
 */
function moreRestrictive(
	a: EntityMutationMode,
	b: EntityMutationMode,
): EntityMutationMode {
	const ra = modeRestrictiveness(a);
	const rb = modeRestrictiveness(b);
	if (ra !== rb) return ra > rb ? a : b;
	// Equal rank: only deny/disabled tie here; prefer deny deterministically.
	return a === "deny" || b === "deny" ? "deny" : a;
}

/**
 * The effective effect for one action, folded MAX-RESTRICTIVE across the matched
 * rows that ADDRESS this action — the org-floor rule generalized. Two rules,
 * both deliberate (see the write-gate v1.1 design):
 *
 *  1. The class default is a STARTING POINT, not a floor. If ANY row explicitly
 *     sets this action, the default drops out entirely — an admin who sets
 *     `agent_config update = auto` gets auto even though the default is approval.
 *     Only when NO row addresses the action does the class default apply.
 *  2. Among the rows that DO set the action, the MOST RESTRICTIVE wins,
 *     regardless of scope. A broad org `approval` is never loosened by a narrow
 *     agent `auto`; a per-type `auto` never opens a hole a per-agent `approval`
 *     meant to close. This is the OPPOSITE of SQL GRANT precedence (where a
 *     more-specific grant widens) — the floor must hold.
 *
 * A row "addresses" the action only when it stored an explicit effect for it
 * (`row.effects[action]` present). A sparse override that names other actions
 * does NOT pull this action toward its class default — it simply abstains.
 */
function foldEffectForAction(
	candidates: EntityApprovalPolicyRow[],
	resourceClass: WriteResourceClass,
	action: WriteAction,
): EntityMutationMode {
	let folded: EntityMutationMode | null = null;
	for (const row of candidates) {
		const stored = row.effects[action];
		if (stored === undefined) continue; // row abstains on this action
		folded = folded === null ? stored : moreRestrictive(folded, stored);
	}
	return folded ?? defaultEffectFor(resourceClass, action);
}

/** Effective effect for one action (single envelope for all agent runs). */
function foldEffectForDecision(
	candidates: EntityApprovalPolicyRow[],
	resourceClass: WriteResourceClass,
	action: WriteAction,
): EntityMutationMode {
	return foldEffectForAction(candidates, resourceClass, action);
}

/**
 * Order candidate rows most-specific first — used ONLY to choose the delivery
 * target (which Slack channel an approval card lands in), NOT the decision. The
 * decision is a max-restrictive fold ({@link foldEffectForAction}); specificity
 * would let a narrow `auto` mask a broad `approval`, so it must not drive it.
 * TARGET SCOPE specificity first, then principal specificity, then id for
 * determinism.
 */
function compareCandidates(
	a: EntityApprovalPolicyRow,
	b: EntityApprovalPolicyRow,
): number {
	return (
		scopeSpecificity(b) - scopeSpecificity(a) ||
		principalSpecificity(b) - principalSpecificity(a) ||
		Number(b.id) - Number(a.id)
	);
}

/**
 * All policy rows that could match this write, most specific first. Filters by
 * resource class (default `entity`) and by principal: a row applies when it
 * targets no principal (any), or targets this principal's kind and either no
 * specific id (any of that kind) or exactly this id.
 */
type ActionEffectRow = { policy_id: number; action: string; effect: string };

/**
 * Attach each header row's child action→effect rows in one batched query (keyed
 * by policy_id, no N+1).
 *
 * Fail-closed on a bad STORED value: when a child row exists for an action but
 * carries an effect this build can't recognize or the manifest declares illegal
 * for the class (a value a future build introduced mid-rolling-upgrade, or
 * corrupt data from manual SQL), the action is pinned to `deny` — never silently
 * dropped. Dropping would let the resolver fall back to the class default (which
 * for entity create is `auto`), reading a stored-but-unknown value as `allow`.
 * An ABSENT action (no child row at all) is different: that's a sparse override,
 * and it correctly inherits the class default.
 */
async function attachEffects(
	sql: DbClient,
	rows: EntityApprovalPolicyRow[],
): Promise<EntityApprovalPolicyRow[]> {
	for (const row of rows) row.effects = {};
	if (rows.length === 0) return rows;
	const byId = new Map(rows.map((r) => [Number(r.id), r]));
	const ids = rows.map((r) => Number(r.id));
	const effects = await sql<ActionEffectRow>`
    SELECT policy_id, action, effect
    FROM write_policy_action_effects
    WHERE policy_id = ANY(${pgBigintArray(ids)})
  `;
	for (const e of effects) {
		const row = byId.get(Number(e.policy_id));
		if (!row || !isWriteAction(e.action)) continue;
		const legal =
			isEntityMutationMode(e.effect) &&
			isLegalActionEffect(
				normalizeResourceClass(row.resource_class),
				e.action,
				e.effect,
			);
		// Pin an unknown/illegal stored effect to `deny` (fail closed), never drop.
		row.effects[e.action] =
			legal && isEntityMutationMode(e.effect) ? e.effect : "deny";
	}
	return rows;
}

function isWriteAction(value: unknown): value is WriteAction {
	return (
		value === "read" ||
		value === "create" ||
		value === "update" ||
		value === "delete" ||
		value === "execute" ||
		value === "create_type" ||
		value === "update_type" ||
		value === "delete_type" ||
		value === "create_relationship_type" ||
		value === "update_relationship_type" ||
		value === "delete_relationship_type"
	);
}

async function loadCandidatePolicies(args: {
	organizationId: string;
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
	/**
	 * The OWNING AGENT of an automation, when an automation acts under its agent's
	 * envelope. The write is then governed by BOTH the automation's own rows (the
	 * primary `principalKind='automation'`) AND the agent's rows, folded max-
	 * restrictive — so a pre-existing automation-specific `deny` can only tighten and
	 * the agent envelope can never loosen it away. Null = no owning agent (the
	 * only two-principal case in the model: `automations.managed_agent_id` is the sole
	 * principal-ownership edge, so there is never a third principal to fold).
	 */
	ownerAgentId?: string | null;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	/** The connector operation being run (connector_action only). Loads BOTH the
	 * blanket row (operation_key IS NULL) and any row scoped to this operation; the
	 * op-specific row wins via {@link scopeSpecificity}. */
	operationKey?: string | null;
	/** Batch form used by operation discovery: load the blanket plus every named
	 * operation in one header query, then fold each operation in memory. */
	operationKeys?: string[];
	/** agent_config: target agents.id being updated/deleted. Loads blanket + that target. */
	targetAgentId?: string | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicyRow[]> {
	const sql = args.sql ?? getDb();
	const resourceClass = args.resourceClass ?? "entity";
	const principalKind = args.principalKind ?? null;
	const principalId = args.principalId ?? null;
	const ownerAgentId = args.ownerAgentId ?? null;
	const operationKeys =
		args.operationKeys ??
		(args.operationKey == null ? [] : [args.operationKey]);
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, resource_class, principal_kind, principal_id,
       operation_key, target_agent_id, entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM write_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND resource_class = ${resourceClass}
      AND (
        principal_kind IS NULL
        OR (
          principal_kind = ${principalKind}
          AND (principal_id IS NULL OR principal_id = ${principalId})
        )
        OR (
          ${ownerAgentId}::text IS NOT NULL
          AND principal_kind = 'agent'
          AND (principal_id IS NULL OR principal_id = ${ownerAgentId})
        )
      )
		AND (operation_key IS NULL OR operation_key = ANY(${pgTextArray(operationKeys)}::text[]))
      AND (target_agent_id IS NULL OR target_agent_id = ${args.targetAgentId ?? null})
      AND (entity_type_slug IS NULL OR entity_type_slug = ${args.entityTypeSlug ?? null})
      AND (entity_id IS NULL OR entity_id = ${args.entityId ?? null})
  `;
	const list = [...rows];
	await attachEffects(sql, list);
	return list.sort(compareCandidates);
}

function pickPolicy(
	candidates: EntityApprovalPolicyRow[],
	organizationId: string,
	fieldPath: string | null,
): EntityApprovalPolicy {
	const match = candidates.find(
		(row) => row.field_path === null || row.field_path === fieldPath,
	);
	if (!match) return defaultEntityApprovalPolicy(organizationId);
	const policy = rowToPolicy(match);
	// Scoped rows don't carry their own channel — inherit the workspace
	// default's delivery target so scoped approvals still land in the
	// configured channel rather than falling back to generic admin fan-out.
	if (!policy.deliveryTarget.connectionId && !policy.deliveryTarget.channelId) {
		const global = candidates.find(
			(row) =>
				row.principal_kind === null &&
				row.entity_type_slug === null &&
				row.field_path === null &&
				row.entity_id === null,
		);
		if (global) {
			policy.deliveryTarget = rowToPolicy(global).deliveryTarget;
		}
	}
	return policy;
}

/**
 * The policy row governing one prospective mutation (used both for the
 * approval decision and for the Slack delivery target of the approval card).
 */
export async function resolveEntityApprovalPolicy(args: {
	organizationId: string;
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicy> {
	const candidates = await loadCandidatePolicies(args);
	return pickPolicy(candidates, args.organizationId, args.fieldPath ?? null);
}

/**
 * Decision for entity read/create/delete (and whole-entity update). `entityOrgId`
 * is the org of the row being touched (from the locked/fetched entity); a
 * mismatch is always a deny. `read` is the visibility gate for manage_entity
 * get/list — approval collapses to deny (you can't queue a read).
 */
export async function evaluateEntityMutation(args: {
	organizationId: string;
	principalKind: EntityPolicyPrincipalKind;
	/** Stable acting-principal id for per-principal matching; null = any of its kind. */
	principalId?: string | null;
	/**
	 * The owning agent of an automation — folds the agent's rows in alongside the
	 * automation's, max-restrictive. See {@link loadCandidatePolicies}.
	 */
	ownerAgentId?: string | null;
	action: EntityMutationAction;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	entityOrgId?: string | null;
	/**
	 * False iff the acting principal is an automation whose owning agent could not be
	 * resolved (its row is gone). Fail CLOSED — the agent envelope can't be folded,
	 * so we deny rather than run the write against the looser org default. Defaults
	 * true (agent/user turns, and automations whose owner resolved).
	 */
	ownerResolved?: boolean;
	sql?: DbClient;
}): Promise<EntityPolicyDecision> {
	if (args.entityOrgId && args.entityOrgId !== args.organizationId) {
		return "deny";
	}
	if (args.principalKind === "user") return "allow";
	if (args.ownerResolved === false) return "deny";
	const candidates = await loadCandidatePolicies({
		...args,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
	});
	// create/delete/read act on the WHOLE entity, not any one field — a field-scoped
	// row (e.g. person.ssn=deny) governs only its field's UPDATES and must not
	// bleed into the entity's create/delete/read decision. Drop field-scoped rows here
	// (the update path keeps them, matched per-field). What remains — the org
	// floor, blanket, and type-scoped rows — folds max-restrictive.
	const forEntity = candidates.filter((row) => row.field_path === null);
	const decision = modeToDecision(
		foldEffectForDecision(forEntity, "entity", args.action),
	);
	// Reads never queue: approval is treated as deny (stricter than auto, no inbox).
	if (args.action === "read" && decision === "require_approval") return "deny";
	return decision;
}

/**
 * Class-generic write decision for a non-scoped resource (agent_config today;
 * connector_action later). Humans with any org membership apply immediately —
 * the write-gate governs non-human principals; role restrictions for humans live
 * in the tool-access tier. For an agent/automation, the matched policy row wins;
 * with no row, the class default applies. Entity writes keep their own scoped
 * paths ({@link evaluateEntityMutation} / {@link evaluateEntityFieldUpdates}).
 */
export async function resolveWritePolicyDecision(args: {
	organizationId: string;
	resourceClass: Exclude<WriteResourceClass, "entity">;
	principalKind: EntityPolicyPrincipalKind;
	principalId?: string | null;
	/**
	 * The owning agent of an automation — folds the agent's rows in alongside the
	 * automation's, max-restrictive. Set for an automation-attributed connector/agent_config
	 * write (e.g. a reaction script's `client.operations.execute`) so the agent's
	 * envelope binds and an automation-specific rule can only tighten. See
	 * {@link loadCandidatePolicies}.
	 */
	ownerAgentId?: string | null;
	/** See {@link resolveWriteEffect}. Fail closed (deny) when an automation owner is unresolved. */
	ownerResolved?: boolean;
	action: WriteAction;
	/** connector_action only: the operation being run — a per-op row tightens the
	 * blanket execute rule for it alone. Forwarded to {@link resolveWriteEffect}. */
	operationKey?: string | null;
	/** agent_config only: target agent id for read/update/delete. */
	targetAgentId?: string | null;
	sql?: DbClient;
}): Promise<EntityPolicyDecision> {
	const decision = modeToDecision(await resolveWriteEffect(args));
	// Reads cannot usefully queue approval; treat like entity evaluateEntityMutation.
	if (args.action === "read" && decision === "require_approval") return "deny";
	return decision;
}

/**
 * The raw folded EFFECT (auto/approval/deny/disabled) for a non-scoped resource,
 * before it collapses to a decision. `disabled` and `deny` both stop the write,
 * but callers that must DISTINGUISH them — e.g. `list_available` hides a disabled
 * connector's operations rather than surfacing them to fail on execute — need the
 * effect, not the decision. A human always resolves `auto`.
 */
export async function resolveWriteEffect(args: {
	organizationId: string;
	resourceClass: Exclude<WriteResourceClass, "entity">;
	principalKind: EntityPolicyPrincipalKind;
	principalId?: string | null;
	ownerAgentId?: string | null;
	/**
	 * False iff an automation whose owning agent could not be resolved (its row is
	 * gone) — fail CLOSED to `deny` so the write can't slip its agent's envelope.
	 * See {@link evaluateEntityMutation}. Defaults true.
	 */
	ownerResolved?: boolean;
	action: WriteAction;
	/** connector_action only: the operation being run (e.g. 'slack.send_message').
	 * A row scoped to this op tightens the blanket execute rule for it alone. */
	operationKey?: string | null;
	/** agent_config only: target agent id for read/update/delete. */
	targetAgentId?: string | null;
	sql?: DbClient;
}): Promise<EntityMutationMode> {
	if (args.principalKind === "user") return "auto";
	if (args.ownerResolved === false) return "deny";
	const candidates = await loadCandidatePolicies({
		organizationId: args.organizationId,
		resourceClass: args.resourceClass,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
		operationKey: args.operationKey ?? null,
		targetAgentId: args.targetAgentId ?? null,
		sql: args.sql,
	});
	return foldEffectForDecision(candidates, args.resourceClass, args.action);
}

/**
 * Batch connector-operation effects for discovery. Candidate headers and child
 * effects are loaded once, then each operation is folded in memory.
 */
export async function resolveWriteEffects(args: {
	organizationId: string;
	resourceClass: "connector_action";
	principalKind: EntityPolicyPrincipalKind;
	principalId?: string | null;
	ownerAgentId?: string | null;
	ownerResolved?: boolean;
	action: WriteAction;
	operationKeys: string[];
	sql?: DbClient;
}): Promise<Map<string | null, EntityMutationMode>> {
	const keys = [...new Set(args.operationKeys)];
	const effects = new Map<string | null, EntityMutationMode>();
	if (args.principalKind === "user" || args.ownerResolved === false) {
		const effect = args.principalKind === "user" ? "auto" : "deny";
		effects.set(null, effect);
		for (const key of keys) effects.set(key, effect);
		return effects;
	}

	const candidates = await loadCandidatePolicies({
		organizationId: args.organizationId,
		resourceClass: args.resourceClass,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
		operationKeys: keys,
		sql: args.sql,
	});
	const foldFor = (operationKey: string | null) =>
		foldEffectForDecision(
			candidates.filter(
				(candidate) =>
					candidate.operation_key === null ||
					candidate.operation_key === operationKey,
			),
			args.resourceClass,
			args.action,
		);
	effects.set(null, foldFor(null));
	for (const key of keys) effects.set(key, foldFor(key));
	return effects;
}

/**
 * Per-field decisions for a non-human update, from ONE policy query. A field
 * needs approval when the matched policy says so, or — regardless of policy —
 * when the field is human-owned.
 */
export async function evaluateEntityFieldUpdates(args: {
	organizationId: string;
	principalKind: EntityPolicyPrincipalKind;
	/** Stable acting-principal id for per-principal matching; null = any of its kind. */
	principalId?: string | null;
	/** The automation's owning agent, folded alongside — see {@link evaluateEntityMutation}. */
	ownerAgentId?: string | null;
	/**
	 * False iff an automation whose owning agent could not be resolved — deny every
	 * field (fail closed). See {@link evaluateEntityMutation}. Defaults true.
	 */
	ownerResolved?: boolean;
	entityTypeSlug: string;
	entityId: number;
	entityOrgId?: string | null;
	/** field path -> current owner ("human" pins the field). */
	fields: Record<string, "human" | "none">;
	sql?: DbClient;
}): Promise<Record<string, EntityPolicyDecision>> {
	const decisions: Record<string, EntityPolicyDecision> = {};
	if (args.entityOrgId && args.entityOrgId !== args.organizationId) {
		for (const field of Object.keys(args.fields)) decisions[field] = "deny";
		return decisions;
	}
	if (args.principalKind === "user") {
		for (const field of Object.keys(args.fields)) decisions[field] = "allow";
		return decisions;
	}
	if (args.ownerResolved === false) {
		for (const field of Object.keys(args.fields)) decisions[field] = "deny";
		return decisions;
	}
	const candidates = await loadCandidatePolicies({
		...args,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
	});
	for (const [field, owner] of Object.entries(args.fields)) {
		// Fold max-restrictive over every candidate that applies to THIS field
		// (its own field_path row, plus all field-agnostic rows). The org floor
		// holds and a field-scoped override can only tighten.
		const forField = candidates.filter(
			(row) => row.field_path === null || row.field_path === field,
		);
		const policyDecision = modeToDecision(
			foldEffectForDecision(forField, "entity", "update"),
		);
		// A human-owned field always needs approval regardless of policy mode; a
		// deny/disabled policy stops even a human-owned change (deny is a hard floor).
		decisions[field] =
			policyDecision === "deny"
				? "deny"
				: owner === "human" || policyDecision === "require_approval"
					? "require_approval"
					: "allow";
	}
	return decisions;
}

/**
 * Every policy row for an org, most-general first. Filter by class to list one
 * class's rows; omit to list all.
 */
export async function listEntityApprovalPolicies(
	organizationId: string,
	resourceClass?: WriteResourceClass,
): Promise<EntityApprovalPolicy[]> {
	const sql = getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, resource_class, principal_kind, principal_id,
       operation_key, target_agent_id, entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM write_approval_policies
    WHERE organization_id = ${organizationId}
      AND (${resourceClass ?? null}::text IS NULL OR resource_class = ${resourceClass ?? null})
    ORDER BY
      resource_class ASC,
      CASE WHEN principal_kind IS NULL THEN 0 ELSE 1 END,
      principal_kind ASC NULLS FIRST,
      principal_id ASC NULLS FIRST,
      CASE WHEN operation_key IS NULL THEN 0 ELSE 1 END,
      operation_key ASC NULLS FIRST,
      CASE WHEN entity_type_slug IS NULL THEN 0 ELSE 1 END,
      entity_type_slug ASC NULLS FIRST,
      CASE WHEN entity_id IS NULL THEN 0 ELSE 1 END,
      entity_id ASC NULLS FIRST,
      CASE WHEN field_path IS NULL THEN 0 ELSE 1 END,
      field_path ASC NULLS FIRST,
      id ASC
  `;
	await attachEffects(sql, [...rows]);
	return rows.map(rowToPolicy);
}

/**
 * Turn a policy input into the action→effect set to persist for the given class.
 * For the entity-shaped classes the effects come from create/update/delete (and
 * read); for connector_action the single `execute` effect is taken from
 * `createMode` when no effects map is provided. Effects are clamped to what the
 * manifest declares legal for the class.
 */
function actionEffectSetForInput(
	resourceClass: WriteResourceClass,
	input: EntityApprovalPolicyInput,
): Array<{ action: WriteAction; effect: EntityMutationMode }> {
	const clamp = (action: WriteAction, effect: EntityMutationMode) =>
		isLegalActionEffect(resourceClass, action, effect)
			? effect
			: defaultEffectFor(resourceClass, action);
	// Raw effects map wins when provided (the agent Permissions path). Persist ONLY
	// the actions the caller named — this is a SPARSE override, so an omitted action
	// must NOT get an explicit row that pins it to the class default. A stored row
	// stops the action from abstaining (see foldEffectForAction), which would freeze
	// it against later attended/blanket changes. Only actions THIS CLASS governs.
	if (input.effects) {
		const governed = new Set(WRITE_ACTION_MANIFEST[resourceClass].actions);
		return (Object.keys(input.effects) as WriteAction[])
			.filter(
				(action) =>
					governed.has(action) && input.effects?.[action] !== undefined,
			)
			.map((action) => ({
				action,
				effect: clamp(action, input.effects?.[action] as EntityMutationMode),
			}));
	}
	if (resourceClass === "connector_action") {
		return [
			{
				action: "execute",
				effect: clamp("execute", normalizeMode(input.createMode, "auto")),
			},
		];
	}
	if (resourceClass === "entity_schema") {
		throw new Error("entity_schema policies require an explicit effects map");
	}
	return [
		{
			action: "create",
			effect: clamp("create", normalizeMode(input.createMode, "auto")),
		},
		{
			action: "update",
			effect: clamp("update", normalizeMode(input.updateMode, "auto")),
		},
		{
			action: "delete",
			effect: clamp("delete", normalizeMode(input.deleteMode, "approval")),
		},
	];
}

/** Replace a policy's child action-effect rows with the given complete set. */
async function writeActionEffects(
	tx: DbClient,
	policyId: number,
	set: Array<{ action: WriteAction; effect: EntityMutationMode }>,
): Promise<void> {
	await tx`DELETE FROM write_policy_action_effects WHERE policy_id = ${policyId}`;
	for (const { action, effect } of set) {
		await tx`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${policyId}, ${action}, ${effect})
    `;
	}
}

export async function upsertEntityApprovalPolicy(
	organizationId: string,
	input: EntityApprovalPolicyInput,
): Promise<EntityApprovalPolicy> {
	const resourceClass = normalizeResourceClass(input.resourceClass);
	const principalKind = normalizePrincipalKind(input.principalKind);
	// A principal id is only meaningful with a kind; ignore it otherwise.
	const principalId = principalKind ? input.principalId?.trim() || null : null;
	// operation_key scopes a connector_action row to one operation; meaningless (and
	// dropped) for any other class so an entity/agent_config row can't smuggle one in.
	const operationKey =
		resourceClass === "connector_action"
			? input.operationKey?.trim() || null
			: null;
	const targetAgentId =
		resourceClass === "agent_config"
			? input.targetAgentId?.trim() || null
			: null;
	const entityTypeSlug =
		resourceClass === "entity" ? input.entityTypeSlug?.trim() || null : null;
	const fieldPath =
		resourceClass === "entity" ? input.fieldPath?.trim() || null : null;
	const entityId = resourceClass === "entity" ? (input.entityId ?? null) : null;
	const effectSet = actionEffectSetForInput(resourceClass, input);
	const approvalConnectionId = input.approvalConnectionId?.trim() || null;
	const approvalChannelId = input.approvalChannelId?.trim() || null;
	const approvalTeamId = input.approvalTeamId?.trim() || null;
	const approvalChannelName = input.approvalChannelName?.trim() || null;
	// Effect-only callers (the permissions PUT) don't carry a delivery target and
	// must not clobber the one already stored. When preserveDelivery is set, COALESCE
	// each column to its existing value so an omitted (null) field keeps the header's
	// current target; a caller that MEANS to write delivery leaves the flag unset.
	const preserveDelivery = input.preserveDelivery === true;

	const sql = getDb();
	// Upsert the header row (scope/principal/delivery only — effects live in the
	// child table). The identity tuple the unique index keys on; reused by both
	// UPDATE arms so the "lost the insert race" recovery targets the same row.
	const applyUpdate = (tx: DbClient) => tx<EntityApprovalPolicyRow>`
      UPDATE write_approval_policies
      SET approval_connection_id = ${
				preserveDelivery
					? sql`COALESCE(approval_connection_id, ${approvalConnectionId})`
					: approvalConnectionId
			},
          approval_channel_id = ${
						preserveDelivery
							? sql`COALESCE(approval_channel_id, ${approvalChannelId})`
							: approvalChannelId
					},
          approval_team_id = ${
						preserveDelivery
							? sql`COALESCE(approval_team_id, ${approvalTeamId})`
							: approvalTeamId
					},
          approval_channel_name = ${
						preserveDelivery
							? sql`COALESCE(approval_channel_name, ${approvalChannelName})`
							: approvalChannelName
					},
          updated_at = now()
      WHERE organization_id = ${organizationId}
        AND resource_class = ${resourceClass}
        AND principal_kind IS NOT DISTINCT FROM ${principalKind}
        AND principal_id IS NOT DISTINCT FROM ${principalId}
        AND operation_key IS NOT DISTINCT FROM ${operationKey}
        AND target_agent_id IS NOT DISTINCT FROM ${targetAgentId}
        AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
        AND field_path IS NOT DISTINCT FROM ${fieldPath}
        AND entity_id IS NOT DISTINCT FROM ${entityId}
      RETURNING id, organization_id, resource_class, principal_kind, principal_id,
       operation_key, target_agent_id, entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;

	const row = await sql.begin(async (tx) => {
		let header = (await applyUpdate(tx))[0] ?? null;

		if (!header) {
			const inserted = await tx<EntityApprovalPolicyRow>`
      INSERT INTO write_approval_policies (
        organization_id, resource_class, principal_kind, principal_id,
        operation_key, target_agent_id, entity_type_slug, field_path, entity_id,
        approval_connection_id, approval_channel_id, approval_team_id,
        approval_channel_name, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${resourceClass}, ${principalKind}, ${principalId},
        ${operationKey}, ${targetAgentId}, ${entityTypeSlug}, ${fieldPath}, ${entityId},
        ${approvalConnectionId},
        ${approvalChannelId}, ${approvalTeamId}, ${approvalChannelName},
        now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING id, organization_id, resource_class, principal_kind, principal_id,
       operation_key, target_agent_id, entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;
			header = inserted[0] ?? null;
			// Lost the insert race to a concurrent save — apply this request on top.
			if (!header) header = (await applyUpdate(tx))[0] ?? null;
		}

		if (!header) return null;
		await writeActionEffects(tx, Number(header.id), effectSet);
		header.effects = {};
		for (const { action, effect } of effectSet) header.effects[action] = effect;
		return header;
	});
	if (!row) throw new Error("Failed to save entity approval policy");
	return rowToPolicy(row);
}

export async function deleteEntityApprovalPolicy(args: {
	organizationId: string;
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
	operationKey?: string | null;
	targetAgentId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
}): Promise<boolean> {
	const resourceClass = normalizeResourceClass(args.resourceClass);
	const principalKind = normalizePrincipalKind(args.principalKind);
	const principalId = principalKind ? args.principalId?.trim() || null : null;
	const operationKey =
		resourceClass === "connector_action"
			? args.operationKey?.trim() || null
			: null;
	const targetAgentId =
		resourceClass === "agent_config"
			? args.targetAgentId?.trim() || null
			: null;
	const entityTypeSlug =
		resourceClass === "entity" ? args.entityTypeSlug?.trim() || null : null;
	const fieldPath =
		resourceClass === "entity" ? args.fieldPath?.trim() || null : null;
	const entityId = resourceClass === "entity" ? (args.entityId ?? null) : null;
	// Guard: never let a request delete the workspace default (entity class, any
	// principal, unscoped) — that row is the fallback and is edited, not removed.
	if (
		resourceClass === "entity" &&
		principalKind === null &&
		!entityTypeSlug &&
		!fieldPath &&
		entityId === null
	) {
		return false;
	}
	const sql = getDb();
	const rows = await sql<{ id: number }>`
    DELETE FROM write_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND resource_class = ${resourceClass}
      AND principal_kind IS NOT DISTINCT FROM ${principalKind}
      AND principal_id IS NOT DISTINCT FROM ${principalId}
      AND operation_key IS NOT DISTINCT FROM ${operationKey}
      AND target_agent_id IS NOT DISTINCT FROM ${targetAgentId}
      AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
      AND field_path IS NOT DISTINCT FROM ${fieldPath}
      AND entity_id IS NOT DISTINCT FROM ${entityId}
    RETURNING id
  `;
	return rows.length > 0;
}
