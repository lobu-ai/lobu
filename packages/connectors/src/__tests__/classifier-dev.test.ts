import {
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);
let ClassifierDevConnector: typeof import("../classifier_dev").default;
beforeAll(async () => {
	ClassifierDevConnector = (await import("../classifier_dev")).default;
});
afterEach(() => mock.restore());

const input = {
	inputs: ["Does anyone know a good CRM?", "We shipped our new release"],
	labels: ["request", "announcement"],
	instructions: "A request asks for help; an announcement reports a release.",
};
const response = () => ({
	tier: "fast",
	model: "test-model-v1",
	modelsUsed: ["test-model-v1"],
	results: [
		{
			label: "request",
			confidence: 0.8,
			scores: { request: 0.9, announcement: 0.1 },
			model: "test-model-v1",
		},
		{
			label: "announcement",
			confidence: 0.95,
			scores: { request: 0.01, announcement: 0.99 },
			model: "test-model-v1",
		},
	],
	usage: { classifications: 2, escalated: 0, ms: 12 },
});
function execute(value: Record<string, unknown> = input) {
	return new ClassifierDevConnector().execute({
		actionKey: "classify",
		input: value,
		credentials: null,
		config: {},
	});
}

describe("classifier.dev action", () => {
	test("is discoverable without credentials, feeds, or approval", () => {
		const definition = new ClassifierDevConnector().definition;
		expect(definition.key).toBe("classifier.dev");
		expect(definition.authSchema).toEqual({ methods: [{ type: "none" }] });
		expect(definition.feeds).toBeUndefined();
		expect(definition.actions?.classify).toMatchObject({
			kind: "read",
			requiresApproval: false,
		});
	});

	test("posts ordered texts and the rubric to the public API and preserves provider scores", async () => {
		const body = response();
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(body),
		);
		expect(await execute()).toEqual({
			success: true,
			output: { provider: "classifier.dev", ...body },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://classifier.dev/v1/classify");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({ ...input, tier: "fast" });
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
	});

	test.each([
		{ inputs: [] },
		{ inputs: [""] },
		{ inputs: [" "] },
		{ inputs: Array(101).fill("post") },
		{ inputs: ["x".repeat(32_001)] },
		{ inputs: [123] },
		{ labels: ["request"] },
		{ labels: ["request", "request"] },
		{ labels: ["request", " "] },
		{ labels: ["request", "x".repeat(201)] },
		{ labels: Array.from({ length: 101 }, (_, i) => String(i)) },
		{ instructions: 42 },
		{ instructions: "x".repeat(4001) },
		{ tier: "smart" },
	])("rejects invalid or unsupported input before HTTP (case %#)", async (override) => {
		const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("must not fetch"),
		);
		expect((await execute({ ...input, ...override })).success).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each([
		400, 429, 502, 503,
	])("propagates HTTP %i as a typed failure, never an empty success", async (status) => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ error: "unavailable" }, { status }),
		);
		await expect(execute()).rejects.toMatchObject({ status });
	});

	test("preserves explicitly unscored fallback results without inventing confidence", async () => {
		const body = response();
		const result = {
			label: "request",
			confidence: null,
			scores: null,
			model: "fallback-model",
			unscored: "provider_unavailable",
		};
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ ...body, results: [result, body.results[1]] }),
		);
		expect((await execute()).output?.results).toEqual([
			result,
			body.results[1],
		]);
	});

	test.each([
		{ results: [] },
		{ results: [response().results[0]] },
		{
			results: [
				{ ...response().results[0], label: "invented" },
				response().results[1],
			],
		},
		{
			results: [
				{ ...response().results[0], confidence: 1.1 },
				response().results[1],
			],
		},
		{
			results: [
				{ ...response().results[0], scores: { request: -1 } },
				response().results[1],
			],
		},
		{
			results: [
				{ ...response().results[0], confidence: null },
				response().results[1],
			],
		},
		{ model: "" },
	])("rejects malformed provider output: %j", async (override) => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ ...response(), ...override }),
		);
		expect((await execute()).success).toBe(false);
	});
});
