/**
 * Shared mapping for durable approval-interaction rows (`interaction_type =
 * 'approval'` events) to the `tool-approval` interaction cards the web panel
 * renders. One function, two readers: the Automation run thread
 * (`automation-run-thread.ts`) and the agent history reload path
 * (`routes/public/agent-history.ts`) previously carried line-identical copies
 * of the resourceKind fallback and the `manage_automations` proposal flatten.
 */

export interface ApprovalInteractionSourceRow {
	event_id: number | string;
	run_id: number | string;
	action: string | null;
	proposal: Record<string, unknown> | null;
	current: Record<string, unknown> | null;
	fields: Record<string, unknown> | null;
	attribution: string | null;
	resource_kind: string | null;
	reason: string | null;
	tool: string | null;
}

export interface ApprovalInteraction {
	type: "tool-approval";
	eventId: number;
	runId: number;
	action: string | null;
	proposal: Record<string, unknown> | null;
	current: Record<string, unknown> | null;
	fields: Record<string, unknown> | null;
	attribution: string | null;
	resourceKind: string | null;
	reason: string | null;
}

/**
 * Discriminator for the approval card. Stored `resourceKind` wins; otherwise
 * fall back to the requesting tool. Unknown tools stay null rather than
 * guessing — the card renders generically.
 */
export function resolveApprovalResourceKind(row: {
	resource_kind: string | null;
	tool: string | null;
}): string | null {
	return (
		row.resource_kind ??
		(row.tool === "manage_automations"
			? "automation"
			: row.tool === "manage_agents"
				? "agent"
				: row.tool === "entity_field_change" || row.tool === "entity_change"
					? "entity"
					: null)
	);
}

/**
 * `manage_automations` stores its proposal as `{ args }`; the SPA expects the
 * flat fields. Every other tool's proposal passes through untouched.
 */
export function flattenApprovalProposal(
	resourceKind: string | null,
	proposal: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (
		resourceKind === "automation" &&
		proposal &&
		typeof proposal === "object" &&
		(proposal as { args?: unknown }).args &&
		typeof (proposal as { args: unknown }).args === "object"
	) {
		return (proposal as { args: Record<string, unknown> }).args;
	}
	return proposal;
}

export function mapApprovalInteractionRow(
	row: ApprovalInteractionSourceRow,
): ApprovalInteraction {
	const resourceKind = resolveApprovalResourceKind(row);
	return {
		type: "tool-approval",
		eventId: Number(row.event_id),
		runId: Number(row.run_id),
		action: row.action,
		proposal: flattenApprovalProposal(resourceKind, row.proposal ?? null),
		current: row.current ?? null,
		fields: row.fields ?? null,
		attribution: row.attribution ?? null,
		resourceKind,
		reason: row.reason ?? null,
	};
}
