import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
	ClientSdkActionError,
	createActionCaller,
} from "../../../sandbox/namespaces/action-call";
import { getSdkPreflight } from "../../../sandbox/sdk-preflight";
import { ToolUserError } from "../../../utils/errors";
import { withValidatedArgs } from "../../../tools/validate-args";

const PassthroughSchema = Type.Object({}, { additionalProperties: true });

function createTestCaller(
	handler: (payload: never) => Promise<unknown>,
	namespace: string,
) {
	return createActionCaller(
		withValidatedArgs(`manage_${namespace}`, PassthroughSchema, handler),
		{} as never,
		{} as never,
		namespace,
	);
}

describe("createActionCaller", () => {
	it("forces the action discriminator, ignoring a caller-supplied `action` key", async () => {
		const calls: object[] = [];
		const handler = async (payload: object) => {
			calls.push(payload);
			return payload;
		};
		const { method } = createTestCaller(handler as never, "entities");

		// A read-only caller tries to smuggle `action: "delete"` into a "list" call.
		await method("list")({ action: "delete", entity_id: 42 });

		expect(calls).toHaveLength(1);
		expect((calls[0] as Record<string, unknown>).action).toBe("list");
		expect((calls[0] as Record<string, unknown>).entity_id).toBe(42);
	});

	it("passes through ordinary input", async () => {
		const calls: object[] = [];
		const handler = async (payload: object) => {
			calls.push(payload);
			return payload;
		};
		const { method } = createTestCaller(handler as never, "entities");
		await method("get")({ entity_id: 7 });
		expect(calls[0]).toEqual({ entity_id: 7, action: "get" });
	});

	it("rejects a named connections call when the handler returns an error result", async () => {
		const failure = {
			error: "Connector 'missing' not found. Install it first.",
			setup_url: "/connections",
		};
		const handler = async () => failure;
		const { manage, method } = createTestCaller(handler as never, "connections");

		const thrown = await method("connect")({
			connector_key: "missing",
		}).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ClientSdkActionError);
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown).toMatchObject({
			message: failure.error,
			httpStatus: 400,
			action: "connect",
			result: failure,
		});

		// `manage` is the deliberately raw escape hatch for callers that need to
		// inspect the handler's complete result shape.
		await expect(manage({ action: "connect" })).resolves.toEqual(failure);
	});

	it("rejects a named classifiers call when success is false", async () => {
		const handler = async () => ({
			success: false,
			action: "create",
			message: "Automation not found: 404",
			data: { automation_id: 404 },
		});
		const { method } = createTestCaller(handler as never, "classifiers");

		const thrown = await method("create")({
			automation_id: 404,
		}).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ClientSdkActionError);
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown).toMatchObject({
			message: "Automation not found: 404",
			httpStatus: 400,
			action: "create",
		});
	});

	it.each(["failed", "error"] as const)(
		"rejects a named call when status is %s",
		async (status) => {
			const failure = {
				status,
				error_message: `Operation ended with status ${status}`,
			};
			const handler = async () => failure;
			const { method } = createTestCaller(handler as never, "operations");

			await expect(method("execute")({})).rejects.toMatchObject({
				name: "ClientSdkActionError",
				action: "execute",
				message: failure.error_message,
				result: failure,
			});
		},
	);

	it("rejects a named call when status is timeout", async () => {
		const failure = {
			status: "timeout",
			error_message: "Device action run timed out",
		};
		const handler = async () => failure;
		const { method } = createTestCaller(handler as never, "operations");

		await expect(method("execute")({})).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "execute",
			message: failure.error_message,
			result: failure,
		});
	});

	it("rejects a named call when every aggregate item failed", async () => {
		const failure = {
			action: "delete",
			results: [
				{
					automation_id: "missing-automation",
					success: false,
					message: "Automation not found or already archived",
				},
			],
			summary: { total: 1, successful: 0, failed: 1 },
		};
		const handler = async () => failure;
		const { method } = createTestCaller(handler as never, "automations");

		await expect(method("delete")({})).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "delete",
			message: failure.results[0].message,
			result: failure,
		});
	});

	it("rewrites an internal manage_* validation error to the public SDK method", async () => {
		// A client.feeds.get({ id: 1 }) whose internal handler (manage_feeds)
		// rejects the args must NOT leak `manage_feeds` — the caller can only
		// recover against `client.feeds.get`.
		const handler = async () => {
			throw new ToolUserError(
				"Invalid arguments for manage_feeds: unknown argument(s): limit — valid arguments for action 'read_feed' are: action, feed_id, connection_id",
			);
		};
		const { method } = createTestCaller(handler as never, "feeds");
		const thrown = (await method("read_feed", { publicMethod: "get" })({
			id: 1,
		}).catch((e: unknown) => e)) as ToolUserError;
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown.message).not.toMatch(/manage_feeds/);
		expect(thrown.message).toMatch(/client\.feeds\.get/);
		expect(thrown.message).toMatch(/unknown argument\(s\): limit/);
		expect(thrown.message).not.toMatch(/\baction\b/);
		expect(thrown.message).not.toMatch(/connection_id/);
		expect(thrown.message).toContain("search_sdk 'feeds.get'");
	});

	it("derives a CAMEL-CASE public method from a snake_case action when none is supplied", async () => {
		// `list_links` (internal) → the real method is
		// client.entities.listLinks, NOT ...list_links.
		const handler = async () => {
			throw new ToolUserError(
				"Invalid arguments for manage_entity: /entity_type: Expected required property",
			);
		};
		const { method } = createTestCaller(handler as never, "entities");
		const thrown = (await method("list_links")({}).catch(
			(e: unknown) => e,
		)) as ToolUserError;
		expect(thrown.message).not.toMatch(/manage_entity/);
		expect(thrown.message).not.toMatch(/list_links/);
		expect(thrown.message).toMatch(/client\.entities\.listLinks/);
	});

	it("leaves non-validator errors from namespaced callers untouched", async () => {
		const message =
			"Connector rejected the request — valid arguments are: retry_after";
		const handler = async () => {
			throw new ToolUserError(message);
		};
		const { method } = createTestCaller(handler as never, "feeds");
		const thrown = (await method("trigger_feed", {
			publicMethod: "trigger",
		})({}).catch(
			(e: unknown) => e,
		)) as ToolUserError;
		expect(thrown.message).toBe(message);
	});

	it("returns a queued approval even when its mutation success is false", async () => {
		const queued = {
			success: false,
			approval_queued: true,
			approval_url: "/memory?run_ids=42",
			approval_run_id: 42,
		};
		const handler = async () => queued;
		const { method } = createTestCaller(handler as never, "entities");

		await expect(method("delete")({ entity_id: 7 })).resolves.toEqual(queued);
	});

	it.each([
		["connections", "test", "test", "admin"],
		["feeds", "trigger_feed", "trigger", "admin"],
		["operations", "execute", "execute", "write"],
	])("preflight reports the enforced tier for %s.%s without executing it", async (namespace, action, publicMethod, requiredAccess) => {
		let executed = false;
		const { method } = createTestCaller(async () => { executed = true; return {}; }, namespace);
		const call = method(action, { publicMethod });
		const preview = await getSdkPreflight(call)?.({});
		expect(preview?.required_access).toBe(requiredAccess);
		expect(preview?.authorization_status).toBe("not_evaluated");
		expect(executed).toBe(false);
	});

	it("preflights through the handler schema without entering the handler or inspecting its result", async () => {
		let executed = false;
		const handler = withValidatedArgs(
			"manage_connections",
			Type.Object({
				action: Type.Literal("update"),
				connection_id: Type.Number(),
				status: Type.Optional(Type.String()),
			}),
			async () => {
				executed = true;
				return { status: "error" };
			},
		);
		const { method } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
			"connections",
		);
		const update = method("update");
		const preflight = getSdkPreflight(update);

		expect(preflight).toBeDefined();
		expect(preflight?.({ connection_id: "9", status: "error" })).toEqual({
			args: [{ connection_id: 9, status: "error" }],
			required_access: "write",
			authorization_status: "not_evaluated",
		});
		expect(executed).toBe(false);

		await expect(update({ connection_id: "not-a-number" })).rejects.toThrow(
			/client\.connections\.update/,
		);
		expect(executed).toBe(false);
	});
});
