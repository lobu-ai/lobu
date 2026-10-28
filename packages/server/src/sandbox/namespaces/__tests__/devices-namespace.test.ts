/**
 * `devices` SDK namespace — owner scoping and the no-principal case.
 *
 * The namespace exists so a script can discover the `id` that
 * `automations.device_worker_id` / `connections.device_worker_id` take. Two
 * things must hold and neither is obvious from the two-line implementation:
 *
 *  1. It delegates to `queryDeviceWorkers` — the SAME function behind
 *     `GET /api/me/devices` — rather than issuing its own query. A second query
 *     would drift from the route's shape silently.
 *  2. A context with no principal (system/service caller) gets an empty list,
 *     NOT every device. `device_workers` is user-owned, so there is no sensible
 *     "all devices" answer; returning none is the fail-closed direction.
 *
 * Uses vi.doMock + vi.resetModules + dynamic import (NOT hoisted vi.mock): the
 * integration suite shares a module registry across files, where a hoisted
 * vi.mock does not reliably replace the module — the namespace would then run
 * the REAL query. doMock scoped per test + a fresh import registry keeps the
 * mock hermetic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../../tools/registry";

const DEVICE = {
	id: "11111111-2222-3333-4444-555555555555",
	worker_id: "macos:my-laptop",
	agent_kinds: ["claude-code"],
};

/** Register the query mock, then dynamic-import the namespace against it. */
async function loadNamespaceWith(query: (userId: string) => Promise<unknown>) {
	vi.resetModules();
	vi.doMock("../../../worker-api/device-management", () => ({
		queryDeviceWorkers: query,
	}));
	const { buildDevicesNamespace } = await import("../devices");
	return buildDevicesNamespace;
}

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("../../../worker-api/device-management");
});

describe("devices namespace", () => {
	it("delegates to queryDeviceWorkers with the caller's own user id", async () => {
		const seen: string[] = [];
		const build = await loadNamespaceWith(async (userId) => {
			seen.push(userId);
			return [DEVICE];
		});

		const devices = await build({
			organizationId: "org_a",
			userId: "user_a",
		} as ToolContext).list();

		// The principal — never the org — is what scopes this read.
		expect(seen).toEqual(["user_a"]);
		expect(devices).toEqual([DEVICE]);
	});

	it("returns nothing when the context carries no principal", async () => {
		let called = false;
		const build = await loadNamespaceWith(async () => {
			called = true;
			return [DEVICE];
		});

		const devices = await build({
			organizationId: "org_a",
			userId: null,
		} as ToolContext).list();

		expect(devices).toEqual([]);
		// Fail closed: it must not fall through to an unscoped query.
		expect(called).toBe(false);
	});
});
