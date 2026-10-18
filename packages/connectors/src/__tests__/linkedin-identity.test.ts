import { describe, expect, it } from 'vitest';
import {
  LINKEDIN_IDENTITY,
  linkedInChatUserIdentity,
  linkedInIdentityModule,
  normalizeLinkedInIdentityValue,
  normalizeLinkedInMemberId,
  normalizeLinkedInSlug,
} from '../linkedin-identity';

describe('LinkedIn identity module', () => {
  it('normalizes profile slugs and rejects non-profile URLs', () => {
    expect(
      normalizeLinkedInSlug('https://www.LinkedIn.com/in/Jane-Doe/?trk=x'),
    ).toBe('jane-doe');
    expect(
      normalizeLinkedInSlug('https://www.linkedin.com/company/acme'),
    ).toBeNull();
  });

  it('normalizes person member ids and rejects other URNs', () => {
    expect(normalizeLinkedInMemberId('urn:li:fsd_profile:ACoAAB1234')).toBe(
      'ACoAAB1234',
    );
    expect(normalizeLinkedInMemberId('urn:li:fsd_company:99')).toBeNull();
  });

  it('owns both namespaces and makes both recallable', () => {
    expect(
      normalizeLinkedInIdentityValue(LINKEDIN_IDENTITY.SLUG, 'Jane-Doe'),
    ).toBe('jane-doe');
    expect(linkedInIdentityModule.recallNamespaces).toEqual([
      LINKEDIN_IDENTITY.SLUG,
      LINKEDIN_IDENTITY.MEMBER_ID,
    ]);
  });
});

describe("LinkedIn chat sender identity", () => {
	it("keys a direct-message sender by member id in its own namespace", () => {
		expect(linkedInChatUserIdentity.namespace).toBe("linkedin_user_member_id");
		expect(linkedInChatUserIdentity.namespace).not.toBe(LINKEDIN_IDENTITY.MEMBER_ID);
		expect(
			linkedInChatUserIdentity.buildUserKey(null, "urn:li:fsd_profile:ACoAASynthetic"),
		).toBe("ACoAASynthetic");
		expect(linkedInChatUserIdentity.buildUserKey("ignored", "ACoAASynthetic")).toBe(
			"ACoAASynthetic",
		);
		expect(linkedInChatUserIdentity.userKeyScope(null)).toEqual({ kind: "global" });
		expect(linkedInChatUserIdentity.platformUserIdFromKey("ACoAASynthetic")).toBe(
			"ACoAASynthetic",
		);
	});

	it("refuses a company or malformed sender", () => {
		expect(linkedInChatUserIdentity.buildUserKey(null, "urn:li:fsd_company:99")).toBeNull();
		expect(linkedInChatUserIdentity.buildUserKey(null, "")).toBeNull();
		expect(linkedInChatUserIdentity.buildUserKey(null, null)).toBeNull();
		expect(
			normalizeLinkedInIdentityValue(LINKEDIN_IDENTITY.USER_MEMBER_ID, "urn:li:member:42"),
		).toBe("42");
	});
});
