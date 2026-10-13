import { describe, expect, test } from "bun:test";
import {
	normalizeWhatsAppUserJid,
	normalizeWhatsAppWebIdentityValue,
	WHATSAPP_WEB_IDENTITY,
	whatsAppWebChatUserIdentity,
} from "../whatsapp-web-identity";

// Synthetic numbers only.
const PHONE = "15550000001";
const LID = "90000000000001";

describe("normalizeWhatsAppUserJid", () => {
	test("canonicalizes a phone-number JID, including the web client spelling", () => {
		expect(normalizeWhatsAppUserJid(`${PHONE}@s.whatsapp.net`)).toBe(
			`${PHONE}@s.whatsapp.net`,
		);
		expect(normalizeWhatsAppUserJid(`${PHONE}@c.us`)).toBe(
			`${PHONE}@s.whatsapp.net`,
		);
		expect(normalizeWhatsAppUserJid(`  ${PHONE}@S.WhatsApp.Net `)).toBe(
			`${PHONE}@s.whatsapp.net`,
		);
	});

	test("keeps a LID as a LID", () => {
		expect(normalizeWhatsAppUserJid(`${LID}@lid`)).toBe(`${LID}@lid`);
	});

	test("never treats a phone JID and a LID as the same key", () => {
		// Same digits under both servers are still two different identities.
		expect(normalizeWhatsAppUserJid(`${PHONE}@lid`)).not.toBe(
			normalizeWhatsAppUserJid(`${PHONE}@s.whatsapp.net`),
		);
	});

	test("drops a multi-device suffix, which addresses a device of the same person", () => {
		expect(normalizeWhatsAppUserJid(`${PHONE}:12@s.whatsapp.net`)).toBe(
			`${PHONE}@s.whatsapp.net`,
		);
		expect(normalizeWhatsAppUserJid(`${LID}:3@lid`)).toBe(`${LID}@lid`);
	});

	test("refuses conversations and broadcast targets, which are not people", () => {
		expect(normalizeWhatsAppUserJid("120363000000000001@g.us")).toBeNull();
		expect(normalizeWhatsAppUserJid(`${PHONE}-1600000000@g.us`)).toBeNull();
		expect(normalizeWhatsAppUserJid("status@broadcast")).toBeNull();
		expect(
			normalizeWhatsAppUserJid("120363000000000001@newsletter"),
		).toBeNull();
	});

	test("refuses malformed values", () => {
		for (const bad of [
			"",
			"   ",
			PHONE,
			`@s.whatsapp.net`,
			`+${PHONE}@s.whatsapp.net`,
			`abc@s.whatsapp.net`,
			`${PHONE}@s.whatsapp.net@lid`,
			`${PHONE}:x@s.whatsapp.net`,
			`1234@s.whatsapp.net`,
			`${"1".repeat(33)}@lid`,
		]) {
			expect(normalizeWhatsAppUserJid(bad)).toBeNull();
		}
		expect(normalizeWhatsAppUserJid(null)).toBeNull();
		expect(normalizeWhatsAppUserJid(undefined)).toBeNull();
	});
});

describe("WhatsApp Web identity wiring", () => {
	test("owns only its own namespace", () => {
		expect(
			normalizeWhatsAppWebIdentityValue(
				WHATSAPP_WEB_IDENTITY.USER_JID,
				`${PHONE}@c.us`,
			),
		).toBe(`${PHONE}@s.whatsapp.net`);
		expect(
			normalizeWhatsAppWebIdentityValue(WHATSAPP_WEB_IDENTITY.USER_JID, "nope"),
		).toBeNull();
		expect(
			normalizeWhatsAppWebIdentityValue("wa_jid", `${PHONE}@c.us`),
		).toBeUndefined();
	});

	test("chat identity keys a sender with no tenant axis and round-trips the address", () => {
		const identity = whatsAppWebChatUserIdentity;
		expect(identity.platform).toBe("whatsapp.web");
		expect(identity.buildUserKey(undefined, `${PHONE}@c.us`)).toBe(
			`${PHONE}@s.whatsapp.net`,
		);
		expect(identity.buildUserKey("ignored", `${LID}@lid`)).toBe(`${LID}@lid`);
		expect(
			identity.buildUserKey(undefined, "120363000000000001@g.us"),
		).toBeNull();
		expect(identity.userKeyScope(undefined)).toEqual({ kind: "global" });
		expect(identity.platformUserIdFromKey(`${LID}@lid`)).toBe(`${LID}@lid`);
		expect(identity.platformUserIdFromKey("garbage")).toBeNull();
	});
});
