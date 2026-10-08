import { createHash } from "node:crypto";

/**
 * Version of the normalized policy and group-membership inputs in a decision
 * fingerprint. Bump whenever normalization or the hashed input shape changes.
 */
export const RESOLUTION_FINGERPRINT_VERSION = 4;

type ResolutionDecision = "auto_link" | "review";

interface ResolutionEvidence {
	kind: string;
	identifier: string;
}

export interface ResolutionIdentity {
	sourceConnector?: string | null;
	connectionId?: number | null;
	namespace: string;
	identifier: string;
	scopeKey?: string | null;
}

interface ResolutionEntity {
	id: number;
	metadata: Record<string, unknown>;
	/** Live identity claims that may not also exist in entity metadata. */
	identities?: ResolutionIdentity[];
}

interface IdentityGroupAssessment {
	decision: ResolutionDecision;
	evidence: ResolutionEvidence[];
	policyHash: string;
	fingerprint: string;
	reason: string;
}

interface ResolutionRule {
	fields: string[];
	normalizer: "email" | "phone" | "exact";
	onMatch: ResolutionDecision;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? String(value);
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function readPath(metadata: Record<string, unknown>, path: string): unknown {
	let current: unknown = metadata;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function normalizeScalar(
	value: unknown,
	normalizer: ResolutionRule["normalizer"],
): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const text = String(value).trim();
	if (!text) return null;
	if (normalizer === "phone") {
		if (!/^[+()0-9 .-]+$/.test(text)) return null;
		const digits = text.replace(/\D/g, "");
		return digits.length >= 7 && digits.length <= 15 ? digits : null;
	}
	if (normalizer === "email") {
		const email = text.toLocaleLowerCase("en-US");
		if (email.length > 512) return null;
		return /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
			email,
		)
			? email
			: null;
	}
	return text;
}

function normalizeValues(
	value: unknown,
	normalizer: ResolutionRule["normalizer"],
): string[] {
	const values = Array.isArray(value) ? value : [value];
	return [
		...new Set(
			values
				.map((item) => normalizeScalar(item, normalizer))
				.filter((item): item is string => item !== null),
		),
	].sort();
}

export function readEntityResolutionRules(schema: unknown): ResolutionRule[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
	const config = (schema as Record<string, unknown>)["x-lobu-resolution"];
	if (!config || typeof config !== "object" || Array.isArray(config)) return [];
	const rules = (config as Record<string, unknown>).rules;
	if (!Array.isArray(rules)) return [];
	return rules.flatMap((candidate) => {
		if (
			!candidate ||
			typeof candidate !== "object" ||
			Array.isArray(candidate)
		) {
			return [];
		}
		const record = candidate as Record<string, unknown>;
		const fields = Array.isArray(record.fields)
			? [
					...new Set(
						record.fields.flatMap((field) =>
							typeof field === "string" && field.trim().length > 0
								? [field.trim()]
								: [],
						),
					),
				]
			: [];
		const normalizer = record.normalizer;
		const onMatch = record.onMatch;
		if (
			fields.length === 0 ||
			(normalizer !== "email" &&
				normalizer !== "phone" &&
				normalizer !== "exact") ||
			(onMatch !== "auto_link" && onMatch !== "review")
		) {
			return [];
		}
		return [{ fields, normalizer, onMatch }];
	});
}

type NormalizedResolutionPart = readonly [value: string, scopeKey: string | null];

/** Render a canonical structured rule key for human-facing evidence. */
function renderRuleKey(key: string): string {
	const parts = JSON.parse(key) as NormalizedResolutionPart[];
	return parts
		.map(([value, scopeKey]) =>
			scopeKey === null ? value : `${value} [tenant: ${scopeKey}]`,
		)
		.join(" · ");
}

export function normalizedResolutionRuleKeys(
	entity: ResolutionEntity,
	rule: ResolutionRule,
): string[] {
	let combinations: NormalizedResolutionPart[][] = [[]];
	for (const field of rule.fields) {
		// Identity-backed connector data follows the same field policy and
		// normalization as metadata when its namespace names that field.
		const raw = readPath(entity.metadata, field);
		const fromMetadata = Array.isArray(raw) ? raw : [raw];
		const identityValues: NormalizedResolutionPart[] = (entity.identities ?? [])
			.filter((identity) => identity.namespace === field)
			.flatMap((identity) => {
				const value = normalizeScalar(identity.identifier, rule.normalizer);
				return value === null
					? []
					: [[value, identity.scopeKey ?? null] as const];
			});
		// Attribution mirrors identity values into metadata. When a live identity
		// row supplies the same normalized value, prefer its scoped form so that
		// the metadata mirror cannot erase tenant separation during resolution.
		const identityRawValues = new Set(
			identityValues.map(([value]) => value),
		);
		const metadataValues: NormalizedResolutionPart[] = normalizeValues(
			fromMetadata,
			rule.normalizer,
		)
			.filter((value) => !identityRawValues.has(value))
			.map((value) => [value, null] as const);
		const valuesByEncoding = new Map(
			[...metadataValues, ...identityValues].map((value) => [
				canonicalJson(value),
				value,
			]),
		);
		const values = [...valuesByEncoding.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, value]) => value);
		if (values.length === 0) return [];
		combinations = combinations.flatMap((prefix) =>
			values.map((value) => [...prefix, value]),
		);
		if (combinations.length > 256) return [];
	}
	return combinations.map((parts) => canonicalJson(parts)).sort();
}

/**
 * Assess two existing identity groups using only their declared schema rules.
 * Each record supplies its own complete rule keys; composite fields never cross
 * record boundaries. One direct automatic match suffices unless any populated
 * unique rule conflicts anywhere in the combined group.
 */
export function assessIdentityGroups(input: {
	metadataSchema: unknown;
	left: ResolutionEntity[];
	right: ResolutionEntity[];
}): IdentityGroupAssessment {
	const rules = readEntityResolutionRules(input.metadataSchema);
	const normalize = (records: ResolutionEntity[]) => records
		.map(record => ({ id: record.id,
			values: rules.map(rule => normalizedResolutionRuleKeys(record, rule)) }))
		.sort((left, right) => left.id - right.id);
	const left = normalize(input.left);
	const right = normalize(input.right);
	const normalized = [...left, ...right].sort((left, right) => left.id - right.id);
	const evidence = new Map<string, ResolutionEvidence>();
	let automaticMatch = false;
	let conflict = false;

	rules.forEach((rule, index) => {
		const leftKeys = new Set(left.flatMap(record => record.values[index]));
		const rightKeys = new Set(right.flatMap(record => record.values[index]));
		const matches = [...leftKeys].filter(key => rightKeys.has(key)).sort();
		for (const key of matches) {
			const item = { kind: rule.fields.join(" + "), identifier: renderRuleKey(key) };
			evidence.set(canonicalJson([item.kind, item.identifier]), item);
		}
		if (rule.onMatch !== "auto_link") return;
		automaticMatch ||= matches.length > 0;
		// A missing value is not a conflict. Two populated, disjoint key sets
		// are, even when both records already belong to the same group.
		const populated = normalized.map(record => record.values[index]).filter(keys => keys.length > 0);
		conflict ||= populated.some((keys, i) => populated.slice(i + 1)
			.some(other => !keys.some(key => other.includes(key))));
	});

	const matchedEvidence = [...evidence.values()].sort((a, b) =>
		a.kind.localeCompare(b.kind) || a.identifier.localeCompare(b.identifier));
	const policyHash = digest(rules);
	const automatic = automaticMatch && !conflict;
	const fieldLabels = [...new Set(rules.flatMap(rule => rule.fields))].join(" or ");
	const matchedLabels = [...new Set(matchedEvidence.map(item => item.kind))].join(" and ");
	return {
		decision: automatic ? "auto_link" : "review",
		evidence: matchedEvidence,
		policyHash,
		fingerprint: digest({ policyHash, normalized,
			left: left.map(record => record.id), right: right.map(record => record.id) }),
		reason: conflict
			? "Members carry conflicting values declared unique; human review is required."
			: automatic
				? "Direct member evidence satisfies the declared automatic matching policy."
				: matchedEvidence.length > 0
					? `Matching ${matchedLabels} needs human review under the entity type's policy.`
					: fieldLabels
						? `No matching ${fieldLabels} could be verified; human review is required.`
						: "This entity type has no identity matching rules; human review is required.",
	};
}
