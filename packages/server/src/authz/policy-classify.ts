/**
 * Classify conditions on connector policy rules (`when: [{ classify, ... }]`).
 *
 * A classify condition is a model call, so it runs once, at admission, before
 * any run lock, and only when its result could change the decision. Each
 * result is stored on the run (`run_metadata.policy_classify`) and replayed at
 * claim, approval and dispatch; a result that is missing there is unknown.
 * Discovery never calls the model. Neither the judged text nor the model's
 * reasoning is stored: each result carries a hash of the text it judged, and
 * answers only for an input whose field still hashes the same.
 */
import { createHash } from "node:crypto";
import { createLogger } from "@lobu/core";
import type { DbClient } from "../db/client";
import { resolveCompletionTarget } from "../gateway/inference/gateway-completion";
import { classifierValues, predictClassifier } from "../gateway/inference/predict-classifier";
import { getOrgDefaultModel } from "../lobu/stores/provider-secrets";
import type { EntityApprovalPolicy } from "./entity-policy";
import {
	type ClassifyOutcome,
	type PolicyClassifyCondition,
	type PolicyCondition,
	policyConditionText,
} from "./policy-conditions";

const logger = createLogger("policy-classify");

export const POLICY_CLASSIFY_METADATA_KEY = "policy_classify";

/** All classify calls for one action share this budget. */
const ACTION_BUDGET_MS = 3_000;

/** One stored classify result: rule id, condition index, outcome, and what produced it. */
export interface PolicyClassifyResult {
	rule: number;
	condition: number;
	/** sha256 of the judged field's text; null when the input had none. */
	text: string | null;
	result: ClassifyOutcome;
	model: string | null;
	classifier: string | null;
}

/**
 * How a policy decision may learn classify results. `live`: no lock is held,
 * so the model may be asked; each answer is added to `results`. Otherwise only
 * `results` answer, and anything else is unknown.
 */
export interface PolicyClassifyLookup {
	live: boolean;
	results: PolicyClassifyResult[];
}

export interface PolicyClassifyRequest {
	rule: EntityApprovalPolicy;
	index: number;
	condition: PolicyClassifyCondition;
}

const OUTCOMES: readonly ClassifyOutcome[] = ["holds", "not", "unknown"];

function textHash(input: Record<string, unknown> | null | undefined, field: string): string | null {
	const text = input ? policyConditionText(input, field) : undefined;
	return text === undefined ? null : createHash("sha256").update(text).digest("hex");
}

/** The results stored on a run, ignoring anything malformed (which then reads as unknown). */
export function storedPolicyClassify(metadata: Record<string, unknown> | null | undefined): PolicyClassifyResult[] {
	const raw = metadata?.[POLICY_CLASSIFY_METADATA_KEY];
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is PolicyClassifyResult =>
			typeof entry === "object" &&
			entry !== null &&
			Number.isSafeInteger(entry.rule) &&
			Number.isSafeInteger(entry.condition) &&
			typeof entry.text === "string" &&
			OUTCOMES.includes(entry.result),
	);
}

/**
 * Answer a rule's classify condition for `input` from known results; unknown
 * when absent, or when the result judged other text (an approver's edit).
 */
export function classifiedFrom(
	results: readonly PolicyClassifyResult[],
	input: Record<string, unknown> | null | undefined,
): (rule: EntityApprovalPolicy, index: number, condition: PolicyClassifyCondition) => ClassifyOutcome {
	return (rule, index, condition) => {
		const text = textHash(input, condition.field);
		if (text === null) return "unknown";
		return results.find((entry) => entry.rule === rule.id && entry.condition === index && entry.text === text)?.result ??
			"unknown";
	};
}

/**
 * Run the requested classify conditions in parallel under one budget. A call
 * still pending when the budget runs out, or one that fails, is unknown; so is
 * an abstention (value null).
 */
export async function classifyPolicyConditions(
	organizationId: string,
	requests: readonly PolicyClassifyRequest[],
	input: Record<string, unknown>,
): Promise<PolicyClassifyResult[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<null>((resolve) => {
		timer = setTimeout(resolve, ACTION_BUDGET_MS, null);
	});
	try {
		return await Promise.all(
			requests.map(async ({ rule, index, condition }): Promise<PolicyClassifyResult> => {
				const text = policyConditionText(input, condition.field);
				const unknown = { rule: rule.id, condition: index, text: textHash(input, condition.field), result: "unknown" as const };
				if (text === undefined || condition.model === undefined) {
					return { ...unknown, model: condition.model ?? null, classifier: null };
				}
				const prediction = await Promise.race([
					predictClassifier({ organizationId, classifier: condition.classify, model: condition.model, text }),
					budget,
				]);
				if (prediction === null || !prediction.ok) {
					logger.info(
						{ organizationId, ruleId: rule.id, classifier: condition.classify, error: prediction?.error ?? "budget" },
						"Policy classify condition is unknown",
					);
					return { ...unknown, model: condition.model, classifier: prediction?.classifierHash ?? null };
				}
				const result: ClassifyOutcome =
					prediction.value === null ? "unknown" : condition.is.includes(prediction.value) ? "holds" : "not";
				return { ...unknown, result, model: prediction.model, classifier: prediction.classifierHash };
			}),
		);
	} finally {
		clearTimeout(timer);
	}
}

/** The first connector rule with a classify condition on this classifier slug, or null. */
export async function policyRuleUsingClassifier(
	sql: DbClient,
	organizationId: string,
	classifier: string,
): Promise<number | null> {
	const rows = await sql<{ id: number }>`
    SELECT id FROM write_approval_policies
    WHERE organization_id = ${organizationId}
      AND condition @> jsonb_build_array(jsonb_build_object('classify', ${classifier}::text))
    ORDER BY id
    LIMIT 1
  `;
	return rows[0] ? Number(rows[0].id) : null;
}

/** A rule's conditions with the workspace default model filled into each classify condition that has none. */
export async function withClassifyModel(
	organizationId: string,
	conditions: readonly PolicyCondition[],
): Promise<PolicyCondition[]> {
	if (!conditions.some((condition) => "classify" in condition && condition.model === undefined)) return [...conditions];
	const model = await getOrgDefaultModel(organizationId);
	return conditions.map((condition) =>
		"classify" in condition && condition.model === undefined && model ? { ...condition, model } : condition,
	);
}

/** Why a rule's classify condition cannot run in this workspace, naming the field; null when it can. */
export async function classifyConditionProblem(
	organizationId: string,
	condition: PolicyClassifyCondition,
	path: string,
): Promise<string | null> {
	const values = await classifierValues(organizationId, condition.classify);
	if (values === null) return `${path}.classify: no classifier "${condition.classify}" in this workspace.`;
	const unknown = condition.is.find((value) => !values.includes(value));
	if (unknown !== undefined) return `${path}.is: "${unknown}" is not a value of classifier "${condition.classify}".`;
	const target = condition.model ? await resolveCompletionTarget(organizationId, condition.model) : null;
	if (!target) return `${path}: ChatGPT sign-in can't run policy checks; add a provider with an API key.`;
	return null;
}
