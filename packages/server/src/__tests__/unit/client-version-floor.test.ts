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
		expect(meetsClientVersionFloor(null)).toBe(true);
		expect(meetsClientVersionFloor("garbage")).toBe(true);
		expect(meetsClientVersionFloor("0.0.1")).toBe(true);
	});

	test("a set floor compares numerically and fails closed on unknowns", () => {
		process.env.MIN_CLIENT_VERSION = "1.4.0";
		expect(meetsClientVersionFloor("1.4.0")).toBe(true);
		expect(meetsClientVersionFloor("1.4.1")).toBe(true);
		expect(meetsClientVersionFloor("1.10.0")).toBe(true);
		expect(meetsClientVersionFloor("2.0.0")).toBe(true);
		expect(meetsClientVersionFloor("1.3.9")).toBe(false);
		expect(meetsClientVersionFloor("0.9.9")).toBe(false);
		expect(meetsClientVersionFloor(null)).toBe(false);
		expect(meetsClientVersionFloor("not-a-version")).toBe(false);
	});

	test("an unparseable floor refuses nothing (misconfiguration must not brick the fleet)", () => {
		process.env.MIN_CLIENT_VERSION = "someday";
		expect(meetsClientVersionFloor("0.0.1")).toBe(true);
		expect(meetsClientVersionFloor(null)).toBe(true);
	});

	test("messages name the client when known", () => {
		expect(clientFloorMessage("chrome-extension")).toContain("Chrome extension");
		expect(clientFloorMessage("macos")).toContain("Mac app");
		expect(clientFloorMessage("headless")).toContain("headless worker");
		expect(clientFloorMessage(null)).toContain("Lobu client");
		expect(clientFloorMessage("something-new")).toContain("Lobu client");
	});
});
