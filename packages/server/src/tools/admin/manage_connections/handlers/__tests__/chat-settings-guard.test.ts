/**
 * Allowlist semantics for tenant-supplied chat `connection.settings`.
 *
 * The companion integration test
 * (`__tests__/integration/chat-connection-settings-operator-only.test.ts`) pins
 * that the HANDLER consults this guard. These cases pin what the guard decides,
 * which is the part worth enumerating exhaustively and does not need a database.
 *
 * The rule is an ALLOWLIST, not a denylist of known-bad keys: `settings` is an
 * open `Record<string, any>` in the tool contract, and the runtime reads its own
 * operator flags out of the very same object. A denylist would admit every
 * privileged key added after it was written.
 */

import { describe, expect, it } from "vitest";
import {
	denyOperatorOnlyChatSettings,
	TENANT_SETTABLE_CHAT_SETTINGS,
} from "../chat-settings-guard";

describe("denyOperatorOnlyChatSettings", () => {
	it("admits every key a tenant legitimately owns", () => {
		expect(
			denyOperatorOnlyChatSettings({
				allowGroups: false,
				allowFrom: ["U123"],
				userConfigScopes: ["skills"],
				recordChannelMessages: true,
			}),
		).toBeNull();
	});

	it("admits an absent or empty settings object", () => {
		expect(denyOperatorOnlyChatSettings(undefined)).toBeNull();
		expect(denyOperatorOnlyChatSettings({})).toBeNull();
	});

	it("refuses previewMode and names it", () => {
		const denied = denyOperatorOnlyChatSettings({ previewMode: true });
		expect(denied?.error).toEqual(expect.stringContaining("previewMode"));
	});

	it("refuses previewMode on PRESENCE, whatever the value", () => {
		// `false` reads as harmless, but accepting it concedes the key is part of
		// the tenant's vocabulary — and a settings-merging update path could then
		// carry it forward. Presence is the test.
		for (const value of [false, null, 0, "", "false"]) {
			const denied = denyOperatorOnlyChatSettings({ previewMode: value });
			expect(denied?.error).toEqual(expect.stringContaining("previewMode"));
		}
	});

	it("refuses an unknown key and names it", () => {
		const denied = denyOperatorOnlyChatSettings({ someFutureFlag: true });
		expect(denied?.error).toEqual(expect.stringContaining("someFutureFlag"));
	});

	it("names every offending key, not just the first", () => {
		// A caller fixing one key at a time across round-trips is a bad
		// experience; report the whole set.
		const denied = denyOperatorOnlyChatSettings({
			allowGroups: true,
			previewMode: true,
			someFutureFlag: 1,
		});
		// Assert against the REJECTED list specifically — the message also spells
		// out the accepted keys as guidance, so a naive substring check on the
		// whole string would match `allowGroups` there and prove nothing.
		const rejectedList = /not settable here: ([^.]+)\./.exec(
			denied?.error ?? "",
		)?.[1];
		expect(rejectedList).toBeDefined();
		expect(rejectedList?.split(", ").sort()).toEqual([
			"previewMode",
			"someFutureFlag",
		]);
	});

	it("refuses inherited/prototype keys without walking the prototype chain", () => {
		// `Object.keys` semantics, pinned: a caller cannot smuggle a key via the
		// prototype, and an object with a null prototype is handled.
		const viaPrototype = Object.create({ previewMode: true }) as Record<
			string,
			unknown
		>;
		viaPrototype.allowGroups = true;
		expect(denyOperatorOnlyChatSettings(viaPrototype)).toBeNull();

		const nullProto = Object.assign(Object.create(null), {
			previewMode: true,
		}) as Record<string, unknown>;
		expect(denyOperatorOnlyChatSettings(nullProto)?.error).toEqual(
			expect.stringContaining("previewMode"),
		);
	});

	it("keeps the allowlist in step with what tenants may set", () => {
		// Guard the guard: if someone adds a key here without deciding whether a
		// tenant may own it, this fails rather than silently widening the surface.
		expect([...TENANT_SETTABLE_CHAT_SETTINGS].sort()).toEqual([
			"allowFrom",
			"allowGroups",
			"recordChannelMessages",
			"userConfigScopes",
		]);
	});
});
