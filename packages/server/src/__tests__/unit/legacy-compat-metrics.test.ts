/**
 * `incrementCounter` is a silent no-op for a name that was never registered
 * (`metrics.get(name)` misses and it returns), so an unregistered sunset
 * counter reads exactly like a quiet one — and "quiet" is what the deletion
 * gate acts on. This module also shipped once registered-but-never-incremented,
 * so pin both halves: the series exists, and a hit actually renders.
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
		for (const path of LEGACY_PATHS) {
			incrementCounter(SERIES, { path });
		}

		const text = getMetricsText();
		for (const path of LEGACY_PATHS) {
			expect(text).toContain(`${SERIES}{path="${path}"} 1`);
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
