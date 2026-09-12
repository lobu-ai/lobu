/**
 * ClientSDK `automations` namespace. Thin, action-complete wrapper over
 * `manageAutomations` + `getAutomation`.
 *
 * Keep this surface in sync with `ManageAutomationsSchema`: every
 * `manage_automations.action` should either have a named SDK method below or be
 * reachable via `automations.manage({ action, ... })`.
 */

import type { FlatActionInput } from "@lobu/core/contracts/tools/action-input";
import type {
	AutomationClaimNextWindowResult,
	AutomationTriggerResult,
	ListAutomationsArgs,
	ManageAutomationsResult,
} from "@lobu/core/contracts/tools/manage-automations";
import type { Env } from "../../index";
import {
	type ManageAutomationsArgs,
	manageAutomations,
} from "../../tools/admin/manage_automations";
import { getAutomation } from "../../tools/get_automation";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

type AutomationId = string;
type AutomationActionInput = Omit<ManageAutomationsArgs, "action" | "automation_id"> & {
	automation_id?: AutomationId;
};
/** The contract's fields one action reads; `R` names the ones it requires. */
type Input<
	K extends keyof ManageAutomationsArgs,
	R extends K = never,
> = FlatActionInput<ManageAutomationsArgs, K, R>;

export type AutomationListFilter = ListAutomationsArgs;

type AutomationPendingApprovalResult = Extract<
	ManageAutomationsResult,
	{ status: "pending_approval" }
>;

/** Canonical create receipt; successful creates always return automation_id. */
export type AutomationCreateResult =
	| Extract<ManageAutomationsResult, { action: "create" }>
	| (Omit<AutomationPendingApprovalResult, "action"> & { action: "create" });

/**
 * `slug` is the only hard requirement (`handleCreate`). The instruction
 * requirement is satisfied by `prompt`, `skills`, OR `reaction_script`, and an
 * event trigger with execution 'turn' may omit all three
 * (`assertAutomationInstructions`) — so none of them is required here.
 */
export type AutomationCreateInput = Input<
	| "entity_id"
	| "prompt"
	| "skills"
	| "sources"
	| "triggers"
	| "slug"
	| "name"
	| "description"
	| "outputs"
	| "classifiers"
	| "reactions_guidance"
	| "reaction_script"
	| "managed_agent_id"
	| "device_worker_id"
	| "agent_kind"
	| "delivery_target"
	| "min_cooldown_seconds"
	| "model_config"
	| "execution_config"
	| "tags",
	"slug"
>;

/**
 * `tags` is patchable here even though the schema annotates it `[create]` —
 * `handleUpdate` lists it in `updatedFields` and writes it. Omitting it is the
 * drift `FlatActionInput` exists to prevent: a field the schema accepts that no
 * typed caller can reach.
 */
export type AutomationUpdateInput = Input<
	| "automation_id"
	| "triggers"
	| "managed_agent_id"
	| "device_worker_id"
	| "agent_kind"
	| "delivery_target"
	| "min_cooldown_seconds"
	| "model_config"
	| "execution_config"
	| "tags",
	"automation_id"
>;

export type AutomationCompleteWindowInput = Input<
	| "automation_id"
	| "window_token"
	| "window_tokens"
	| "extracted_data"
	| "client_id"
	| "model"
	| "run_id"
	| "run_metadata"
	| "template_version_id",
	"automation_id" | "extracted_data" | "run_id"
>;

export type AutomationClaimNextWindowInput = Input<
	| "automation_id"
	| "lease_seconds"
	| "limit"
	| "run_id"
	| "before_occurred_at"
	| "before_id"
	| "source_name"
	| "source_cursor",
	"automation_id"
>;

export interface AutomationCreateVersionInput extends AutomationActionInput {
	automation_id: AutomationId;
}

export type AutomationVersionDetailsInput = Input<
	"automation_id" | "version",
	"automation_id"
>;

export type AutomationSubmitFeedbackInput = Input<
	"automation_id" | "run_id" | "corrections",
	"automation_id" | "run_id" | "corrections"
>;

export type AutomationGetFeedbackInput = Input<
	"automation_id" | "run_id" | "limit",
	"automation_id"
>;

export type AutomationCreateFromVersionInput = Input<
	"version_id" | "entity_ids" | "name_pattern",
	"version_id" | "entity_ids"
>;

export interface AutomationsNamespace {
	/** Raw escape hatch for any manage_automations action. Prefer named methods. */
	manage(input: ManageAutomationsArgs): Promise<unknown>;
	list(filter?: AutomationListFilter): Promise<unknown>;
	get(input: { automation_id: AutomationId }): Promise<unknown>;
	create(input: AutomationCreateInput): Promise<AutomationCreateResult>;
	update(input: AutomationUpdateInput): Promise<unknown>;
	createVersion(input: AutomationCreateVersionInput): Promise<unknown>;
	completeWindow(input: AutomationCompleteWindowInput): Promise<unknown>;
	claimNextWindow(input: AutomationClaimNextWindowInput): Promise<AutomationClaimNextWindowResult>;
	trigger(input: { automation_id: AutomationId }): Promise<AutomationTriggerResult>;
	/** Delete one or more Automations. */
	delete(input: { automation_ids: AutomationId[] }): Promise<unknown>;
	setReactionScript(input: {
		automation_id: AutomationId;
		/** TypeScript source. Empty string removes it. */
		reaction_script: string;
	}): Promise<unknown>;
	getVersions(automation_id: AutomationId): Promise<unknown>;
	getVersionDetails(
		input: AutomationId | AutomationVersionDetailsInput,
	): Promise<unknown>;
	getComponentReference(): Promise<unknown>;
	submitFeedback(input: AutomationSubmitFeedbackInput): Promise<unknown>;
	getFeedback(input: AutomationGetFeedbackInput): Promise<unknown>;
	createFromVersion(input: AutomationCreateFromVersionInput): Promise<unknown>;
}

function normalizeVersionDetailsInput(
	input: AutomationId | AutomationVersionDetailsInput,
): { automation_id: string; version?: number } {
	if (typeof input === "string") {
		return { automation_id: input };
	}
	return input;
}

export function buildAutomationsNamespace(
	ctx: ToolContext,
	env: Env,
): AutomationsNamespace {
	const { manage, method } = createActionCaller(manageAutomations, env, ctx, "automations");

	return {
		manage,
		list: method("list"),
		get(input) {
			return getAutomation(
				input as never,
				env,
				ctx,
			) as Promise<unknown>;
		},
		create: method("create"),
		update: method("update"),
		createVersion: method("create_version"),
		completeWindow: method("complete_window"),
		claimNextWindow: method("claim_next_window"),
		trigger: method("trigger"),
		delete: method("delete"),
		setReactionScript: method("set_reaction_script"),
		getVersions: method("get_versions", {
			mapArgs: (automation_id) => ({
				automation_id: idArg(
					"automations.getVersions",
					"automation_id",
					automation_id,
					"string",
				),
			}),
		}),
		getVersionDetails: method("get_version_details", {
			mapArgs: normalizeVersionDetailsInput,
		}),
		getComponentReference: method("get_component_reference"),
		submitFeedback: method("submit_feedback"),
		getFeedback: method("get_feedback"),
		createFromVersion: method("create_from_version"),
	};
}
