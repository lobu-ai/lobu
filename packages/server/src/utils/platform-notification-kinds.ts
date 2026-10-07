/**
 * Notification kinds the PLATFORM emits, as opposed to the event kinds an org
 * authors in `$member.event_kinds`.
 *
 * Named for what these are — renderable notifications — and NOT after the
 * unrelated `platform_event_kinds` catalog on `manage_entity_schema`, which
 * lists the `<subject>.<op>` audit events an Automation trigger can subscribe
 * to (`automations/platform-event-catalog.ts`). Two different vocabularies met
 * under one name once the catalog shipped; this is the notification one.
 *
 * Event-kind resolution is otherwise entirely org-authored, which is right for
 * content an org models itself. But a notification the platform raises — an
 * approval, say — has a shape the platform owns and every org shares, and it
 * cannot require each org to have declared a kind before it renders. Declaring
 * it here gives Memory and MCP event readers the same kind-resolution path
 * through `resolveEventKindDefinition`. Chat uses event summaries and
 * server-owned approval evidence without interpreting kind templates.
 *
 * These are a FALLBACK, consulted only after entity-type and `$member` kinds,
 * so an org that declares the same slug still wins and can restyle it.
 *
 * Prefer a `metadataSchema` to a hand-authored `jsonTemplate`: the schema alone
 * yields the default field table (`buildDefaultEntityTemplate`), which is what
 * these notifications want, and it stays declarative.
 */
import type { EventKindDefinition } from "./event-kind-validation";

export const CONNECTOR_OPERATION_APPROVAL_KIND = "connector_operation_approval";
export const ENTITY_CHANGE_APPROVAL_KIND = "entity_change_approval";
export const CONNECTION_AUTHORIZATION_KIND = "connection_authorization_needed";
export const BROWSER_SESSION_EXPIRED_KIND = "browser_session_expired";
export const INVITATION_RECEIVED_KIND = "invitation_received";

export const PLATFORM_NOTIFICATION_KINDS: Readonly<
	Record<string, EventKindDefinition>
> = {
	/**
	 * A connector operation queued behind approval, with structured evidence
	 * identifying the operation, connection, and input under review.
	 */
	[CONNECTOR_OPERATION_APPROVAL_KIND]: {
		description: "A connector operation waiting for a human decision.",
		/**
		 * Which operation, on which connection, is the card's IDENTITY, not two
		 * more rows of its record — so it goes in the `context` strip and the body
		 * is left to the one thing the decision actually turns on, the input. Read
		 * as a field table it was three rows of two words each, which is how a
		 * two-column layout wastes a whole card.
		 */
		jsonTemplate: {
			type: "card",
			children: [
				{
					type: "context",
					children: [
						{ type: "strong", children: [{ type: "text", content: "Operation" }] },
						{ type: "data", path: "operation" },
						{
							type: "if",
							condition: "connection",
							then: {
								type: "span",
								children: [
									{ type: "text", content: "· via " },
									{ type: "data", path: "connection" },
								],
							},
						},
					],
				},
				{
					type: "fields",
					children: [
						{
							type: "field",
							props: { label: "Input" },
							children: [{ type: "data", path: "input", fallback: "—" }],
						},
					],
				},
			],
		},
		metadataSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					title: "Operation",
					"x-table-column": 1,
				},
				connection: {
					type: "string",
					title: "Connection",
					"x-table-column": 2,
				},
				input: {
					type: "object",
					title: "Input",
					"x-table-column": 3,
				},
			},
		},
	},
	/**
	 * An entity create / update / delete / merge waiting for a decision.
	 *
	 * This kind authors a `jsonTemplate` rather than leaning on the schema
	 * default, because the interesting content is a LIST — the proposed fields,
	 * or the before/after of each changed one — and a list is what `each`
	 * exists for. The alternative was a second bespoke formatter, which is the
	 * thing this pipeline replaced.
	 */
	[ENTITY_CHANGE_APPROVAL_KIND]: {
		description: "An entity change waiting for a human decision.",
		metadataSchema: {
			type: "object",
			properties: {
				action: { type: "string", title: "Action" },
				entityTypeLabel: { type: "string", title: "Type" },
				entityName: { type: "string", title: "Entity" },
				// The entity's own page. A link TARGET, never a row of its own — the
				// name in the strip is what carries it.
				entityUrl: { type: "string", title: "Entity URL", "x-hidden": true },
				requestedBy: { type: "string", title: "Requested by" },
				why: { type: "string", title: "Why approval is needed" },
				diffs: { type: "array", title: "Changes", "x-hidden": true },
				proposal: { type: "array", title: "Proposal", "x-hidden": true },
			},
		},
		/**
		 * `text` nodes are literals — the DSL interpolates `{{path}}` in component
		 * PROPS only, matching owletto's renderer — so every value here is bound
		 * with a `data` node. Scalars go in a `fields` block and lists in a table.
		 */
		jsonTemplate: {
			type: "card",
			children: [
				/**
				 * WHAT is under review — its type, its name, who asked — introduces
				 * the card rather than filling it: those three never change the
				 * decision, they identify what the decision is about. Each value
				 * carries its own leading separator inside the same `if`, so an
				 * absent one takes its `·` with it.
				 *
				 * The trailing space in each separator is load-bearing. The web
				 * renderer uses a flex `gap`, which applies BETWEEN direct
				 * children and not inside the `span` grouping a separator with its
				 * value — so without it the page reads "· requested byCRM sync".
				 *
				 * The name links to the current record alongside the proposed change.
				 */
				{
					type: "context",
					children: [
						{
							type: "if",
							condition: "entityTypeLabel",
							then: {
								type: "strong",
								children: [{ type: "data", path: "entityTypeLabel" }],
							},
						},
						{
							type: "if",
							condition: "entityName",
							then: {
								type: "span",
								children: [
									{ type: "text", content: "· " },
									{
										type: "if",
										condition: "entityUrl",
										then: {
											type: "link",
											props: { href: "{{entityUrl}}" },
											children: [{ type: "data", path: "entityName" }],
										},
										else: { type: "data", path: "entityName" },
									},
								],
							},
						},
						{
							type: "if",
							condition: "requestedBy",
							then: {
								type: "span",
								children: [
									{ type: "text", content: "· requested by " },
									{ type: "data", path: "requestedBy" },
								],
							},
						},
					],
				},
				{
					type: "fields",
					children: [
						{
							type: "if",
							condition: "action",
							then: {
								type: "field",
								props: { label: "Action" },
								children: [{ type: "data", path: "action" }],
							},
						},
						{
							type: "if",
							condition: "why",
							then: {
								type: "field",
								props: { label: "Why approval is needed" },
								children: [{ type: "data", path: "why" }],
							},
						},
					],
				},
				// Two shapes, so two tables. An update is three columns whose middle
				// and right only mean anything once they are NAMED — "Eng" next to
				// "Staff Eng" is undecidable without `Current`/`Proposed` above it.
				// A create/delete/merge is a label/value pair, which needs no header.
				{
					type: "if",
					condition: "diffs",
					then: {
						type: "table",
						props: { caption: "Proposed change" },
						children: [
							{
								type: "thead",
								children: [
									{
										type: "tr",
										children: [
											{ type: "th", children: [{ type: "text", content: "Field" }] },
											{ type: "th", children: [{ type: "text", content: "Current" }] },
											{ type: "th", children: [{ type: "text", content: "Proposed" }] },
										],
									},
								],
							},
							{
								type: "tbody",
								children: [
									{
										type: "each",
										items: "diffs",
										as: "d",
										render: {
											type: "tr",
											children: [
												{ type: "th", children: [{ type: "data", path: "d.label" }] },
												{ type: "td", children: [{ type: "data", path: "d.current", fallback: "—" }] },
												{ type: "td", children: [{ type: "data", path: "d.proposed", fallback: "—" }] },
											],
										},
									},
								],
							},
						],
					},
				},
				{
					type: "if",
					condition: "proposal",
					then: {
						type: "table",
						props: { caption: "Proposed change" },
						children: [
							{
								type: "tbody",
								children: [
									{
										type: "each",
										items: "proposal",
										as: "p",
										render: {
											type: "tr",
											children: [
												{ type: "th", children: [{ type: "data", path: "p.label" }] },
												{ type: "td", children: [{ type: "data", path: "p.value", fallback: "—" }] },
											],
										},
									},
								],
							},
						],
					},
				},
			],
		},
	},
	/**
	 * A connection that cannot sync until someone authorizes it.
	 *
	 * Schema-only, no authored template: these are a handful of scalars, which
	 * is exactly the case the default table was synthesized for. Authoring a
	 * template here would be a second layout to keep in step for no gain.
	 */
	[CONNECTION_AUTHORIZATION_KIND]: {
		description: "A connection waiting for OAuth authorization.",
		metadataSchema: {
			type: "object",
			properties: {
				connector: { type: "string", title: "Connector", "x-table-column": 1 },
				status: { type: "string", title: "Status", "x-table-column": 2 },
			},
		},
	},

	[BROWSER_SESSION_EXPIRED_KIND]: {
		description: "A connector whose stored browser session has expired.",
		metadataSchema: {
			type: "object",
			properties: {
				connector: { type: "string", title: "Connector", "x-table-column": 1 },
				status: { type: "string", title: "Status", "x-table-column": 2 },
				fix: { type: "string", title: "How to fix it", "x-table-column": 3 },
			},
		},
	},

	[INVITATION_RECEIVED_KIND]: {
		description: "An invitation to join an organization.",
		metadataSchema: {
			type: "object",
			properties: {
				organization: { type: "string", title: "Organization", "x-table-column": 1 },
				invitedBy: { type: "string", title: "Invited by", "x-table-column": 2 },
			},
		},
	},
};

export function resolvePlatformNotificationKind(
	semanticType: string,
): EventKindDefinition | null {
	return PLATFORM_NOTIFICATION_KINDS[semanticType] ?? null;
}
