import { describe, expect, it } from "vitest";
import { discoverEntityResolutionGroups } from "./discovery";
import {
	assessEntityResolution,
	assessIdentityGroups,
	normalizedResolutionRuleKeys,
} from "./policy";

const schema = {
	type: "object",
	"x-lobu-resolution": {
		rules: [
			{ fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
			{ fields: ["phone"], normalizer: "phone", onMatch: "review" },
		],
	},
};

describe("identity group resolution", () => {
	it("uses non-root evidence without combining composite fields from different records", () => {
		const metadataSchema = {
			"x-lobu-resolution": {
				rules: [{ fields: ["account", "region"], normalizer: "exact", onMatch: "auto_merge" }],
			},
		};
		const right = [{ id: 3, metadata: { account: "synthetic-account", region: "west" } }];
		const incomplete = assessIdentityGroups({
			metadataSchema,
			left: [{ id: 1, metadata: { account: "synthetic-account" } }, { id: 2, metadata: { region: "west" } }],
			right,
		});
		expect(incomplete.decision).toBe("review");
		expect(incomplete.evidence).toEqual([]);
		expect(assessIdentityGroups({
			metadataSchema,
			left: [{ id: 1, metadata: { account: "synthetic-account", region: "west" } }, { id: 2, metadata: {} }],
			right,
		}).decision).toBe("auto_merge");
	});

	it("requires review when members of one side conflict despite a direct cross-group match", () => {
		expect(assessIdentityGroups({
			metadataSchema: schema,
			left: [{ id: 1, metadata: { email: "shared@example.test" } }, { id: 2, metadata: { email: "conflict@example.test" } }],
			right: [{ id: 3, metadata: { email: "shared@example.test" } }],
		}).decision).toBe("review");
	});

	it("keeps equal source identifiers in different tenant scopes separate", () => {
		expect(assessIdentityGroups({
			metadataSchema: schema,
			left: [{ id: 1, metadata: {}, identities: [{ namespace: "email", identifier: "shared@example.test", scopeKey: "scope-a" }] }],
			right: [{ id: 2, metadata: {}, identities: [{ namespace: "email", identifier: "shared@example.test", scopeKey: "scope-b" }] }],
		}).decision).toBe("review");
	});

	it("fingerprints unmatched values while ignoring member and value ordering", () => {
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
});

describe("entity resolution module", () => {
	it("discovers connected components and chooses the most complete canonical record", () => {
		const result = discoverEntityResolutionGroups({
			metadataSchema: schema,
			candidates: [
				{ id: 3, metadata: { email: "person@example.com" } },
				{
					id: 4,
					metadata: {
						email: " Person@Example.com ",
						phone: "+44 123 456 789",
						title: "Engineer",
					},
				},
				{ id: 5, metadata: { phone: "44-123-456-789" } },
			],
		});
		expect(result).toEqual({
			groups: [{ winnerId: 4, loserIds: [3, 5] }],
			oversizedGroupCount: 0,
			deferredCandidateCount: 0,
		});
	});

	it("defers candidates without direct evidence to the chosen canonical record", () => {
		const chainSchema = {
			"x-lobu-resolution": {
				rules: [
					{ fields: ["email"], normalizer: "email", onMatch: "review" },
					{ fields: ["phone"], normalizer: "phone", onMatch: "review" },
					{ fields: ["external_id"], normalizer: "exact", onMatch: "review" },
				],
			},
		};
		const result = discoverEntityResolutionGroups({
			metadataSchema: chainSchema,
			candidates: [
				{ id: 1, metadata: { email: "same@example.com" } },
				{
					id: 2,
					metadata: { email: "same@example.com", phone: "+44 123 456 789" },
				},
				{
					id: 3,
					metadata: { phone: "+44 123 456 789", external_id: "remote-1" },
				},
				{ id: 4, metadata: { external_id: "remote-1" } },
			],
		});
		expect(result.groups).toEqual([{ winnerId: 2, loserIds: [1, 3] }]);
		expect(result.deferredCandidateCount).toBe(1);
	});

	it("does not invent matching semantics when the entity type has no policy", () => {
		const result = discoverEntityResolutionGroups({
			metadataSchema: { type: "object" },
			candidates: [
				{ id: 1, metadata: { email: "same@example.com" } },
				{ id: 2, metadata: { email: "same@example.com" } },
			],
		});
		expect(result.groups).toEqual([]);
	});

	it("keeps the built-in person automation useful with review-only defaults", () => {
		const result = discoverEntityResolutionGroups({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			candidates: [
				{ id: 1, metadata: { email: "same@example.com" } },
				{ id: 2, metadata: { email: " SAME@example.com " } },
				{ id: 3, metadata: { phone: "+44 123 456 789" } },
				{ id: 4, metadata: { phone: "44-123-456-789" } },
			],
		});
		expect(result.groups).toEqual([
			{ winnerId: 1, loserIds: [2] },
			{ winnerId: 3, loserIds: [4] },
		]);
		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: { id: 1, metadata: { email: "same@example.com" } },
			losers: [{ id: 2, metadata: { email: " SAME@example.com " } }],
		});
		expect(assessment.decision).toBe("review");
		expect(assessment.reason).toBe(
			"Matching email points to the same thing, but that is not enough to merge automatically under this entity type's policy, so it needs your judgement.",
		);
	});

	it("names the entity type's own resolution fields verbatim in the reason", () => {
		// A custom field must survive intact — naive singularization turned
		// "status" into "statu".
		const customSchema = {
			type: "object",
			"x-lobu-resolution": {
				rules: [
					{ fields: ["status"], normalizer: "exact", onMatch: "review" },
				],
			},
		};
		const assessment = assessEntityResolution({
			metadataSchema: customSchema,
			winner: { id: 1, metadata: {} },
			losers: [{ id: 2, metadata: {} }],
		});
		expect(assessment.reason).toBe(
			"No matching status could be verified automatically, so this merge needs your judgement.",
		);
	});

	it("coalesces only the known singular/plural field aliases", () => {
		// person defaults are email/emails/phone/phones — a reader wants two names.
		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: { id: 1, metadata: {} },
			losers: [{ id: 2, metadata: {} }],
		});
		expect(assessment.reason).toBe(
			"No matching email or phone could be verified automatically, so this merge needs your judgement.",
		);
	});

	it("auto-merges a configured unique identity but reviews conflicting strict identities", () => {
		const base = {
			metadataSchema: schema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", phone: "1111111" },
			},
		};
		expect(
			assessEntityResolution({
				...base,
				losers: [
					{
						id: 2,
						metadata: { email: "SAME@example.com", phone: "2222222" },
					},
				],
			}).decision,
		).toBe("auto_merge");

		const strictSchema = {
			...schema,
			"x-lobu-resolution": {
				rules: [
					{ fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
					{
						fields: ["external_id"],
						normalizer: "exact",
						onMatch: "auto_merge",
					},
				],
			},
		};
		const conflict = assessEntityResolution({
			metadataSchema: strictSchema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", external_id: "one" },
			},
			losers: [
				{
					id: 2,
					metadata: { email: "same@example.com", external_id: "two" },
				},
			],
		});
		expect(conflict.decision).toBe("review");

		const changedConflict = assessEntityResolution({
			metadataSchema: strictSchema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", external_id: "three" },
			},
			losers: [
				{
					id: 2,
					metadata: { email: "same@example.com", external_id: "four" },
				},
			],
		});
		expect(changedConflict.fingerprint).not.toBe(conflict.fingerprint);
	});

	it("explains mixed-policy groups without denying configured automatic rules", () => {
		const mixedMatch = assessEntityResolution({
			metadataSchema: schema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", phone: "1111111" },
			},
			losers: [
				{ id: 2, metadata: { email: "same@example.com" } },
				{ id: 3, metadata: { phone: "1111111" } },
			],
		});
		expect(mixedMatch.decision).toBe("review");
		expect(mixedMatch.reason).toBe(
			"Matching email and phone points to the same thing, but that is not enough to merge automatically under this entity type's policy, so it needs your judgement.",
		);
	});

	it("rejects malformed email and phone values as deterministic identities", () => {
		expect(
			discoverEntityResolutionGroups({
				metadataSchema: schema,
				candidates: [
					{
						id: 1,
						metadata: { email: "not-an-email", phone: "call 1234567" },
					},
					{
						id: 2,
						metadata: { email: "not-an-email", phone: "call 1234567" },
					},
				],
			}).groups,
		).toEqual([]);
		expect(
			assessEntityResolution({
				metadataSchema: schema,
				winner: { id: 1, metadata: { email: "person@.example.com" } },
				losers: [{ id: 2, metadata: { email: "person@.example.com" } }],
			}).decision,
		).toBe("review");
	});

	it("matches an identity shared by multi-valued fields", () => {
		const assessment = assessEntityResolution({
			metadataSchema: schema,
			winner: {
				id: 1,
				metadata: {
					email: ["primary@example.com", "shared@example.com"],
				},
			},
			losers: [
				{
					id: 2,
					metadata: { email: ["SHARED@example.com"] },
				},
			],
		});
		expect(assessment.decision).toBe("auto_merge");
		expect(assessment.evidence).toContainEqual({
			kind: "email",
			identifier: "shared@example.com",
		});
	});

	it("changes the rejection fingerprint when a conflicting strict value changes", () => {
		const strictSchema = {
			"x-lobu-resolution": {
				rules: [
					{ fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
					{
						fields: ["external_id"],
						normalizer: "exact",
						onMatch: "auto_merge",
					},
				],
			},
		};
		const assess = (externalId: string) =>
			assessEntityResolution({
				metadataSchema: strictSchema,
				winner: {
					id: 1,
					metadata: { email: "same@example.com", external_id: "one" },
				},
				losers: [
					{
						id: 2,
						metadata: {
							email: "same@example.com",
							external_id: externalId,
						},
					},
				],
			});

		expect(assess("two").fingerprint).not.toBe(assess("three").fingerprint);
	});

	it("reads rule-field values from entity_identities rows, not just metadata", () => {
		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: {
				id: 1,
				metadata: {},
				identities: [{ namespace: "phone", identifier: "+44 7700 900 123" }],
			},
			losers: [
				{
					id: 2,
					metadata: {},
					identities: [{ namespace: "phone", identifier: "447700900123" }],
				},
			],
		});
		expect(assessment.decision).toBe("review");
		expect(assessment.evidence).toContainEqual({
			kind: "phone",
			identifier: "447700900123",
		});
		expect(assessment.resolutionKeys).toEqual([
			{ id: 1, keys: { phone: ["447700900123"] } },
			{ id: 2, keys: { phone: ["447700900123"] } },
		]);
	});

	it("requires identity scope keys to agree before producing merge evidence", () => {
		const assess = (leftScopeKey: string | null, rightScopeKey: string | null) =>
			assessEntityResolution({
				metadataSchema: { type: "object" },
				entityTypeSlug: "person",
				winner: {
					id: 1,
					metadata: {},
					identities: [
						{ namespace: "phone", identifier: "+44 7700 900 123", scopeKey: leftScopeKey },
					],
				},
				losers: [
					{
						id: 2,
						metadata: {},
						identities: [
							{ namespace: "phone", identifier: "447700900123", scopeKey: rightScopeKey },
						],
					},
				],
			});

		expect(assess("tenant-a", "tenant-b").evidence).toEqual([]);
		expect(assess("tenant-a", "tenant-a").evidence).toContainEqual({
			kind: "phone",
			identifier: "447700900123 [tenant: tenant-a]",
		});
		expect(assess(null, null).evidence).toContainEqual({
			kind: "phone",
			identifier: "447700900123",
		});
	});

	it("keeps multi-field tenant tuples distinct when values contain separators", () => {
		const assessment = assessEntityResolution({
			metadataSchema: {
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["account", "region"],
							normalizer: "exact",
							onMatch: "auto_merge",
						},
					],
				},
			},
			winner: {
				id: 1,
				metadata: { region: "x" },
				identities: [
					{
						namespace: "account",
						identifier: "same",
						scopeKey: "tenant-a\u001fsegment",
					},
				],
			},
			losers: [
				{
					id: 2,
					metadata: { region: "segment\u001fx" },
					identities: [
						{
							namespace: "account",
							identifier: "same",
							scopeKey: "tenant-a",
						},
					],
				},
			],
		});

		expect(assessment.decision).toBe("review");
		expect(assessment.evidence).toEqual([]);
	});

	it("reads a JID-shell's phone identity but does not match a corrupted metadata phone", () => {
		// The run-702088 prod shape (numbers sanitized): the WhatsApp shell has
		// its phone only in entity_identities; the named contact's metadata phone
		// was double-split on import, losing the country code. The shell's
		// identity must be read; the corrupted number still must NOT match —
		// repairing import-mangled phones is a separate bug, and inventing a
		// match here would paper over it.
		const phoneRule: Parameters<typeof normalizedResolutionRuleKeys>[1] = {
			fields: ["phone"],
			normalizer: "phone",
			onMatch: "review",
		};
		const jidShell = {
			id: 519,
			metadata: {},
			identities: [
				{ namespace: "wa_jid", identifier: "447700900123@s.whatsapp.net" },
				{ namespace: "phone", identifier: "447700900123" },
			],
		};
		expect(normalizedResolutionRuleKeys(jidShell, phoneRule)).toEqual([
			'[["447700900123",null]]',
		]);

		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: {
				id: 24002,
				metadata: { phone: "070-090-0123", email: "" },
			},
			losers: [jidShell],
		});
		expect(assessment.decision).toBe("review");
		expect(assessment.evidence).toEqual([]);
	});

	it("never treats an identity from another namespace as a rule-field value", () => {
		const jidOnly = {
			id: 1,
			metadata: {},
			identities: [
				{ namespace: "wa_jid", identifier: "447700900123@s.whatsapp.net" },
			],
		};
		expect(
			normalizedResolutionRuleKeys(jidOnly, {
				fields: ["phone"],
				normalizer: "phone",
				onMatch: "review",
			}),
		).toEqual([]);
		expect(
			normalizedResolutionRuleKeys(jidOnly, {
				fields: ["wa_jid"],
				normalizer: "phone",
				onMatch: "review",
			}),
		).toEqual([]);
	});

	it("folds identities into the fingerprint deterministically", () => {
		const assess = (
			identities: Array<{ namespace: string; identifier: string }>,
		) =>
			assessEntityResolution({
				metadataSchema: { type: "object" },
				entityTypeSlug: "person",
				winner: { id: 1, metadata: { email: "same@example.com" } },
				losers: [{ id: 2, metadata: {}, identities }],
			});

		const without = assess([]);
		const withPhone = assess([
			{ namespace: "phone", identifier: "447700900123" },
			{ namespace: "email", identifier: "same@example.com" },
		]);
		expect(withPhone.fingerprint).not.toBe(without.fingerprint);
		const reordered = assess([
			{ namespace: "email", identifier: "same@example.com" },
			{ namespace: "phone", identifier: "447700900123" },
		]);
		expect(reordered.fingerprint).toBe(withPhone.fingerprint);
	});

	it("keeps discovery grouping and assessment in agreement on identity-only matches", () => {
		const namedContact = {
			id: 1,
			metadata: { title: "Engineer" },
			identities: [{ namespace: "phone", identifier: "+44 7700 900 123" }],
		};
		const shell = {
			id: 2,
			metadata: {},
			identities: [{ namespace: "phone", identifier: "447700900123" }],
		};
		const discovered = discoverEntityResolutionGroups({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			candidates: [namedContact, shell],
		});
		expect(discovered.groups).toEqual([{ winnerId: 1, loserIds: [2] }]);

		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: namedContact,
			losers: [shell],
		});
		expect(assessment.evidence).toContainEqual({
			kind: "phone",
			identifier: "447700900123",
		});
	});

	it("draws each field of a combination rule from metadata and identities alike", () => {
		const comboSchema = {
			"x-lobu-resolution": {
				rules: [
					{
						fields: ["email", "phone"],
						normalizer: "exact",
						onMatch: "review",
					},
				],
			},
		};
		const assessment = assessEntityResolution({
			metadataSchema: comboSchema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com" },
				identities: [{ namespace: "phone", identifier: "447700900123" }],
			},
			losers: [
				{
					id: 2,
					metadata: { phone: "447700900123" },
					identities: [{ namespace: "email", identifier: "same@example.com" }],
				},
			],
		});
		expect(assessment.evidence).toContainEqual({
			kind: "email + phone",
			identifier: "same@example.com · 447700900123",
		});
	});

	it("records custom rule labels without colliding with object prototype keys", () => {
		const assessment = assessEntityResolution({
			metadataSchema: {
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["constructor"],
							normalizer: "exact",
							onMatch: "review",
						},
					],
				},
			},
			winner: { id: 1, metadata: { constructor: "shared" } },
			losers: [{ id: 2, metadata: { constructor: "shared" } }],
		});

		expect(assessment.resolutionKeys).toEqual([
			{ id: 1, keys: { constructor: ["shared"] } },
			{ id: 2, keys: { constructor: ["shared"] } },
		]);
	});

	it("rejects oversized decision batches before returning partial work", () => {
		const candidates = Array.from({ length: 400 }, (_, index) => ({
			id: index + 1,
			metadata: { email: `pair-${Math.floor(index / 2)}@example.com` },
		}));
		expect(() =>
			discoverEntityResolutionGroups({
				metadataSchema: schema,
				candidates,
				maxGroups: 500,
				maxOperations: 199,
			}),
		).toThrow(/199 duplicate decisions/);
	});

	it("bounds direct-neighbor work for one oversized identity component", () => {
		const candidates = Array.from({ length: 5_000 }, (_, index) => ({
			id: index + 1,
			metadata: { email: "shared@example.com" },
		}));
		expect(
			discoverEntityResolutionGroups({
				metadataSchema: schema,
				candidates,
			}),
		).toEqual({
			groups: [],
			oversizedGroupCount: 1,
			deferredCandidateCount: 0,
		});
	});
});
