import { describe, expect, it } from "vitest";
import {
	assessIdentityGroups,
	normalizedResolutionRuleKeys,
	readEntityResolutionRules,
} from "./policy";

type RecordInput = Parameters<typeof assessIdentityGroups>[0]["left"][number];
const schema = {
	"x-lobu-resolution": {
		rules: [
			{ fields: ["email"], normalizer: "email", onMatch: "auto_link" },
			{ fields: ["phone"], normalizer: "phone", onMatch: "review" },
		],
	},
};

function pair(left: RecordInput, right: RecordInput, metadataSchema: unknown = schema) {
	return assessIdentityGroups({ metadataSchema, left: [left], right: [right] });
}

function singleRule(fields: string[], normalizer = "exact", onMatch = "review") {
	return { "x-lobu-resolution": { rules: [{ fields, normalizer, onMatch }] } };
}

describe("explicit identity resolution policy", () => {
	it("does not infer policy from an entity type or familiar field names", () => {
		const legacyCaller = readEntityResolutionRules as (...args: unknown[]) => unknown;
		for (const metadataSchema of [undefined, null, {}, { type: "object" }]) {
			expect(legacyCaller(metadataSchema, { entityTypeSlug: "person" })).toEqual([]);
			const result = assessIdentityGroups({ metadataSchema,
				left: [{ id: 1, metadata: { email: "shared@example.test", phone: "1234567" } }],
				right: [{ id: 2, metadata: { email: "shared@example.test", phone: "1234567" } }],
			});
			expect(result.decision).toBe("review");
			expect(result.evidence).toEqual([]);
		}
	});

	it("accepts auto_link and rejects the retired automatic merge setting", () => {
		expect(readEntityResolutionRules(singleRule(["account"], "exact", "auto_link")))
			.toEqual([{ fields: ["account"], normalizer: "exact", onMatch: "auto_link" }]);
		expect(() => readEntityResolutionRules(singleRule(["account"], "exact", "auto_merge"))).toThrow(/invalid_schema/);
	});

	it("rejects an entire malformed policy rather than weakening a composite match", () => {
		const malformed = { "x-lobu-resolution": { rules: [
			{ fields: ["email", 42], normalizer: "email", onMatch: "auto_link" },
		] } };
		expect(() => pair({ id: 1, metadata: { email: "shared@example.test" } },
			{ id: 2, metadata: { email: "shared@example.test" } }, malformed)).toThrow(/invalid_schema/);
		const mixed = { "x-lobu-resolution": { rules: [schema["x-lobu-resolution"].rules[0], null] } };
		expect(() => readEntityResolutionRules(mixed)).toThrow(/invalid_schema/);
	});

	it("trims and deduplicates valid field paths without dropping malformed fields", () => {
		expect(readEntityResolutionRules(singleRule([" account ", "account"])))
			.toEqual([{ fields: ["account"], normalizer: "exact", onMatch: "review" }]);
		for (const fields of [["account", ""], ["account", null], ["account", 42]]) {
			expect(() => readEntityResolutionRules(singleRule(fields as string[]))).toThrow(/invalid_schema/);
		}
	});

	it("keeps configured singular and plural field paths distinct", () => {
		const result = pair(
			{ id: 1, metadata: { emails: ["shared@example.test"] } },
			{ id: 2, metadata: { email: "shared@example.test" }, identities: [{ namespace: "email", identifier: "shared@example.test" }] },
			singleRule(["emails"], "email"),
		);
		expect(result.evidence).toEqual([]);
		expect(result.reason).toContain("emails");
	});

	it("names custom fields verbatim when explaining missing evidence", () => {
		const result = pair({ id: 1, metadata: {} }, { id: 2, metadata: {} }, singleRule(["status"]));
		expect(result.reason).toBe("No matching status could be verified; human review is required.");
	});
});

describe("identity group assessment", () => {
	it("uses non-root evidence without combining composite fields from different records", () => {
		const metadataSchema = singleRule(["account", "region"], "exact", "auto_link");
		const right = [{ id: 3, metadata: { account: "synthetic-account", region: "west" } }];
		const incomplete = assessIdentityGroups({ metadataSchema,
			left: [{ id: 1, metadata: { account: "synthetic-account" } }, { id: 2, metadata: { region: "west" } }], right });
		expect(incomplete.decision).toBe("review");
		expect(incomplete.evidence).toEqual([]);
		expect(assessIdentityGroups({ metadataSchema,
			left: [{ id: 1, metadata: { account: "synthetic-account", region: "west" } }, { id: 2, metadata: {} }], right,
		}).decision).toBe("auto_link");
	});

	it("automatically links a declared unique match even when review-only fields differ", () => {
		const result = pair(
			{ id: 1, metadata: { email: "shared@example.test", phone: "1111111" } },
			{ id: 2, metadata: { email: " SHARED@example.test ", phone: "2222222" } },
		);
		expect(result.decision).toBe("auto_link");
		expect(result.evidence).toEqual([{ kind: "email", identifier: "shared@example.test" }]);
	});

	it("requires review when another unique field conflicts despite a matching field", () => {
		const metadataSchema = { "x-lobu-resolution": { rules: [
			{ fields: ["email"], normalizer: "email", onMatch: "auto_link" },
			{ fields: ["account"], normalizer: "exact", onMatch: "auto_link" },
		] } };
		const result = pair(
			{ id: 1, metadata: { email: "shared@example.test", account: "first" } },
			{ id: 2, metadata: { email: "shared@example.test", account: "second" } }, metadataSchema,
		);
		expect(result.decision).toBe("review");
		expect(result.reason).toContain("conflicting");
	});

	it("checks unique conflicts within either existing group", () => {
		const left = [{ id: 1, metadata: { email: "shared@example.test" } }, { id: 2, metadata: { email: "conflict@example.test" } }];
		const right = [{ id: 3, metadata: { email: "shared@example.test" } }];
		for (const sides of [{ left, right }, { left: right, right: left }]) {
			expect(assessIdentityGroups({ metadataSchema: schema, ...sides }).decision).toBe("review");
		}
	});

	it("matches shared members of multi-valued fields and deduplicates evidence", () => {
		const result = assessIdentityGroups({ metadataSchema: schema,
			left: [{ id: 1, metadata: { email: ["other@example.test", "shared@example.test"] } }],
			right: [{ id: 2, metadata: { email: "SHARED@example.test" } }, { id: 3, metadata: { email: "shared@example.test" } }],
		});
		expect(result.decision).toBe("auto_link");
		expect(result.evidence).toEqual([{ kind: "email", identifier: "shared@example.test" }]);
	});

	it("keeps review-only matches for human judgement", () => {
		const result = pair({ id: 1, metadata: { phone: "+44 7700 900 123" } }, { id: 2, metadata: { phone: "447700900123" } });
		expect(result.decision).toBe("review");
		expect(result.evidence).toEqual([{ kind: "phone", identifier: "447700900123" }]);
		expect(result.reason).toContain("phone");
	});

	it("never automatically associates an empty group", () => {
		const record = { id: 1, metadata: { email: "shared@example.test" } };
		for (const sides of [{ left: [record], right: [] }, { left: [], right: [record] }]) {
			const result = assessIdentityGroups({ metadataSchema: schema, ...sides });
			expect(result.decision).toBe("review");
			expect(result.evidence).toEqual([]);
		}
	});
});

describe("normalized identity claims", () => {
	it.each(["not-an-email", "person@.example.test", "a..b@example.test", "a@example", "", null, true])(
		"does not match malformed email %s", value => {
			const result = pair({ id: 1, metadata: { email: value } }, { id: 2, metadata: { email: value } });
			expect(result.evidence).toEqual([]);
			expect(result.decision).toBe("review");
		},
	);

	it.each(["call 1234567", "123456", "1234567890123456", "447700900123@example.test"])(
		"does not match malformed phone %s", phone => {
			expect(pair({ id: 1, metadata: { phone } }, { id: 2, metadata: { phone } }).evidence).toEqual([]);
		},
	);

	it("reads exact configured namespaces from claims independently of metadata", () => {
		const result = pair(
			{ id: 1, metadata: {}, identities: [{ namespace: "phone", identifier: "+44 7700 900 123" }] },
			{ id: 2, metadata: {}, identities: [{ namespace: "phone", identifier: "447700900123" }] },
		);
		expect(result.evidence).toEqual([{ kind: "phone", identifier: "447700900123" }]);
	});

	it("requires tenant scope equality and keeps scoped metadata mirrors scoped", () => {
		const record = (id: number, scopeKey: string | null): RecordInput => ({
			id, metadata: { email: "shared@example.test" },
			identities: [{ namespace: "email", identifier: "SHARED@example.test", scopeKey }],
		});
		expect(pair(record(1, "tenant-a"), record(2, "tenant-b")).evidence).toEqual([]);
		expect(pair(record(1, "tenant-a"), record(2, null)).evidence).toEqual([]);
		expect(pair(record(1, "tenant-a"), record(2, "tenant-a")).evidence).toEqual([
			{ kind: "email", identifier: "shared@example.test [tenant: tenant-a]" },
		]);
		expect(pair(record(1, null), record(2, null)).decision).toBe("auto_link");
	});

	it("keeps composite tenant tuples distinct when values contain separators", () => {
		const result = pair(
			{ id: 1, metadata: { region: "x" }, identities: [{ namespace: "account", identifier: "same", scopeKey: "tenant-a\u001fsegment" }] },
			{ id: 2, metadata: { region: "segment\u001fx" }, identities: [{ namespace: "account", identifier: "same", scopeKey: "tenant-a" }] },
			singleRule(["account", "region"], "exact", "auto_link"),
		);
		expect(result.evidence).toEqual([]);
		expect(result.decision).toBe("review");
	});

	it("does not infer a phone or repair a corrupted number from another namespace", () => {
		const shell = { id: 1, metadata: {}, identities: [
			{ namespace: "provider_id", identifier: "447700900123@example.test" },
			{ namespace: "phone", identifier: "447700900123" },
		] };
		const rule = readEntityResolutionRules(singleRule(["phone"], "phone"))[0]!;
		expect(normalizedResolutionRuleKeys(shell, rule)).toEqual(['[["447700900123",null]]']);
		expect(normalizedResolutionRuleKeys({ ...shell, identities: shell.identities.slice(0, 1) }, rule)).toEqual([]);
		expect(pair(shell, { id: 2, metadata: { phone: "070-090-0123" } }).evidence).toEqual([]);
	});

	it("combines metadata and claims only within each record", () => {
		const result = pair(
			{ id: 1, metadata: { account: "same" }, identities: [{ namespace: "region", identifier: "west" }] },
			{ id: 2, metadata: { region: "west" }, identities: [{ namespace: "account", identifier: "same" }] },
			singleRule(["account", "region"]),
		);
		expect(result.evidence).toEqual([{ kind: "account + region", identifier: "same · west" }]);
	});

	it("uses nested declared paths and preserves custom labels safely", () => {
		const result = pair(
			{ id: 1, metadata: { profile: { value: "shared" }, constructor: "key" } },
			{ id: 2, metadata: { profile: { value: "shared" }, constructor: "key" } },
			singleRule(["profile.value", "constructor"]),
		);
		expect(result.evidence).toEqual([{ kind: "profile.value + constructor", identifier: "shared · key" }]);
	});

	it("bounds a rule's Cartesian value expansion without partial matches", () => {
		const rule = readEntityResolutionRules(singleRule(["left", "right"]))[0]!;
		const values = Array.from({ length: 17 }, (_, index) => String(index));
		expect(normalizedResolutionRuleKeys({ id: 1, metadata: { left: values, right: values } }, rule)).toEqual([]);
	});
});

describe("identity decision fingerprints", () => {
	it("preserves the reviewed fingerprint of an unchanged explicit review policy", () => {
		// Persisted by the previous group assessor; no normalization or topology changed.
		const result = assessIdentityGroups({ metadataSchema: singleRule(["account"]),
			left: [{ id: 7, metadata: { account: "same" } }, { id: 8, metadata: { account: "unmatched" } }],
			right: [{ id: 9, metadata: { account: "same" } }],
		});
		expect(result.fingerprint).toBe("a16ba4258004af35f3a3ba1810842972da630f1049378664c52b0a903732f6fe");
	});

	it("includes unmatched values while ignoring member and value ordering", () => {
		const left = [{ id: 1, metadata: { email: ["shared@example.test", "unmatched@example.test"] } }, { id: 2, metadata: {} }];
		const right = [{ id: 3, metadata: { email: "shared@example.test" } }];
		const original = assessIdentityGroups({ metadataSchema: schema, left, right });
		const reordered = assessIdentityGroups({ metadataSchema: schema,
			left: [left[1], { id: 1, metadata: { email: ["unmatched@example.test", "shared@example.test"] } }], right });
		const changed = assessIdentityGroups({ metadataSchema: schema,
			left: [left[1], { id: 1, metadata: { email: ["new@example.test", "shared@example.test"] } }], right });
		expect(reordered.fingerprint).toBe(original.fingerprint);
		expect(changed.evidence).toEqual(original.evidence);
		expect(changed.fingerprint).not.toBe(original.fingerprint);
	});

	it("includes policy and group membership even when evidence remains identical", () => {
		const left = { id: 1, metadata: { email: "shared@example.test" } };
		const right = { id: 2, metadata: { email: "shared@example.test" } };
		const original = pair(left, right);
		const review = pair(left, right, singleRule(["email"], "email", "review"));
		expect(review.evidence).toEqual(original.evidence);
		expect(review.policyHash).not.toBe(original.policyHash);
		expect(review.fingerprint).not.toBe(original.fingerprint);
		expect(pair(right, left).fingerprint).not.toBe(original.fingerprint);
	});

	it("includes claims deterministically and changes with tenant scope", () => {
		const left = { id: 1, metadata: { email: "shared@example.test" } };
		const identities = [{ namespace: "phone", identifier: "447700900123" }, { namespace: "email", identifier: "shared@example.test" }];
		const original = pair(left, { id: 2, metadata: {}, identities });
		expect(pair(left, { id: 2, metadata: {}, identities: [...identities].reverse() }).fingerprint).toBe(original.fingerprint);
		expect(pair(left, { id: 2, metadata: {} }).fingerprint).not.toBe(original.fingerprint);
		expect(pair(left, { id: 2, metadata: {}, identities: identities.map(identity => ({ ...identity, scopeKey: "tenant-a" })) }).fingerprint).not.toBe(original.fingerprint);
	});
});
