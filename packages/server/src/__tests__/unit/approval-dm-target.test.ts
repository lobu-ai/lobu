/**
 * Approval delivery precedence: conversation → requester DM → inbox.
 *
 * Notification delivery selects a resolved owner DM before channel targets,
 * so feeding the requester into that tier unconditionally
 * would send an approval asked for in a channel to the asker's DM instead —
 * inverting the order. This pins the seam where that inversion lives.
 */

import { describe, expect, it } from "bun:test";
import { resolveApprovalDmTarget } from "../../notifications/triggers";

describe("resolveApprovalDmTarget", () => {
	it("routes to the field owner even when a chat origin resolved", () => {
		expect(
			resolveApprovalDmTarget({
				ownerUserId: "user-owner",
				requesterUserId: "user-asker",
				connectionId: "conn-1",
				channelId: "slack:C0OPS",
			}),
		).toBe("user-owner");
	});

	it("routes to the field owner over the requester with no chat origin", () => {
		expect(
			resolveApprovalDmTarget({
				ownerUserId: "user-owner",
				requesterUserId: "user-asker",
			}),
		).toBe("user-owner");
	});

	it("does NOT DM the requester when the approval has a chat origin", () => {
		expect(
			resolveApprovalDmTarget({
				requesterUserId: "user-asker",
				connectionId: "conn-1",
				channelId: "slack:C0OPS",
			}),
		).toBeNull();
	});

	it("does NOT DM the requester when only a connection resolved", () => {
		expect(
			resolveApprovalDmTarget({
				requesterUserId: "user-asker",
				connectionId: "conn-1",
			}),
		).toBeNull();
	});

	it("DMs the requester when there is no chat origin (the MCP case)", () => {
		expect(
			resolveApprovalDmTarget({ requesterUserId: "user-asker" }),
		).toBe("user-asker");
	});

	it("returns null when there is no owner and no requester", () => {
		expect(resolveApprovalDmTarget({})).toBeNull();
	});
});
