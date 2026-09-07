import { describe, expect, test } from "bun:test";
import {
	isPersonalOrgDeletionBlocked,
	readPersonalOrgOwnerId,
} from "../../auth/personal-org-provisioning";

/**
 * The personal org anchors device pairing, `workerOrgIds`, and auto-wire.
 * Deleting it strands the account (403 on pair, 403 on every worker poll,
 * silent auto-wire no-op), so `beforeDeleteOrganization` refuses it. These
 * cover the predicate that hook calls.
 *
 * The guard RESTRICTS an action, so every ambiguous input must fail open —
 * treating an unreadable row as personal would make team orgs undeletable.
 */

const USER = "user_abc123";
const OTHER = "user_zzz999";

describe("readPersonalOrgOwnerId", () => {
	test("reads the marker from a JSON string (the DB column shape)", () => {
		const raw = JSON.stringify({ personal_org_for_user_id: USER });
		expect(readPersonalOrgOwnerId(raw)).toBe(USER);
	});

	test("reads the marker from an object (the Better Auth hook shape)", () => {
		expect(readPersonalOrgOwnerId({ personal_org_for_user_id: USER })).toBe(
			USER,
		);
	});

	test("returns null for metadata without the marker", () => {
		expect(readPersonalOrgOwnerId(JSON.stringify({ theme: "dark" }))).toBeNull();
		expect(readPersonalOrgOwnerId({})).toBeNull();
	});

	test("returns null for absent metadata", () => {
		expect(readPersonalOrgOwnerId(null)).toBeNull();
		expect(readPersonalOrgOwnerId(undefined)).toBeNull();
	});

	test("returns null for unparseable metadata rather than throwing", () => {
		expect(readPersonalOrgOwnerId("{not json")).toBeNull();
	});

	test("returns null for a non-string or empty marker", () => {
		expect(readPersonalOrgOwnerId({ personal_org_for_user_id: 42 })).toBeNull();
		expect(
			readPersonalOrgOwnerId({ personal_org_for_user_id: null }),
		).toBeNull();
		expect(readPersonalOrgOwnerId({ personal_org_for_user_id: "" })).toBeNull();
	});
});

describe("isPersonalOrgDeletionBlocked", () => {
	test("blocks the owner deleting their own personal org", () => {
		const meta = JSON.stringify({ personal_org_for_user_id: USER });
		expect(isPersonalOrgDeletionBlocked(meta, USER)).toBe(true);
	});

	test("allows deleting a team org", () => {
		const meta = JSON.stringify({ theme: "dark" });
		expect(isPersonalOrgDeletionBlocked(meta, USER)).toBe(false);
		expect(isPersonalOrgDeletionBlocked(null, USER)).toBe(false);
	});

	test("does not block on someone else's personal-org marker", () => {
		// Defensive: better-auth already gates delete on ownership, so this
		// should be unreachable. The guard is about protecting YOUR anchor —
		// it must not become a second, differently-worded authz check.
		const meta = JSON.stringify({ personal_org_for_user_id: OTHER });
		expect(isPersonalOrgDeletionBlocked(meta, USER)).toBe(false);
	});

	test("fails open on unreadable metadata so team orgs stay deletable", () => {
		expect(isPersonalOrgDeletionBlocked("{not json", USER)).toBe(false);
	});
});
