/**
 * What the guard decides. That the HANDLER consults it is pinned separately by
 * `__tests__/integration/chat-connection-settings-operator-only.test.ts`.
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
		// An allowlist judges NAMES, so a falsy value is not a special case.
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
		const denied = denyOperatorOnlyChatSettings({
			allowGroups: true,
			previewMode: true,
			someFutureFlag: 1,
		});
		// Against the REJECTED list specifically: the message also spells out the
		// accepted keys, so a substring check on the whole string proves nothing.
		const rejectedList = /not settable here: ([^.]+)\./.exec(
			denied?.error ?? "",
		)?.[1];
		expect(rejectedList).toBeDefined();
		expect(rejectedList?.split(", ").sort()).toEqual([
			"previewMode",
			"someFutureFlag",
		]);
	});

	it("judges OWN enumerable keys only", () => {
		// A key reachable only through the prototype never lands in the row, so it
		// is ignored; an own key on a null-prototype object still is refused.
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

	it("pins the allowlist so widening it cannot be silent", () => {
		// The only way the tenant-settable surface grows is an edit to this list.
		expect([...TENANT_SETTABLE_CHAT_SETTINGS].sort()).toEqual([
			"allowFrom",
			"allowGroups",
			"recordChannelMessages",
			"userConfigScopes",
		]);
	});
});
