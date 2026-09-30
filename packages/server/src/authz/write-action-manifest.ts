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
 * The decision a policy attaches to an action. `auto` applies inline; `approval`
 * queues a durable approval; `deny` blocks execution without queuing approval.
 */
export type WriteEffect = "auto" | "approval" | "deny";

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
 * EXPLICITLY for every legal action (never an implicit `auto`) — an implicit
 * default would be a silent security downgrade for a class like agent_config
 * whose delete must default to deny.
 */
export const WRITE_ACTION_MANIFEST: Readonly<
	Record<WriteResourceClass, ClassManifest>
> = {
	entity: {
		// `read` is auto/deny in the UI (approval is legal but treated as deny at
		// the read gate — you can't "queue" a read for human review usefully).
		actions: ["read", "create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		// Matches the historical entity default (create/update auto, delete approval).
		// read defaults auto so existing agents keep unrestricted org-entity access.
		defaultEffect: {
			read: "auto",
			create: "auto",
			update: "auto",
			delete: "approval",
		},
	},
	agent_config: {
		// `read` = list/get other agents (and their config surface). Auto/deny in
		// the UI; approval collapses to deny at the gate. create/update/delete
		// remain definition CRUD; invoke/call is not a legal action until a
		// first-class handoff path exists.
		actions: ["read", "create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		// An agent editing agent definitions is high-trust: create/update queue an
		// approval, delete is denied outright (a human must delete an agent).
		// read defaults auto so existing agents keep unrestricted peer visibility.
		// Target exceptions only tighten (max-restrictive fold): use default auto +
		// per-target deny to blacklist; a per-target auto cannot open a blanket deny.
		defaultEffect: {
			read: "auto",
			create: "approval",
			update: "approval",
			delete: "deny",
		},
	},
	connector_action: {
		// All operations use org policy; category rules can grant reads Auto.
		actions: ["execute"],
		effects: ["auto", "approval", "deny"],
		defaultEffect: {
			execute: "approval",
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
