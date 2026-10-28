import { describe, expect, it } from "vitest";
import { computeFieldMerge } from "../entity-field-merge";

const NOW = "2026-06-25T12:00:00.000Z";

describe("computeFieldMerge", () => {
	it("human edit applies the change AND claims ownership", () => {
		const r = computeFieldMerge({
			metadata: { status: "todo" },
			controls: {},
			fields: { status: "done" },
			source: "human",
			actorId: "usr_1",
			note: "shipped it",
			nowIso: NOW,
		});
		expect(r.changed).toBe(true);
		expect(r.applied).toEqual({ status: { old: "todo", new: "done" } });
		expect(r.nextMetadata.status).toBe("done");
		expect(r.nextControls.status).toEqual({
			note: "shipped it",
			set_by: "usr_1",
			set_at: NOW,
		});
		expect(r.blocked).toEqual({});
	});

	it("an asserted human edit records the asserting client on each claimed marker", () => {
		const r = computeFieldMerge({
			metadata: { status: "todo", owner: "ada" },
			controls: {},
			fields: { status: "done" },
			source: "human",
			actorId: "usr_1",
			note: null,
			nowIso: NOW,
			affirm: ["owner"],
			assertedByClient: "pat_7",
		});
		const marker = { note: null, set_by: "usr_1", set_at: NOW, asserted_by_client: "pat_7" };
		expect(r.nextControls).toEqual({ status: marker, owner: marker });
	});

	it("human edit that does not change the value is a no-op", () => {
		const r = computeFieldMerge({
			metadata: { status: "done" },
			controls: {},
			fields: { status: "done" },
			source: "human",
			actorId: "usr_1",
			note: null,
			nowIso: NOW,
		});
		expect(r.changed).toBe(false);
		expect(r.applied).toEqual({});
		expect(r.nextControls).toEqual({}); // no ownership claimed for an unchanged field
	});

	it("automation writes a NON-owned field freely (no ownership mark)", () => {
		const r = computeFieldMerge({
			metadata: { score: 10 },
			controls: {},
			fields: { score: 42 },
			source: "automation",
			actorId: null,
			note: null,
			nowIso: NOW,
		});
		expect(r.applied).toEqual({ score: { old: 10, new: 42 } });
		expect(r.nextMetadata.score).toBe(42);
		expect(r.nextControls).toEqual({}); // automation writes never claim ownership
		expect(r.blocked).toEqual({});
	});

	it("automation is BLOCKED from overwriting a field that policy requires approval for", () => {
		const r = computeFieldMerge({
			metadata: { score: 10 },
			controls: {},
			fields: { score: 42 },
			source: "automation",
			actorId: null,
			note: null,
			nowIso: NOW,
			requireApproval: ["score"],
		});
		expect(r.changed).toBe(false);
		expect(r.applied).toEqual({});
		expect(r.nextMetadata.score).toBe(10);
		expect(r.blocked).toEqual({ score: { current: 10, proposed: 42 } });
	});

	it("automation is BLOCKED from overwriting a human-owned field", () => {
		const r = computeFieldMerge({
			metadata: { status: "done" },
			controls: { status: { note: "CI red", set_by: "usr_1", set_at: NOW } },
			fields: { status: "todo" }, // automation wants to revert it
			source: "automation",
			actorId: null,
			note: null,
			nowIso: NOW,
		});
		expect(r.changed).toBe(false);
		expect(r.applied).toEqual({});
		expect(r.nextMetadata.status).toBe("done"); // unchanged — human wins
		expect(r.blocked).toEqual({
			status: { current: "done", proposed: "todo" },
		});
	});

	it("automation proposing the SAME value as the owned field is not a conflict", () => {
		const r = computeFieldMerge({
			metadata: { status: "done" },
			controls: { status: { set_by: "usr_1", set_at: NOW } },
			fields: { status: "done" },
			source: "automation",
			actorId: null,
			note: null,
			nowIso: NOW,
		});
		expect(r.changed).toBe(false);
		expect(r.applied).toEqual({});
		expect(r.blocked).toEqual({});
	});

	it("mixed batch: automation applies un-owned, blocks owned, in one pass", () => {
		const r = computeFieldMerge({
			metadata: { status: "done", score: 10 },
			controls: { status: { set_by: "usr_1", set_at: NOW } },
			fields: { status: "todo", score: 99 },
			source: "automation",
			actorId: null,
			note: null,
			nowIso: NOW,
		});
		expect(r.applied).toEqual({ score: { old: 10, new: 99 } });
		expect(r.blocked).toEqual({
			status: { current: "done", proposed: "todo" },
		});
		expect(r.nextMetadata).toEqual({ status: "done", score: 99 });
	});

	it("deferred apply: stale proposal does NOT clobber a value the human moved since", () => {
		// Proposal was built when status was 'high'; the human has since moved it to 'medium'.
		const r = computeFieldMerge({
			metadata: { status: "medium" },
			controls: { status: { set_by: "usr_1", set_at: NOW } },
			fields: { status: "critical" },
			source: "human", // approver endorses
			actorId: "usr_approver",
			note: null,
			nowIso: NOW,
			expectedCurrent: { status: "high" },
		});
		expect(r.changed).toBe(false);
		expect(r.applied).toEqual({});
		expect(r.stale).toEqual({ status: { expected: "high", live: "medium" } });
		expect(r.nextMetadata.status).toBe("medium"); // human's newer value untouched
	});

	it("deferred apply: proposal applies when the snapshot still matches live", () => {
		const r = computeFieldMerge({
			metadata: { status: "high" },
			controls: { status: { set_by: "usr_1", set_at: NOW } },
			fields: { status: "critical" },
			source: "human",
			actorId: "usr_approver",
			note: null,
			nowIso: NOW,
			expectedCurrent: { status: "high" },
		});
		expect(r.changed).toBe(true);
		expect(r.applied).toEqual({ status: { old: "high", new: "critical" } });
		expect(r.stale).toEqual({});
		expect(r.nextMetadata.status).toBe("critical");
	});

	it("approve: affirming an unchanged value claims ownership (NOT a no-op)", () => {
		const r = computeFieldMerge({
			metadata: { severity: "high", title: "Outage" },
			controls: {},
			fields: {}, // no value change
			source: "human",
			actorId: "usr_1",
			note: "confirmed by on-call",
			nowIso: NOW,
			affirm: ["severity"],
		});
		expect(r.changed).toBe(true); // ownership changed even though metadata didn't
		expect(r.applied).toEqual({});
		expect(r.affirmed).toEqual(["severity"]);
		expect(r.nextMetadata).toEqual({ severity: "high", title: "Outage" }); // value untouched
		expect(r.nextControls.severity).toEqual({
			note: "confirmed by on-call",
			set_by: "usr_1",
			set_at: NOW,
		});
		expect(r.nextControls.title).toBeUndefined(); // only the affirmed field is claimed
	});

	it("approve: a field being SET is not double-counted as affirmed", () => {
		const r = computeFieldMerge({
			metadata: { severity: "low" },
			controls: {},
			fields: { severity: "high" }, // correction
			source: "human",
			actorId: "usr_1",
			note: null,
			nowIso: NOW,
			affirm: ["severity"], // also listed to affirm — the set already claims it
		});
		expect(r.applied).toEqual({ severity: { old: "low", new: "high" } });
		expect(r.affirmed).toEqual([]); // the set won; no separate affirm
		expect(r.nextControls.severity).toEqual({
			note: null,
			set_by: "usr_1",
			set_at: NOW,
		});
	});

	it("approve: affirming a field absent from metadata is ignored", () => {
		const r = computeFieldMerge({
			metadata: { severity: "high" },
			controls: {},
			fields: {},
			source: "human",
			actorId: "usr_1",
			note: null,
			nowIso: NOW,
			affirm: ["nonexistent"],
		});
		expect(r.changed).toBe(false);
		expect(r.affirmed).toEqual([]);
		expect(r.nextControls).toEqual({});
	});

	it("approve: an automation cannot affirm (only humans claim ownership)", () => {
		const r = computeFieldMerge({
			metadata: { severity: "high" },
			controls: {},
			fields: {},
			source: "automation",
			actorId: null,
			note: null,
			nowIso: NOW,
			affirm: ["severity"],
		});
		expect(r.changed).toBe(false);
		expect(r.affirmed).toEqual([]);
		expect(r.nextControls).toEqual({});
	});
});
