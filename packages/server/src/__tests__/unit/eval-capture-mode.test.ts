/**
 * Capture mode is a security boundary: an eval replay must not be able to talk
 * its way back into performing side effects. These tests pin the two hops
 * where that could go wrong — minting the signed claim, and honouring it.
 */

import { describe, expect, test } from "bun:test";
import { buildWorkerTokenClaims } from "../../gateway/orchestration/worker-token-claims";
import {
	CAPTURE_DISPATCH_PATHS,
	resolveSandboxDryRun,
} from "../../tools/sdk_run";
import { isSkippedUnderDryRun } from "../../sandbox/run-script";

const base = {
	channelId: "api_automation_7",
	agentId: "agent_1",
	organizationId: "org_1",
	platform: "api",
};

describe("buildWorkerTokenClaims — executionMode", () => {
	test("carries capture through to the signed claim", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { executionMode: "capture" },
		});
		expect(claims.executionMode).toBe("capture");
	});

	test("a live Automation run carries no claim", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { source: "automation-run" },
		});
		expect(claims.executionMode).toBeUndefined();
	});

	// The claim is minted from platformMetadata, which is assembled server-side
	// — but only the exact literal may ever be honoured, so a value that reached
	// the bag by any other route cannot mint a mode we would act on.
	test.each([
		["live", "live"],
		["uppercase", "CAPTURE"],
		["padded", " capture"],
		["truthy object", { toString: () => "capture" }],
		["number", 1],
		["boolean", true],
		["null", null],
	])("%s does not mint a capture claim", (_label, value) => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { executionMode: value },
		});
		expect(claims.executionMode).toBeUndefined();
	});

	test("an absent bag is not a capture run", () => {
		expect(
			buildWorkerTokenClaims({ ...base, platformMetadata: {} }).executionMode,
		).toBeUndefined();
	});
});

describe("buildWorkerTokenClaims — chat dry-run", () => {
	// `lobu chat --dry-run`: the CLI sets dryRun on its own session, the gateway
	// stamps it onto the enqueue's platformMetadata, and it must mint the same
	// capture claim an eval run gets — otherwise the flag is carried all the
	// way to the queue and silently dropped, and the turn writes for real.
	test("a dry-run chat session mints the capture claim", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { dryRun: true },
		});
		expect(claims.executionMode).toBe("capture");
	});

	test.each([
		["false", false],
		["string", "true"],
		["null", null],
	])("%s dryRun stays live", (_label, value) => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { dryRun: value },
		});
		expect(claims.executionMode).toBeUndefined();
	});

	test("an absent dryRun stays live", () => {
		expect(
			buildWorkerTokenClaims({ ...base, platformMetadata: {} }).executionMode,
		).toBeUndefined();
	});
});

describe("buildWorkerTokenClaims — automationRunId", () => {
	// The claim addresses the row the internal-route guard writes its capture
	// record onto. It rides the token so the guard never has to re-derive a run
	// id from the conversationId string.
	test("a capture run carries the run id off its verified intent", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: {
				executionMode: "capture",
				intent: { kind: "automation_run", runId: 874626, automationId: 5 },
			},
		});
		expect(claims.automationRunId).toBe(874626);
	});

	// Live tokens stay byte-identical to what they were before this claim
	// existed — nothing reads it on a live run, and an unchanged live token
	// keeps this off the rollout risk surface.
	test("a live run carries no run id, even with the same intent", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: {
				intent: { kind: "automation_run", runId: 874626, automationId: 5 },
			},
		});
		expect(claims.automationRunId).toBeUndefined();
	});

	test.each([
		["absent intent", undefined],
		["no runId", { kind: "automation_run", automationId: 5 }],
		["string runId", { runId: "874626" }],
		["zero", { runId: 0 }],
		["negative", { runId: -1 }],
		["fractional", { runId: 1.5 }],
		["not an object", "automation_run"],
		["null", null],
	])("%s yields no run id", (_label, intent) => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { executionMode: "capture", intent },
		});
		expect(claims.automationRunId).toBeUndefined();
	});
});

describe("resolveSandboxDryRun — capture forcing", () => {
	test("a capture run captures even when the agent asks for a live run", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: "capture",
				sdkMode: "full",
				agentDryRun: false,
			}),
		).toBe(true);
	});

	test("capture holds on the read-mode surface too", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: "capture",
				sdkMode: "read",
				agentDryRun: false,
			}),
		).toBe(true);
	});

	test("a live run still executes for real", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: "live",
				sdkMode: "full",
				agentDryRun: false,
			}),
		).toBe(false);
		expect(
			resolveSandboxDryRun({
				executionMode: null,
				sdkMode: "full",
				agentDryRun: false,
			}),
		).toBe(false);
	});

	test("the agent's own dry_run opt-in still works on a live run", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: null,
				sdkMode: "full",
				agentDryRun: true,
			}),
		).toBe(true);
	});
});

describe("the finalize call survives the capture skip", () => {
	// The blocker this pins: the dispatch prompt tells an eval to finalize via
	// `client.automations.completeWindow`, which is access 'write'. The sandbox's
	// blanket dry-run skip would swallow exactly that call, so the run ends with
	// no window, gets nudged into a SECOND full replay, and is then failed with
	// "finished without calling run_sdk" — about a call it did make.
	const capture = (path: string, access = "write") =>
		isSkippedUnderDryRun({
			dryRun: true,
			dryRunDispatchPaths: CAPTURE_DISPATCH_PATHS,
			access,
			path,
		});

	test("completeWindow is dispatched, not skipped, under capture", () => {
		expect(capture("automations.completeWindow")).toBe(false);
	});

	test("every other write still captures", () => {
		expect(capture("conversations.send")).toBe(true);
		expect(capture("entities.create")).toBe(true);
		expect(capture("feeds.sync", "external")).toBe(true);
	});

	test("an agent-requested dry_run skips completeWindow too", () => {
		// sdk_run passes the carve-out ONLY for executionMode 'capture'. With no
		// dispatch paths the agent's own preview keeps skipping everything, which
		// is what `dry_run: true` means.
		expect(
			isSkippedUnderDryRun({
				dryRun: true,
				dryRunDispatchPaths: undefined,
				access: "write",
				path: "automations.completeWindow",
			}),
		).toBe(true);
	});

	test("a live run dispatches everything", () => {
		expect(
			isSkippedUnderDryRun({
				dryRun: false,
				access: "write",
				path: "conversations.send",
			}),
		).toBe(false);
	});

	test("the carve-out stays minimal", () => {
		// A growing allowlist means capture is leaking. Each addition needs its
		// handler to enforce capture itself.
		expect(CAPTURE_DISPATCH_PATHS.length).toBe(1);
	});
});
