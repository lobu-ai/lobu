import { stableStringify } from "@lobu/core/contracts/tools/view-content-hash";
import { scanForPii, scanForSecret } from "../utils/sensitive-content-scan";

/**
 * Conditions on a connector policy rule (`when`): every one must hold for the
 * rule to apply. Both kinds are pure and cheap, so they re-run wherever the
 * evaluator runs, against the operation's input.
 *
 * - `{ field, op, value? }` compares the value at a JSON pointer.
 * - `{ scan, field }` runs the shared secret or PII detector on it.
 */

const POLICY_CONDITION_OPS = [
	"eq",
	"neq",
	"in",
	"not_in",
	"contains",
	"ends_with",
	"not_ends_with",
	"exists",
] as const;
type PolicyConditionOp = (typeof POLICY_CONDITION_OPS)[number];

const POLICY_CONDITION_SCANS = ["secrets", "pii"] as const;
type PolicyConditionScan = (typeof POLICY_CONDITION_SCANS)[number];

const MAX_POLICY_CONDITIONS = 8;
const MAX_POINTER_LENGTH = 512;
const MAX_VALUE_BYTES = 4096;

type PolicyCondition =
	| { field: string; op: PolicyConditionOp; value?: unknown }
	| { scan: PolicyConditionScan; field: string };

/** A rule's conditions as stored: a 1-8 element array, or null for none. */
export type StoredPolicyConditions = readonly unknown[] | null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901 tokens of a pointer, or null when it is not one. "" is the whole input. */
function pointerTokens(pointer: string): string[] | null {
	if (pointer === "") return [];
	if (!pointer.startsWith("/") || pointer.length > MAX_POINTER_LENGTH) return null;
	const tokens: string[] = [];
	for (const raw of pointer.slice(1).split("/")) {
		let token = "";
		for (let i = 0; i < raw.length; i++) {
			const char = raw[i];
			if (char !== "~") {
				token += char;
				continue;
			}
			const next = raw[i + 1];
			if (next === "0") token += "~";
			else if (next === "1") token += "/";
			else return null;
			i++;
		}
		tokens.push(token);
	}
	return tokens;
}

function isArrayIndex(token: string): boolean {
	if (token === "" || (token.length > 1 && token.startsWith("0"))) return false;
	for (const char of token) if (char < "0" || char > "9") return false;
	return true;
}

/** The value a pointer names in `input`, or undefined when it is missing. */
function resolvePointer(input: unknown, tokens: readonly string[]): unknown {
	let current: unknown = input;
	for (const token of tokens) {
		if (Array.isArray(current)) {
			if (!isArrayIndex(token)) return undefined;
			current = current[Number(token)];
		} else if (isRecord(current)) {
			if (!Object.hasOwn(current, token)) return undefined;
			current = current[token];
		} else {
			return undefined;
		}
	}
	return current;
}

const sameJson = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

function needsValue(op: PolicyConditionOp): "array" | "string" | "json" | null {
	if (op === "exists") return null;
	if (op === "in" || op === "not_in") return "array";
	if (op === "ends_with" || op === "not_ends_with") return "string";
	return "json";
}

/**
 * One condition from a request, validated. Throws an error whose message names
 * the offending field (`when[1].op`), so a PUT can answer 400 with it.
 */
function parseCondition(raw: unknown, path: string): PolicyCondition {
	if (!isRecord(raw)) throw new Error(`${path} must be an object.`);
	if (typeof raw.field !== "string" || pointerTokens(raw.field) === null) {
		throw new Error(
			`${path}.field must be a JSON pointer such as "/to" (at most ${MAX_POINTER_LENGTH} characters).`,
		);
	}
	const field = raw.field;
	if ("scan" in raw) {
		const extra = Object.keys(raw).find((key) => key !== "scan" && key !== "field");
		if (extra) throw new Error(`${path}.${extra} is not accepted on a scan condition (scan, field).`);
		if (!POLICY_CONDITION_SCANS.includes(raw.scan as PolicyConditionScan)) {
			throw new Error(`${path}.scan must be one of ${POLICY_CONDITION_SCANS.join(", ")}.`);
		}
		return { scan: raw.scan as PolicyConditionScan, field };
	}
	const extra = Object.keys(raw).find((key) => key !== "field" && key !== "op" && key !== "value");
	if (extra) throw new Error(`${path}.${extra} is not accepted on a field condition (field, op, value).`);
	if (!POLICY_CONDITION_OPS.includes(raw.op as PolicyConditionOp)) {
		throw new Error(`${path}.op must be one of ${POLICY_CONDITION_OPS.join(", ")}.`);
	}
	const op = raw.op as PolicyConditionOp;
	const shape = needsValue(op);
	if (shape === null) {
		if ("value" in raw) throw new Error(`${path}.value is not accepted with op exists.`);
		return { field, op };
	}
	if (!("value" in raw) || raw.value === undefined) {
		throw new Error(`${path}.value is required with op ${op}.`);
	}
	const value = raw.value;
	if (shape === "array" && (!Array.isArray(value) || value.length === 0)) {
		throw new Error(`${path}.value must be a non-empty array with op ${op}.`);
	}
	if (shape === "string" && (typeof value !== "string" || value === "")) {
		throw new Error(`${path}.value must be a non-empty string with op ${op}.`);
	}
	if (Buffer.byteLength(stableStringify(value)) > MAX_VALUE_BYTES) {
		throw new Error(`${path}.value must be at most ${MAX_VALUE_BYTES} bytes of JSON.`);
	}
	return { field, op, value };
}

/** A canonical copy, so equal conditions compare and store identically. */
function canonicalCondition(condition: PolicyCondition): PolicyCondition {
	if ("scan" in condition) return { scan: condition.scan, field: condition.field };
	return condition.value === undefined
		? { field: condition.field, op: condition.op }
		: { field: condition.field, op: condition.op, value: JSON.parse(stableStringify(condition.value)) };
}

/**
 * A rule's `when` from a request: 1-8 conditions, all of which must hold.
 * Throws an error naming the offending field.
 */
export function parsePolicyConditions(raw: unknown, path = "when"): PolicyCondition[] {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_POLICY_CONDITIONS) {
		throw new Error(`${path} must list 1-${MAX_POLICY_CONDITIONS} conditions.`);
	}
	return raw.map((item, index) => canonicalCondition(parseCondition(item, `${path}[${index}]`)));
}

/** A stored or requested condition list, as one comparable key ("" for none). */
export function policyConditionsKey(conditions: StoredPolicyConditions): string {
	return conditions === null ? "" : stableStringify(conditions);
}

type PositiveOp = "eq" | "in" | "contains" | "ends_with";

/** Each negative op is exactly the negation of its positive op on a present field. */
const NEGATION_OF: Partial<Record<PolicyConditionOp, PositiveOp>> = {
	neq: "eq",
	not_in: "in",
	not_ends_with: "ends_with",
};

function positiveHolds(op: PositiveOp, expected: unknown, value: unknown): boolean {
	switch (op) {
		case "eq":
			return sameJson(value, expected);
		case "in":
			return Array.isArray(expected) && expected.some((item) => sameJson(value, item));
		case "contains":
			if (typeof value === "string") return typeof expected === "string" && value.includes(expected);
			return Array.isArray(value) && value.some((item) => sameJson(item, expected));
		case "ends_with": {
			if (typeof expected !== "string") return false;
			// String ops compare the raw value: a comma-joined string is never split.
			const one = (item: unknown) => typeof item === "string" && item.endsWith(expected);
			// On an array, every element must end with it; an empty list does not.
			if (Array.isArray(value)) return value.length > 0 && value.every(one);
			return one(value);
		}
	}
}

function fieldHolds(condition: Extract<PolicyCondition, { op: string }>, value: unknown): boolean {
	if (condition.op === "exists") return value !== undefined;
	// A missing field makes every other comparison false, negative ops included.
	if (value === undefined) return false;
	const positive = NEGATION_OF[condition.op];
	// So `not_ends_with` holds when any element lacks the suffix, or the list is
	// empty or holds a non-string: the strict side for a restricting rule.
	if (positive) return !positiveHolds(positive, condition.value, value);
	return positiveHolds(condition.op as PositiveOp, condition.value, value);
}

function scanHolds(scan: PolicyConditionScan, value: unknown): boolean {
	if (value === undefined) return false;
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
	return scan === "secrets" ? scanForSecret(text) !== null : scanForPii(text) !== null;
}

/**
 * Whether every stored condition holds for `input`. "unknown" when the input
 * is not known (discovery) or a stored condition cannot be read; the caller
 * then decides strictly, so an unreadable condition never grants.
 */
export function policyConditionsHold(
	conditions: StoredPolicyConditions,
	input: Record<string, unknown> | null | undefined,
): boolean | "unknown" {
	if (conditions == null) return true;
	let parsed: PolicyCondition[];
	try {
		parsed = parsePolicyConditions(conditions);
	} catch {
		return "unknown";
	}
	if (input === undefined) return "unknown";
	const document = input ?? {};
	return parsed.every((condition) => {
		const tokens = pointerTokens(condition.field);
		const value = tokens === null ? undefined : resolvePointer(document, tokens);
		return "scan" in condition ? scanHolds(condition.scan, value) : fieldHolds(condition, value);
	});
}
