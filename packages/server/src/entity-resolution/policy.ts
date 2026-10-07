import { createHash } from "node:crypto";

/**
 * Version of the inputs `assessEntityResolution` hashes into `fingerprint`.
 *
 * Bump this whenever the hashed input set changes shape — adding a field,
 * changing normalization, reading a new source. A fingerprint mismatch only
 * proves drift within the same version: across versions the digests can differ
 * even when nothing about the entities changed.
 *
 * v1 → v2: #2152 added `entity_identities` rows alongside `entities.metadata`
 * as rule-field inputs. Proposals minted before it stored metadata-only
 * digests, which current recomputation cannot compare. Because the version
 * stamp was added later, unstamped mismatches are conservatively refreshed:
 * their exact historical format cannot be inferred from the digest alone.
 * v2 → v3: #2849 added identity tenant scope keys to rule matching and the
 * fingerprint. Equal normalized identifiers from different tenants are no
 * longer merge evidence.
 * v3 → v4: rule keys use canonical structured tuples instead of control-byte
 * delimiters, so valid identifiers and tenant keys cannot collide.
 */
export const RESOLUTION_FINGERPRINT_VERSION = 4;

type ResolutionDecision = "auto_merge" | "review";

export interface ResolutionEvidence {
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

/**
 * One entity's normalized rule keys, grouped under the same labels used by
 * `evidence.kind`. This is a readable view of the rule evaluation included in
 * the resolution fingerprint. Rules that normalize no values are omitted.
 */
export interface ResolutionKeySet {
	id: number;
	keys: Record<string, string[]>;
}

export interface EntityResolutionAssessment {
	decision: ResolutionDecision;
	evidence: ResolutionEvidence[];
	policyHash: string;
	fingerprint: string;
	reason: string;
	resolutionKeys: ResolutionKeySet[];
}

interface ResolutionRule {
	fields: string[];
	normalizer: "email" | "phone" | "exact";
	onMatch: ResolutionDecision;
}

/**
 * Plural rule fields that name the same thing as their singular form, so the
 * human-facing reason says "email or phone" rather than listing all four.
 * Deliberately an explicit map: any field not listed here is printed verbatim.
 */
const RULE_FIELD_ALIASES: Record<string, string> = {
	emails: "email",
	phones: "phone",
};

const DEFAULT_PERSON_RESOLUTION_RULES: ResolutionRule[] = [
	{ fields: ["email"], normalizer: "email", onMatch: "review" },
	{ fields: ["emails"], normalizer: "email", onMatch: "review" },
	{ fields: ["phone"], normalizer: "phone", onMatch: "review" },
	{ fields: ["phones"], normalizer: "phone", onMatch: "review" },
];

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

export function readEntityResolutionRules(
	schema: unknown,
	options?: { entityTypeSlug?: string | null },
): ResolutionRule[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return options?.entityTypeSlug === "person"
			? DEFAULT_PERSON_RESOLUTION_RULES
			: [];
	}
	const config = (schema as Record<string, unknown>)["x-lobu-resolution"];
	if (config === undefined) {
		return options?.entityTypeSlug === "person"
			? DEFAULT_PERSON_RESOLUTION_RULES
			: [];
	}
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
			(onMatch !== "auto_merge" && onMatch !== "review")
		) {
			return [];
		}
		return [{ fields, normalizer, onMatch }];
	});
}

type NormalizedResolutionPart = readonly [value: string, scopeKey: string | null];

/** Render a canonical structured rule key for human-facing evidence. */
function renderRuleKey(key: string): string {
	let decoded: unknown;
	try {
		decoded = JSON.parse(key);
	} catch {
		return key;
	}
	if (!Array.isArray(decoded)) return key;
	const parts = decoded.flatMap((candidate): NormalizedResolutionPart[] => {
		if (
			!Array.isArray(candidate) ||
			candidate.length !== 2 ||
			typeof candidate[0] !== "string" ||
			(candidate[1] !== null && typeof candidate[1] !== "string")
		) {
			return [];
		}
		return [[candidate[0], candidate[1]]];
	});
	if (parts.length !== decoded.length) return key;
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
 * Decide whether a duplicate proposal is deterministic under its entity type's
 * schema. The caller-provided evidence is deliberately ignored: every value is
 * recomputed from the locked workspace entities and the versioned type policy.
 */
export function assessEntityResolution(input: {
	metadataSchema: unknown;
	entityTypeSlug?: string | null;
	winner: ResolutionEntity;
	losers: ResolutionEntity[];
}): EntityResolutionAssessment {
	const rules = readEntityResolutionRules(input.metadataSchema, {
		entityTypeSlug: input.entityTypeSlug,
	});
	const policyHash = digest(rules);
	const evidence: ResolutionEvidence[] = [];
	const normalizedIdentities = [input.winner, ...input.losers]
		.map((entity) => ({
			id: entity.id,
			values: rules.map((rule) => normalizedResolutionRuleKeys(entity, rule)),
		}))
		.sort((left, right) => left.id - right.id);
	let allLosersHaveAutoMatch = rules.length > 0;
	let conflictingAutoIdentity = false;

	for (const loser of input.losers) {
		let loserHasAutoMatch = false;
		for (const rule of rules) {
			const winnerKeys = normalizedResolutionRuleKeys(input.winner, rule);
			const loserKeys = normalizedResolutionRuleKeys(loser, rule);
			if (winnerKeys.length === 0 || loserKeys.length === 0) continue;
			const loserKeySet = new Set(loserKeys);
			const matches = winnerKeys.filter((key) => loserKeySet.has(key));
			if (rule.onMatch === "auto_merge" && matches.length === 0) {
				conflictingAutoIdentity = true;
			}
			if (matches.length === 0) continue;
			for (const match of matches) {
				evidence.push({
					kind: rule.fields.join(" + "),
					identifier: renderRuleKey(match),
				});
			}
			if (rule.onMatch === "auto_merge") loserHasAutoMatch = true;
		}
		allLosersHaveAutoMatch &&= loserHasAutoMatch;
	}

	const deduplicatedEvidence = [
		...new Map(
			evidence.map((item) => [`${item.kind}\u0000${item.identifier}`, item]),
		).values(),
	];
	const evidenceKinds = [
		...new Set(deduplicatedEvidence.map((item) => item.kind)),
	];
	// Name the fields this entity type actually resolves on ("email or phone"
	// for person) rather than assuming — another type may key on something else,
	// and a type with no rules at all resolves on nothing. Only the known
	// singular/plural aliases are coalesced: stripping a trailing "s" from
	// arbitrary configured paths would mangle custom names like `status`.
	const ruleFieldLabel = [
		...new Set(
			rules.flatMap((rule) =>
				rule.fields.map((field) => RULE_FIELD_ALIASES[field] ?? field),
			),
		),
	].join(" or ");
	const decision =
		allLosersHaveAutoMatch && !conflictingAutoIdentity
			? "auto_merge"
			: "review";
	const fingerprint = digest({
		policyHash,
		winnerId: input.winner.id,
		loserIds: input.losers.map((entity) => entity.id).sort((a, b) => a - b),
		normalizedIdentities,
	});
	// Derive the snapshot view from the same normalized values used above without
	// changing the fingerprint input.
	const resolutionKeys: ResolutionKeySet[] = normalizedIdentities.map(
		({ id, values }) => {
			const keysByLabel = new Map<string, string[]>();
			values.forEach((ruleKeys, index) => {
				if (ruleKeys.length === 0) return;
				const rule = rules[index]!;
				const label = rule.fields.join(" + ");
				const existingKeys = keysByLabel.get(label) ?? [];
				keysByLabel.set(
					label,
					[
						...new Set([...existingKeys, ...ruleKeys].map(renderRuleKey)),
					].sort(),
				);
			});
			return { id, keys: Object.fromEntries(keysByLabel) };
		},
	);

	return {
		decision,
		evidence: deduplicatedEvidence,
		policyHash,
		fingerprint,
		resolutionKeys,
		// Addressed to the human deciding the approval, so each branch says what
		// the workspace could verify and what it now needs from them — not what
		// the rules engine did internally.
		reason:
			decision === "auto_merge"
				? "The entity type declares this normalized identity unique."
				: conflictingAutoIdentity
					? "These records carry conflicting identities that are configured as unique, so merging them needs your judgement."
					: deduplicatedEvidence.length > 0
						? `Matching ${evidenceKinds.join(" and ")} points to the same thing, but that is not enough to merge automatically under this entity type's policy, so it needs your judgement.`
						: ruleFieldLabel
							? `No matching ${ruleFieldLabel} could be verified automatically, so this merge needs your judgement.`
							: "This entity type has no automatic matching rules, so every merge needs your judgement.",
	};
}
