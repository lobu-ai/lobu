/**
 * `incrementCounter` records nothing for a name that was never registered
 * (`metrics.get(name)` misses, it warns and returns), so an unregistered
 * sunset counter scrapes exactly like a quiet one. Quiet does not gate any
 * deletion here (every legacy path is reachable by construction, not by
 * client age — see the call sites), but it is still read as corroboration,
 * and corroboration from a series that silently does not exist is worse than
 * none. This module also carries counters that were registered and never
 * incremented, so pin both halves: the series exists, and a hit actually
 * renders.
 */
import { describe, expect, test } from "bun:test";
import {
	getMetricsText,
	incrementCounter,
} from "../../gateway/metrics/prometheus";

const SERIES = "lobu_legacy_compat_hits_total";

/** Every path the legacy-compat counter is incremented on today. */
const LEGACY_PATHS = [
	"hashless_manifest_claim",
	"legacy_token_fallback",
	"legacy_session_prefix",
] as const;

describe("legacy compat sunset counter", () => {
	test("is registered, so a hit is distinguishable from silence", () => {
		expect(getMetricsText()).toContain(`# TYPE ${SERIES} counter`);
	});

	test("renders one labelled series per legacy path", () => {
		// Read deltas rather than asserting a literal 1: bun runs every test
		// file in one process, so this module-global registry is shared with
		// whatever else imported it first.
		const before = getMetricsText();
		for (const path of LEGACY_PATHS) {
			incrementCounter(SERIES, { path });
		}

		const after = getMetricsText();
		for (const path of LEGACY_PATHS) {
			expect(readSeries(after, path)).toBe(readSeries(before, path) + 1);
		}
	});

	test("accumulates rather than overwriting, so a busy path stays visible", () => {
		const path = "hashless_manifest_claim";
		const before = readSeries(getMetricsText(), path);

		incrementCounter(SERIES, { path });
		incrementCounter(SERIES, { path });

		expect(readSeries(getMetricsText(), path)).toBe(before + 2);
	});
});

function readSeries(text: string, path: string): number {
	const match = text.match(
		new RegExp(`^${SERIES}\\{path="${path}"\\} (\\d+)$`, "m"),
	);
	return match ? Number(match[1]) : 0;
}
