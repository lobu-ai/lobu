import { beforeAll, describe, expect, it } from "vitest";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
import { runScript, safeErrorDetails } from "../../sandbox/run-script";
import { cleanupTestDatabase } from "../setup/test-db";
import { TestWorkspace } from "../setup/test-mcp-client";

describe("ClientSDK business failure boundary", () => {
	let workspace: TestWorkspace;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({
			name: "ClientSDK Business Failure Org",
		});
	});

	it("throws when connections.connect returns an error result", async () => {
		const promise = workspace.owner.connections.connect({
			connector_key: "missing-client-sdk-connector",
		});

		const error = await promise.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect(error).toMatchObject({
			name: "ClientSdkActionError",
			action: "connect",
			httpStatus: 400,
		});
	});

	it("preserves structured action details through the run_sdk sandbox boundary", async () => {
		const result = await runScript({
			source: `export default async (_ctx, client) => {
				return client.connections.connect({ connector_key: "missing-client-sdk-connector" });
			}`,
			sdk: workspace.owner,
			sdkMode: "full",
			maxAccessLevel: "admin",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatchObject({
			name: "ClientSdkActionError",
			message: expect.stringMatching(/connector.*not found/i),
			details: {
				error: expect.stringMatching(/connector.*not found/i),
			},
		});
		expect(result.error?.message).not.toContain('{"');
	});

	it.each([
		["feeds.delete", "client.feeds.delete({ id: 589 })", "feed_id"],
		[
			"connections.delete",
			"client.connections.delete({ id: 546 })",
			"connection_id",
		],
	])(
		"validates malformed skipped %s calls before previewing them",
		async (publicMethod, call, field) => {
			const result = await runScript({
				source: `export default async (_ctx, client) => ${call};`,
				sdk: workspace.owner,
				sdkMode: "full",
				dryRun: true,
				maxAccessLevel: "admin",
			});

			expect(result.success).toBe(false);
			expect(result.error?.message).toContain(publicMethod);
			expect(result.error?.message).toContain(field);
			expect(result.sideEffectPreview).toEqual([]);
			expect(result.skippedCalls).toBe(0);
		},
	);

	it("previews canonical args across access classes without executing handlers", async () => {
		const result = await runScript({
			source: `export default async (_ctx, client) => Promise.all([
				client.feeds.delete({ feed_id: 589 }),
				client.connections.delete(546),
				client.connections.update({ connection_id: 547, status: "error" }),
				client.operations.execute({ connection_id: 549, operation_key: "dry_run_probe" }),
			]);`,
			sdk: workspace.owner,
			sdkMode: "full",
			dryRun: true,
			maxAccessLevel: "admin",
		});

		expect(result.error).toBeUndefined();
		expect(result.success).toBe(true);
		expect(result.skippedCalls).toBe(4);
		expect(result.sideEffectPreview).toMatchObject([
			{
				path: "feeds.delete",
				args: [{ feed_id: 589 }],
				required_access: "admin",
				authorization_status: "not_evaluated",
			},
			{
				path: "connections.delete",
				args: [{ connection_id: 546 }],
				required_access: "admin",
				authorization_status: "not_evaluated",
			},
			{
				path: "connections.update",
				args: [{ connection_id: 547, status: "error" }],
				required_access: "write",
				authorization_status: "not_evaluated",
			},
			{
				path: "operations.execute",
				args: [{ connection_id: 549, operation_key: "dry_run_probe" }],
				required_access: "write",
				authorization_status: "not_evaluated",
			},
		]);
		expect(result.returnValue).toEqual([
			{ dry_run: true, skipped_call: "feeds.delete", access: "admin" },
			{ dry_run: true, skipped_call: "connections.delete", access: "admin" },
			{ dry_run: true, skipped_call: "connections.update", access: "write" },
			{ dry_run: true, skipped_call: "operations.execute", access: "external" },
		]);
	});

	it("keeps reads live during dry-run", async () => {
		const result = await runScript({
			source: `export default async (_ctx, client) => client.connections.list({ limit: 1 });`,
			sdk: workspace.owner,
			sdkMode: "full",
			dryRun: true,
			maxAccessLevel: "admin",
		});

		expect(result.success).toBe(true);
		expect(result.skippedCalls).toBe(0);
		expect(result.sideEffectPreview).toEqual([]);
		expect(result.sdkCallTrace).toMatchObject([
			{ path: "connections.list", skipped: false },
		]);
	});

	it("redacts secrets and bounds structured error details", () => {
		expect(
			safeErrorDetails({
				error: "Provider rejected the request",
				token: "must-not-cross-the-sandbox",
				nested: { authorization: "Bearer secret", retryable: true },
			})
		).toEqual({
			error: "Provider rejected the request",
			token: "[redacted]",
			nested: { authorization: "[redacted]", retryable: true },
		});
		expect(safeErrorDetails({ payload: "x".repeat(20_000) })).toMatchObject({
			truncated: true,
		});
	});

	it("does not throw on BigInt or circular structured error details", () => {
		const circular: Record<string, unknown> = {
			requestId: 42n,
			token: "circular-secret",
		};
		circular.self = circular;

		const details = safeErrorDetails(circular);
		expect(details).toEqual({
			requestId: "42",
			token: "[redacted]",
			self: "[circular]",
		});
		expect(
			Buffer.byteLength(JSON.stringify(details), "utf8")
		).toBeLessThanOrEqual(16_384);
	});

	it("throws when classifiers.create returns success false", async () => {
		const promise = workspace.owner.classifiers.create({
			slug: "missing-entity-classifier",
			name: "Missing Entity Classifier",
			attribute_key: "sentiment",
			entity_id: 999_999,
			attribute_values: {
				positive: {
					description: "positive sentiment",
					examples: ["great"],
				},
			},
		});

		await expect(promise).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "create",
			message: "Entity not found: 999999",
			httpStatus: 400,
		});
	});

	it("throws when automations.delete returns an all-failed aggregate", async () => {
		await expect(
			workspace.owner.automations.delete({ automation_ids: ["999999"] })
		).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "delete",
			message: "Automation not found or already archived",
			httpStatus: 400,
		});
	});
});
