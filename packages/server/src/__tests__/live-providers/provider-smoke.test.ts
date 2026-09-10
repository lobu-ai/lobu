/**
 * Live provider smoke test — opt-in, credential-gated upstream validation.
 *
 * Unlike the deterministic protocol E2E, this suite answers the time-sensitive
 * question: does the configured upstream, credential, and default model work
 * today? It uses pi-ai's production adapters and consumes their real streaming
 * responses, so Anthropic Messages, OpenAI Responses, ChatGPT Codex Responses,
 * and OpenAI-compatible Chat Completions are serialized and parsed exactly as
 * worker turns are.
 *
 * REQUIRED_LIVE_PROVIDERS is a comma-separated readiness tier. Every listed
 * provider must have a dedicated credential, answer a text turn, and return a
 * forced tool call. Other configured credentials receive text coverage and a
 * best-effort tool probe without becoming release blockers.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiAiApi, SdkCompat } from "@lobu/core";
import {
	completeSimple,
	type Context,
	type Model,
} from "@mariozechner/pi-ai";
import { resolveProviderApi } from "./provider-protocol.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../../..");

interface ProviderEntry {
	displayName: string;
	envVarName: string;
	upstreamBaseUrl: string;
	sdkCompat?: SdkCompat;
	defaultModel?: string;
	modelsEndpoint?: string;
}

interface Credential {
	value: string;
	kind: "api-key" | "oauth";
}

const registry = JSON.parse(
	readFileSync(resolve(repoRoot, "config/providers.json"), "utf-8"),
) as { providers: Array<{ id: string; providers?: ProviderEntry[] }> };

const flattened = registry.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

const requiredIds = new Set(
	(process.env.REQUIRED_LIVE_PROVIDERS || "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean),
);

const FALLBACK_MODELS: Record<string, string> = {
	chatgpt: "gpt-5.1-codex-max",
};

const TIMEOUT_MS = 60_000;
setDefaultTimeout(120_000);

function firstEnv(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value) return value;
	}
	return undefined;
}

/** Never let ChatGPT subscription silently reuse an OpenAI platform API key. */
function resolveCredential(
	id: string,
	envVarName: string,
): Credential | undefined {
	if (id === "claude") {
		const oauth = firstEnv([
			"ANTHROPIC_AUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"ANTHROPIC_OAUTH_TOKEN",
		]);
		if (oauth) return { value: oauth, kind: "oauth" };
		const apiKey = process.env.ANTHROPIC_API_KEY;
		return apiKey ? { value: apiKey, kind: "api-key" } : undefined;
	}
	if (id === "chatgpt") {
		const oauth = firstEnv([
			"CHATGPT_OAUTH_TOKEN",
			"OPENAI_CODEX_OAUTH_TOKEN",
		]);
		return oauth ? { value: oauth, kind: "oauth" } : undefined;
	}
	const direct = process.env[envVarName];
	return direct ? { value: direct, kind: "api-key" } : undefined;
}

async function fetchJson(
	url: string,
	init: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Keep raw text for the assertion message.
	}
	return { status: response.status, body };
}

async function listModels(
	id: string,
	provider: ProviderEntry,
	credential: Credential,
): Promise<string[]> {
	if (id === "gemini") {
		const url = new URL(
			"https://generativelanguage.googleapis.com/v1beta/models",
		);
		url.searchParams.set("key", credential.value);
		const { status, body } = await fetchJson(url.toString(), { method: "GET" });
		expect(
			status,
			`gemini /models returned ${status}: ${JSON.stringify(body)}`,
		).toBe(200);
		return ((body as { models?: Array<{ name?: string }> }).models ?? [])
			.map((model) => model.name?.replace(/^models\//, "").trim())
			.filter((id): id is string => !!id);
	}

	if (id === "claude") {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (credential.kind === "oauth") {
			headers.Authorization = `Bearer ${credential.value}`;
		} else {
			headers["x-api-key"] = credential.value;
		}
		const { status, body } = await fetchJson(
			`${provider.upstreamBaseUrl.replace(/\/$/, "")}/v1/models`,
			{ method: "GET", headers },
		);
		expect(
			status,
			`claude /v1/models returned ${status}: ${JSON.stringify(body)}`,
		).toBe(200);
		return ((body as { data?: Array<{ id?: string }> }).data ?? [])
			.map((model) => model.id?.trim())
			.filter((id): id is string => !!id);
	}

	if (!provider.modelsEndpoint) return [];
	const url = `${provider.upstreamBaseUrl.replace(/\/$/, "")}${provider.modelsEndpoint}`;
	const { status, body } = await fetchJson(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${credential.value}` },
	});
	expect(
		status,
		`${id} models endpoint returned ${status}: ${JSON.stringify(body)}`,
	).toBe(200);
	return ((body as { data?: Array<{ id?: string }> }).data ?? [])
		.map((model) => model.id?.trim())
		.filter((modelId): modelId is string => !!modelId);
}

function buildLiveModel(
	id: string,
	provider: ProviderEntry,
	modelId: string,
): Model<any> {
	const api = resolveProviderApi(id, provider);
	if (!api) throw new Error(`${id} has no production model adapter`);
	const registryProvider =
		api === "anthropic-messages"
			? "anthropic"
			: api === "openai-codex-responses"
				? "openai-codex"
				: "openai";
	return {
		id: modelId,
		name: modelId,
		api,
		provider: registryProvider,
		baseUrl: provider.upstreamBaseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		// Gemini's OpenAI-compatible endpoint returns 400 for OpenAI's `store`
		// field. No completions entry in the catalog is api.openai.com either —
		// official OpenAI is promoted to Responses above — so every provider
		// this smoke reaches over completions is one production also withholds
		// `store` from; see `resolveTurnCompat` in `agent-turn-producer.ts`.
		...(api === "openai-completions"
			? { compat: { supportsStore: false } }
			: {}),
	} as Model<any>;
}

function textContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "Reply with exactly the single word: pong",
				timestamp: Date.now(),
			},
		],
	};
}

function toolContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "Use get_weather for Paris.",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "get_weather",
				description: "Get the current weather for a city",
				parameters: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
					additionalProperties: false,
				} as never,
			},
		],
	};
}

function forceWeatherTool(api: PiAiApi, payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const body = payload as Record<string, unknown>;
	if (api === "anthropic-messages") {
		return { ...body, tool_choice: { type: "tool", name: "get_weather" } };
	}
	if (api === "openai-completions") {
		return {
			...body,
			tool_choice: {
				type: "function",
				function: { name: "get_weather" },
			},
		};
	}
	return { ...body, tool_choice: { type: "function", name: "get_weather" } };
}

async function completeWithProductionAdapter(args: {
	id: string;
	provider: ProviderEntry;
	credential: Credential;
	modelId: string;
	context: Context;
	forceTool?: boolean;
}) {
	const api = resolveProviderApi(args.id, args.provider);
	if (!api) throw new Error(`${args.id} has no production model adapter`);
	return completeSimple(
		buildLiveModel(args.id, args.provider, args.modelId),
		args.context,
		{
			apiKey: args.credential.value,
			cacheRetention: "none",
			maxRetries: 0,
			maxTokens: 1_024,
			timeoutMs: TIMEOUT_MS,
			...(api === "openai-codex-responses"
				? { transport: "sse" as const }
				: {}),
			...(args.forceTool
				? { onPayload: (payload: unknown) => forceWeatherTool(api, payload) }
				: {}),
		},
	);
}

describe("required live-provider credentials", () => {
	for (const id of requiredIds) {
		test(`${id} has a dedicated credential`, () => {
			const row = flattened.find((entry) => entry.id === id);
			expect(row, `${id} is not present in config/providers.json`).toBeDefined();
			expect(
				row && resolveCredential(id, row.provider.envVarName),
				`${id} is required but its live credential is missing`,
			).toBeDefined();
		});
	}
});

const activeIds = flattened
	.filter(({ id, provider }) => resolveCredential(id, provider.envVarName))
	.map(({ id }) => id);
if (activeIds.length === 0) {
	console.warn(
		"[live-providers] no provider credentials in env — keyed provider turns skipped",
	);
} else {
	console.info(`[live-providers] exercising: ${activeIds.join(", ")}`);
}

for (const { id, provider } of flattened) {
	const credential = resolveCredential(id, provider.envVarName);
	const required = requiredIds.has(id);
	const modelId = provider.defaultModel ?? FALLBACK_MODELS[id];
	const canListModels = id === "claude" || id === "gemini" || !!provider.modelsEndpoint;

	describe.skipIf(!credential)(`live: ${id} (${provider.displayName})`, () => {
		test.skipIf(!canListModels)("lists models with production auth", async () => {
			const models = await listModels(id, provider, credential!);
			expect(models.length, `${id} returned an empty model list`).toBeGreaterThan(
				0,
			);
		});

		test("answers a streamed production-adapter turn", async () => {
			expect(modelId, `${id} has no configured live model`).toBeDefined();
			const response = await completeWithProductionAdapter({
				id,
				provider,
				credential: credential!,
				modelId: modelId!,
				context: textContext(),
			});
			expect(
				response.stopReason,
				`${id} turn failed: ${response.errorMessage ?? "unknown provider error"}`,
			).not.toBe("error");
			expect(
				response.content.some(
					(block) => block.type === "text" && block.text.trim().length > 0,
				),
				`${id} returned no assistant text`,
			).toBe(true);
		});

		test("returns a parsed streamed tool call", async () => {
			expect(modelId, `${id} has no configured live model`).toBeDefined();
			const response = await completeWithProductionAdapter({
				id,
				provider,
				credential: credential!,
				modelId: modelId!,
				context: toolContext(),
				forceTool: required,
			});
			const toolCall = response.content.find(
				(block) => block.type === "toolCall",
			);
			if (required) {
				expect(
					response.stopReason,
					`${id} required tool turn failed: ${response.errorMessage ?? "unknown provider error"}`,
				).toBe("toolUse");
				expect(toolCall, `${id} returned no parsed tool call`).toMatchObject({
					type: "toolCall",
					name: "get_weather",
				});
			} else if (!toolCall) {
				console.warn(
					`[live-providers] ${id} (${modelId}) returned no tool call: ${response.errorMessage ?? response.stopReason}`,
				);
			}
		});
	});
}
