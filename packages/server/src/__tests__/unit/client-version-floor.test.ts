import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { canaryVersion } from "../../../../../scripts/canary-publish.mjs";
import {
	clientFloorMessage,
	clientUpdateHint,
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

	test("parses dotted numerics and rejects malformed numeric versions", () => {
		expect(parseClientVersion("1.2.3")).toEqual([1, 2, 3]);
		expect(parseClientVersion("0.8.1.0")).toEqual([0, 8, 1]);
		expect(parseClientVersion(null)).toBeNull();
		expect(parseClientVersion("")).toBeNull();
		expect(parseClientVersion("1.2")).toBeNull();
		expect(parseClientVersion("v1.2.3")).toBeNull();
		expect(parseClientVersion("1.2.x")).toBeNull();
	});

	test("accepts the published canary format and enforces its release floor", () => {
		const version = (base: string) =>
			canaryVersion(base, "1700000000", "a".repeat(40));
		expect(parseClientVersion(version("21.2.1"))).toEqual([21, 2, 1]);
		process.env.MIN_CLIENT_VERSION = "headless=20.1.0";
		expect(meetsClientVersionFloor("headless", version("20.1.0"))).toBe(true);
		expect(meetsClientVersionFloor("headless", version("21.2.1"))).toBe(true);
		expect(meetsClientVersionFloor("headless", version("20.0.9"))).toBe(false);
	});

	test("unknown or incomplete release suffixes remain fail-closed", () => {
		process.env.MIN_CLIENT_VERSION = "headless=20.1.0";
		for (const version of [
			"21.2.1-beta.1",
			"21.2.1-canary",
			"21.2.1-canary.1700000000.gabc123",
			`21.2.1-canary.0.g${"a".repeat(40)}`,
			`21.2.1.4-canary.1700000000.g${"a".repeat(40)}`,
			`21.2.1-canary.1700000000.g${"a".repeat(40)}.extra`,
		]) {
			expect(parseClientVersion(version)).toBeNull();
			expect(meetsClientVersionFloor("headless", version)).toBe(false);
		}
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

	test("canary strings remain invalid as operator floor values", () => {
		const floor = canaryVersion("21.2.1", "1700000000", "a".repeat(40));
		const lines: string[] = [];
		const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
		try {
			process.env.MIN_CLIENT_VERSION = `headless=${floor},macos=20.1.0`;
			expect(meetsClientVersionFloor("headless", "19.0.0")).toBe(true);
			expect(meetsClientVersionFloor("macos", "19.0.0")).toBe(false);
		} finally {
			spy.mockRestore();
		}
		expect(lines.join("\n")).toContain(`headless=${floor}`);
	});

	test("one malformed entry does not disarm the valid ones", () => {
		// The dangerous shape: the variable looks set for three platforms, but
		// `macos=19.2` is two parts and drops out. chrome-extension must still
		// enforce, and macos must be reported as enforcing nothing rather than
		// quietly appearing covered.
		process.env.MIN_CLIENT_VERSION =
			"chrome-extension=0.6.0,macos=19.2,headless=19.0.0";
		expect(meetsClientVersionFloor("chrome-extension", "0.5.9")).toBe(false);
		expect(meetsClientVersionFloor("headless", "18.0.0")).toBe(false);
		expect(meetsClientVersionFloor("macos", "0.0.1")).toBe(true);
	});

	test("the warn names the dropped entries in the rendered line", () => {
		// The entries have to reach the rendered line. An operator who is told
		// "some entry dropped" without being told WHICH is back at the silent
		// misconfiguration this warn exists to break.
		const lines: string[] = [];
		const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
		try {
			process.env.MIN_CLIENT_VERSION = "macos=19.2,headless=19.0.0";
			expect(meetsClientVersionFloor("macos", "0.0.1")).toBe(true);
		} finally {
			spy.mockRestore();
		}
		const rendered = lines.join("\n");
		expect(rendered).toContain("macos=19.2");
		expect(rendered).toContain("headless");
	});

	test("a changed value takes effect immediately despite the parse cache", () => {
		// envVersionMap() memoizes on the raw string because it runs on every device
		// poll. Keyed on anything coarser (a boolean "parsed once") a floor change
		// would never take effect until restart.
		process.env.MIN_CLIENT_VERSION = "macos=19.2.0";
		expect(meetsClientVersionFloor("macos", "19.0.0")).toBe(false);

		process.env.MIN_CLIENT_VERSION = "macos=18.0.0";
		expect(meetsClientVersionFloor("macos", "19.0.0")).toBe(true);

		delete process.env.MIN_CLIENT_VERSION;
		expect(meetsClientVersionFloor("macos", "0.0.1")).toBe(true);
	});

	test("messages name the client when known", () => {
		expect(clientFloorMessage("chrome-extension")).toContain("Chrome extension");
		expect(clientFloorMessage("macos")).toContain("Mac app");
		expect(clientFloorMessage("headless")).toContain("headless worker");
		expect(clientFloorMessage(null)).toContain("Lobu client");
		expect(clientFloorMessage("something-new")).toContain("Lobu client");
	});
});

describe("recommended client version", () => {
	let saved: string | undefined;
	let savedMinimum: string | undefined;
	beforeEach(() => {
		saved = process.env.RECOMMENDED_CLIENT_VERSION;
		savedMinimum = process.env.MIN_CLIENT_VERSION;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.RECOMMENDED_CLIENT_VERSION;
		else process.env.RECOMMENDED_CLIENT_VERSION = saved;
		if (savedMinimum === undefined) delete process.env.MIN_CLIENT_VERSION;
		else process.env.MIN_CLIENT_VERSION = savedMinimum;
	});

	test("unset means no nudge for any client", () => {
		delete process.env.RECOMMENDED_CLIENT_VERSION;
		expect(clientUpdateHint("headless", "1.0.0")).toBeNull();
		expect(clientUpdateHint("macos", null)).toBeNull();
	});

	test("names the running version and the per-platform update step", () => {
		process.env.RECOMMENDED_CLIENT_VERSION =
			"headless=24.0.0,macos=24.0.0,chrome-extension=0.9.0";
		expect(clientUpdateHint("headless", "19.2.0")).toBe(
			"device runs headless v19.2.0 (recommended v24.0.0 or newer); update @lobu/cli and restart `lobu daemon`",
		);
		expect(clientUpdateHint("macos", "23.1.0")).toContain("update the Lobu Mac app");
		expect(clientUpdateHint("chrome-extension", "0.8.9")).toContain(
			"update the Chrome extension",
		);
	});

	test("a client at or above the recommendation, or with no entry, is not nudged", () => {
		process.env.RECOMMENDED_CLIENT_VERSION = "headless=24.0.0";
		expect(clientUpdateHint("headless", "24.0.0")).toBeNull();
		expect(clientUpdateHint("headless", "24.2.1")).toBeNull();
		expect(clientUpdateHint("macos", "1.0.0")).toBeNull();
		expect(clientUpdateHint(null, "1.0.0")).toBeNull();
	});

	test("an unknown client version is not reported as a version it never sent", () => {
		process.env.RECOMMENDED_CLIENT_VERSION = "headless=24.0.0";
		expect(clientUpdateHint("headless", null)).toBeNull();
		expect(clientUpdateHint("headless", "garbage")).toBeNull();
	});

	test("the recommendation never gates polls", () => {
		delete process.env.MIN_CLIENT_VERSION;
		process.env.RECOMMENDED_CLIENT_VERSION = "headless=24.0.0";
		expect(meetsClientVersionFloor("headless", "19.2.0")).toBe(true);
	});

	test("malformed entries warn under the recommended variable's own name", () => {
		const lines: string[] = [];
		const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
		try {
			process.env.RECOMMENDED_CLIENT_VERSION = "headless=24.0,macos=24.0.0";
			expect(clientUpdateHint("headless", "1.0.0")).toBeNull();
		} finally {
			spy.mockRestore();
		}
		const rendered = lines.join("\n");
		expect(rendered).toContain("RECOMMENDED_CLIENT_VERSION");
		expect(rendered).toContain("headless=24.0");
	});
});
