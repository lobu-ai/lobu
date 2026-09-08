/**
 * The admitted attachment budgets must fit the isolate bridge with room left
 * for the session journal and system prompt.
 *
 * This exists because the two ends were set independently and disagreed: the
 * image total alone was ~13.3 MiB base64 against a 16 MiB bridge, leaving under
 * 3 MiB for everything else, and adding a file budget on top exceeded the bridge
 * outright. A comment cannot keep that arithmetic true across later edits to
 * either constant, so it is asserted.
 *
 * If this fails, do NOT simply raise the bridge to match. Decide which side
 * should move: admission is user-visible, the bridge is a local guard, and the
 * headroom is what a long conversation actually needs.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_TURN_FILE_BYTES,
	MAX_TURN_FILE_BYTES_TOTAL,
	MAX_TURN_IMAGE_BYTES,
	MAX_TURN_IMAGE_BYTES_TOTAL,
	turnEnvelopeBudget,
} from "../orchestration/agent-turn-attachments.js";

/**
 * The worker's own bridge cap for an agent turn
 * (`AGENT_TURN_BRIDGE_BYTES` in `connector-worker/src/daemon/agent-turn.ts`).
 * Restated because the server does not depend on the worker package; this test
 * is what keeps the two numbers from drifting apart silently.
 */
const WORKER_BRIDGE_BYTES = 32 * 1024 * 1024;

describe("turn envelope budget", () => {
	it("agrees with the bridge cap the worker actually configures", () => {
		expect(turnEnvelopeBudget().bridge).toBe(WORKER_BRIDGE_BYTES);
	});

	it("leaves real headroom for history and the system prompt", () => {
		const { attachmentsBase64, bridge, historyHeadroom } = turnEnvelopeBudget();
		expect(attachmentsBase64).toBeLessThan(bridge);
		// A measured ~31 MB compacted journal executes, but the ADMITTED envelope
		// carries the journal too, so the floor is a substantial fraction of the
		// bridge rather than a token margin.
		expect(historyHeadroom).toBeGreaterThanOrEqual(8 * 1024 * 1024);
	});

	it("never admits a single attachment larger than its own total", () => {
		expect(MAX_TURN_IMAGE_BYTES).toBeLessThanOrEqual(MAX_TURN_IMAGE_BYTES_TOTAL);
		expect(MAX_TURN_FILE_BYTES).toBeLessThanOrEqual(MAX_TURN_FILE_BYTES_TOTAL);
	});
});
