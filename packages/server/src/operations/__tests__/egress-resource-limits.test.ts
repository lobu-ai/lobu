import { afterEach, describe, expect, test, vi } from "vitest";
import { __connectorOperationsTestOnly } from "../connector-operations";
import { __httpOperationTestOnly } from "../execute-http-operation";

const originalFetch = globalThis.fetch;
const originalHttpTimeout = process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalHttpTimeout === undefined) {
		delete process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS;
	} else {
		process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS = originalHttpTimeout;
	}
});

function cancellableBody(chunks: Uint8Array[] = []): {
	body: ReadableStream<Uint8Array>;
	wasCancelled: () => boolean;
} {
	let cancelled = false;
	let index = 0;
	return {
		body: new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[index++];
				if (chunk) controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		}),
		wasCancelled: () => cancelled,
	};
}

describe("OpenAPI discovery resource limits", () => {
	test("rejects and cancels a declared oversized spec", async () => {
		const tracked = cancellableBody();
		globalThis.fetch = (async () =>
			new Response(tracked.body, {
				status: 200,
				headers: { "content-length": "17" },
			})) as typeof fetch;

		await expect(
			__connectorOperationsTestOnly.fetchOpenApiSpec(
				"https://declared-large-openapi.example/spec.json",
				{ maxBytes: 16, timeoutMs: 1_000 },
			),
		).rejects.toThrow(/OpenAPI spec too large/i);
		expect(tracked.wasCancelled()).toBe(true);
	});

	test("rejects and cancels a chunked oversized spec", async () => {
		const tracked = cancellableBody([
			new Uint8Array(10),
			new Uint8Array(10),
		]);
		globalThis.fetch = (async () =>
			new Response(tracked.body, { status: 200 })) as typeof fetch;

		await expect(
			__connectorOperationsTestOnly.fetchOpenApiSpec(
				"https://chunked-large-openapi.example/spec.json",
				{ maxBytes: 16, timeoutMs: 1_000 },
			),
		).rejects.toThrow(/OpenAPI spec too large/i);
		expect(tracked.wasCancelled()).toBe(true);
	});

	test("loads a provider-sized spec under the default cap", async () => {
		// GitHub's REST description is ~14 MB; the default cap must admit it.
		const padding = "x".repeat(15 * 1024 * 1024);
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ openapi: "3.0.0", paths: {}, "x-padding": padding }),
				{ status: 200 },
			)) as typeof fetch;

		const spec = await __connectorOperationsTestOnly.fetchOpenApiSpec(
			"https://provider-sized-openapi.example/spec.json",
		);
		expect(spec).toMatchObject({ openapi: "3.0.0", paths: {} });
	});

	test("aborts a spec request at its deadline", async () => {
		globalThis.fetch = ((_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return reject(new Error("missing abort signal"));
				const rejectAbort = () => reject(signal.reason);
				if (signal.aborted) rejectAbort();
				else signal.addEventListener("abort", rejectAbort, { once: true });
			})) as typeof fetch;

		await expect(
			__connectorOperationsTestOnly.fetchOpenApiSpec(
				"https://slow-openapi.example/spec.json",
				{ timeoutMs: 10 },
			),
		).rejects.toThrow(/timed out after 10ms/i);
	});
});

describe("HTTP operation response limits", () => {
	test("refuses HTTP before an action bearer token reaches fetch", async () => {
		const networkFetch = vi.fn(
			async () => new Response(null, { status: 204 })
		);
		globalThis.fetch = networkFetch as typeof fetch;

		await expect(
			__httpOperationTestOnly.fetchAuthenticatedHttpOperation(
				"http://actions.example.com/run",
				{ headers: { Authorization: "Bearer secret" } }
			)
		).rejects.toThrow(/require HTTPS/i);
		expect(networkFetch).not.toHaveBeenCalled();
	});

	test("rejects and cancels a declared oversized action response", async () => {
		const tracked = cancellableBody();
		const response = new Response(tracked.body, {
			status: 200,
			headers: {
				"content-length": String(
					__httpOperationTestOnly.MAX_HTTP_OPERATION_RESPONSE_BYTES + 1,
				),
			},
		});

		await expect(
			__httpOperationTestOnly.readHttpOperationResponse(response),
		).rejects.toThrow(/HTTP operation response too large/i);
		expect(tracked.wasCancelled()).toBe(true);
	});

	test("rejects and cancels a chunked oversized action response", async () => {
		const max = __httpOperationTestOnly.MAX_HTTP_OPERATION_RESPONSE_BYTES;
		const tracked = cancellableBody([
			new Uint8Array(max),
			new Uint8Array(1),
		]);

		await expect(
			__httpOperationTestOnly.readHttpOperationResponse(
				new Response(tracked.body, { status: 200 }),
			),
		).rejects.toThrow(/HTTP operation response too large/i);
		expect(tracked.wasCancelled()).toBe(true);
	});

	test("keeps the existing action-request abort deadline active", async () => {
		process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS = "10";
		const requestAbort = __httpOperationTestOnly.requestAbortSignal();
		try {
			await new Promise<void>((resolve) =>
				requestAbort.signal.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			expect(String(requestAbort.signal.reason)).toMatch(/timed out after 10ms/i);
		} finally {
			requestAbort.cleanup();
		}
	});
});
