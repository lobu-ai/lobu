import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clientFloorMessage,
	meetsClientVersionFloor,
	parseClientVersion,
} from "../../worker-api/client-version-floor";

describe("client version floor", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.MIN_CLIENT_VERSION;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.MIN_CLIENT_VERSION;
		else process.env.MIN_CLIENT_VERSION = saved;
	});

	test("parses dotted numerics, rejects everything else", () => {
		expect(parseClientVersion("1.2.3")).toEqual([1, 2, 3]);
		expect(parseClientVersion("0.8.1.0")).toEqual([0, 8, 1]);
		expect(parseClientVersion(null)).toBeNull();
		expect(parseClientVersion("")).toBeNull();
		expect(parseClientVersion("1.2")).toBeNull();
		expect(parseClientVersion("v1.2.3")).toBeNull();
		expect(parseClientVersion("1.2.x")).toBeNull();
	});

	test("unset floor allows everything, including unknown versions", () => {
		delete process.env.MIN_CLIENT_VERSION;
		expect(meetsClientVersionFloor("macos", null)).toBe(true);
		expect(meetsClientVersionFloor("macos", "garbage")).toBe(true);
		expect(meetsClientVersionFloor("macos", "0.0.1")).toBe(true);
	});

	test("each platform is gated on its own version line", () => {
		process.env.MIN_CLIENT_VERSION = "macos=1.4.0,headless=20.1.0";
		expect(meetsClientVersionFloor("macos", "1.4.0")).toBe(true);
		expect(meetsClientVersionFloor("macos", "1.10.0")).toBe(true);
		expect(meetsClientVersionFloor("macos", "2.0.0")).toBe(true);
		expect(meetsClientVersionFloor("macos", "1.3.9")).toBe(false);
		expect(meetsClientVersionFloor("headless", "20.1.0")).toBe(true);
		expect(meetsClientVersionFloor("headless", "19.9.9")).toBe(false);
		// A floor for one line never gates another.
		expect(meetsClientVersionFloor("headless", "0.9.0")).toBe(false);
		expect(meetsClientVersionFloor("macos", "20.1.0")).toBe(true);
	});

	test("a platform with no entry is allowed, even with a floor set", () => {
		process.env.MIN_CLIENT_VERSION = "macos=1.4.0";
		expect(meetsClientVersionFloor("chrome-extension", "0.1.0")).toBe(true);
		expect(meetsClientVersionFloor("chrome-extension", null)).toBe(true);
		expect(meetsClientVersionFloor(null, "0.0.1")).toBe(true);
	});

	test("a set floor fails closed on missing or unparseable client versions", () => {
		process.env.MIN_CLIENT_VERSION = "macos=1.4.0";
		expect(meetsClientVersionFloor("macos", null)).toBe(false);
		expect(meetsClientVersionFloor("macos", "not-a-version")).toBe(false);
	});

	test("malformed map entries are ignored, never enforced", () => {
		process.env.MIN_CLIENT_VERSION = "someday,macos,=1.2.3,macos=bogus";
		expect(meetsClientVersionFloor("macos", "0.0.1")).toBe(true);
		expect(meetsClientVersionFloor("macos", null)).toBe(true);
	});

	test("messages name the client when known", () => {
		expect(clientFloorMessage("chrome-extension")).toContain("Chrome extension");
		expect(clientFloorMessage("macos")).toContain("Mac app");
		expect(clientFloorMessage("headless")).toContain("headless worker");
		expect(clientFloorMessage(null)).toContain("Lobu client");
		expect(clientFloorMessage("something-new")).toContain("Lobu client");
	});
});
