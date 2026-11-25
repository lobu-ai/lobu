/**
 * The write-action manifest — the single code-side source of truth for which
 * (resource class, action, effect) tuples are legal, and the per-(class, action)
 * default effect when no policy row matches.
 *
 * This replaces the positional create_mode/update_mode/delete_mode columns: a
 * policy is now `(scope, principal) → { action → effect }`, and each class
 * declares its own action vocabulary here rather than cramming every verb into
 * three fixed columns. `connector_action` has a single `execute` action instead
 * of being forced onto `create_mode`.
 *
 * A parallel DB CHECK mirrors this map (a TS object can't govern SQL or stored
 * rows on its own). When the two disagree — a stored row carrying an action or
 * effect this build no longer declares — the resolver fails CLOSED (deny), never
 * silently `auto`. See {@link isLegalActionEffect} and {@link defaultEffectFor}.
 */
import type { WriteResourceClass } from "./entity-policy";

/**
 * The verbs a write policy can govern. `read`/`create`/`update`/`delete` are
 * shared by entity and agent_config (`read` scopes which entity types / peer
 * agents a principal may see); `execute` is the connector_action verb (running
 * any connector operation). `install` is intentionally NOT declared until a
 * class actually uses it — an undeclared action is illegal, not a reserved no-op.
 */
export type WriteAction =
	| "read"
	| "create"
	| "update"
	| "delete"
	| "execute"
	| "create_type"
	| "update_type"
	| "delete_type"
	| "create_relationship_type"
	| "update_relationship_type"
	| "delete_relationship_type";

/**
 * The decision a policy attaches to an action, least to most strict. `auto`
 * applies inline; `log` applies inline and records why on the activity;
 * `check` holds the run until the requesting agent confirms it with a short
 * statement; `approval` queues a durable human approval; `deny` blocks
 * execution without queuing approval. `log` and `check` are guardrail-only
 * connector effects.
 */
export const WRITE_EFFECTS = ["auto", "log", "check", "approval", "deny"] as const;
export type WriteEffect = (typeof WRITE_EFFECTS)[number];

export function isWriteEffect(value: unknown): value is WriteEffect {
	return WRITE_EFFECTS.includes(value as WriteEffect);
}

/** Strictness of an effect; the strictest matching rule wins. */
export function writeEffectRank(effect: WriteEffect): number {
	return WRITE_EFFECTS.indexOf(effect);
}

interface ClassManifest {
	/** The actions this class governs. An action outside this set is illegal for the class. */
	readonly actions: readonly WriteAction[];
	/** The effects legal for this class. An effect outside this set is illegal for the class. */
	readonly effects: readonly WriteEffect[];
	/** The effect applied when no policy row matches, per action. */
	readonly defaultEffect: Readonly<Partial<Record<WriteAction, WriteEffect>>>;
}

/**
 * Per-class legal actions/effects + no-row defaults. Defaults are stated
 * EXPLICITLY for every legal action, so an action a class does not declare
 * resolves to deny rather than an implicit `auto`. Holds and blocks come from
 * explicit rules; the defaults below are what applies when none matches.
 */
export const WRITE_ACTION_MANIFEST: Readonly<
	Record<WriteResourceClass, ClassManifest>
> = {
	entity: {
		// `read` is auto/deny in the UI (approval is legal but treated as deny at
		// the read gate — you can't "queue" a read for human review usefully).
		actions: ["read", "create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		// With no matching rule an agent reads and writes entities directly. Entity
		// delete is a soft delete (tombstone), so an Ask or Block rule is how a
		// workspace holds it.
		defaultEffect: {
			read: "auto",
			create: "auto",
			update: "auto",
			delete: "auto",
		},
	},
	agent_config: {
		// `read` = list/get other agents (and their config surface). Auto/deny in
		// the UI; approval collapses to deny at the gate. create/update/delete
		// remain definition CRUD; invoke/call is not a legal action until a
		// first-class handoff path exists.
		actions: ["read", "create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		// With no matching rule an agent reads, creates and updates agents directly.
		// Delete stays denied: deleting an agent is a hard delete that cascades its
		// bindings, connections and grants, so a human deletes agents.
		// Target exceptions only tighten (max-restrictive fold): use default auto +
		// per-target deny to blacklist; a per-target auto cannot open a blanket deny.
		defaultEffect: {
			read: "auto",
			create: "auto",
			update: "auto",
			delete: "deny",
		},
	},
	skill_config: {
		// The workspace skill library (manage_skills). `read` = list/get. Archive
		// is `delete`; changing a skill's `applies_to` is `update`. No target
		// scope: a rule covers every skill in the workspace. With no matching rule
		// every action is Auto. Unlike agent_config, delete is Auto too: deleting
		// a skill archives it (a soft delete that keeps the row), so it is not
		// destructive the way deleting an agent is.
		actions: ["read", "create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		defaultEffect: {
			read: "auto",
			create: "auto",
			update: "auto",
			delete: "auto",
		},
	},
	connector_action: {
		// All operations use org policy; an action no rule matches runs Auto.
		// `log` and `check` are legal only on guardrails (validatePolicyKindAndNote).
		actions: ["execute"],
		effects: ["auto", "log", "check", "approval", "deny"],
		defaultEffect: {
			execute: "auto",
		},
	},
	entity_schema: {
		actions: [
			"create_type",
			"update_type",
			"delete_type",
			"create_relationship_type",
			"update_relationship_type",
			"delete_relationship_type",
		],
		effects: ["auto", "approval", "deny"],
		// Preserve the historical owner/admin semantics until a workspace opts in.
		defaultEffect: {
			create_type: "auto",
			update_type: "auto",
			delete_type: "auto",
			create_relationship_type: "auto",
			update_relationship_type: "auto",
			delete_relationship_type: "auto",
		},
	},
};

/** True when `(action, effect)` is a legal pair for this class. */
export function isLegalActionEffect(
	resourceClass: WriteResourceClass,
	action: WriteAction,
	effect: WriteEffect,
): boolean {
	const m = WRITE_ACTION_MANIFEST[resourceClass];
	return m.actions.includes(action) && m.effects.includes(effect);
}

/**
 * The no-row default effect for a (class, action). An action the class does not
 * govern falls back to `deny` — asking "what happens by default when an automation
 * does X" for an X this class can't do is answered fail-closed.
 */
export function defaultEffectFor(
	resourceClass: WriteResourceClass,
	action: WriteAction,
): WriteEffect {
	const m = WRITE_ACTION_MANIFEST[resourceClass];
	if (!m.actions.includes(action)) return "deny";
	return m.defaultEffect[action] ?? "deny";
}
