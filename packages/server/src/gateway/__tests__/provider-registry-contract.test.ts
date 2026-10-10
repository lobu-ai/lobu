/**
 * Contract test for the bundled provider registry (config/providers.json).
 *
 * Every config-driven provider (OpenAI, Groq, Gemini, Mistral, DeepSeek, …)
 * flows through the SAME generic ApiKeyProviderModule → secret-proxy path, so
 * a single bad edit to providers.json silently breaks a provider in prod with
 * nothing to catch it. This test is the guard: it loads the REAL bundled
 * config and, for every provider, asserts both
 *   (a) the config invariants the loader/UI rely on, and
 *   (b) that an ApiKeyProviderModule built from that config wires the
 *       secret-proxy base-URL mappings and credential env vars correctly.
 *
 * It runs with no API keys and no network — pure config + module wiring — so it
 * belongs in CI as a fast fail-fast gate, not in the live smoke suite.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSdkCompat, resolveSdkCompat } from "@lobu/core";
import { providerCompletionUrl } from "../../__tests__/live-providers/provider-protocol.js";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { resolveProviderRegistryFromRaw } from "../services/provider-registry-service.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
// packages/server/src/gateway/__tests__ -> repo root is five levels up.
const repoRoot = resolve(thisDir, "../../../../..");
const providersPath = resolve(repoRoot, "config/providers.json");

const raw = readFileSync(providersPath, "utf-8");
const resolved = resolveProviderRegistryFromRaw(raw);

if (!resolved) {
	throw new Error(
		`config/providers.json failed to parse via resolveProviderRegistryFromRaw (${providersPath})`,
	);
}

/** Flatten the nested registry the same way ProviderRegistryService does. */
const flattened = resolved.resolved.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

// A stub that satisfies the module's auth-profile dependency without a DB;
// none of the wiring assertions below touch credentials.
const stubAuthProfiles = {
	hasProviderProfiles: async () => false,
} as never;

function buildModule(
	id: string,
	provider: (typeof flattened)[number]["provider"],
) {
	return new ApiKeyProviderModule({
		providerId: id,
		providerDisplayName: provider.displayName,
		providerIconUrl: provider.iconUrl,
		envVarName: provider.envVarName,
		apiKeyInstructions: provider.apiKeyInstructions,
		apiKeyPlaceholder: provider.apiKeyPlaceholder,
		slug: id,
		upstreamBaseUrl: provider.upstreamBaseUrl,
		modelsEndpoint: provider.modelsEndpoint,
		sdkCompat: provider.sdkCompat,
		defaultModel: provider.defaultModel,
		catalogVisible: provider.catalogVisible,
		authProfilesManager: stubAuthProfiles,
	});
}

describe("provider registry contract (config/providers.json)", () => {
	test("registry parses and has providers", () => {
		expect(flattened.length).toBeGreaterThan(0);
	});

	test("Qwen excludes qwen-turbo while preserving the other choices and default", () => {
		const qwen = flattened.find(({ id }) => id === "qwen")?.provider;
		expect(qwen).toBeDefined();
		expect(qwen!.models).not.toContain("qwen-turbo");
		expect(qwen!.models).toEqual([
			"qwen3.8-max",
			"qwen3.8-max-preview",
			"qwen-max",
			"qwen-plus",
			"qwen2.5-coder-32b-instruct",
			"qwen2.5-72b-instruct",
		]);
		expect(qwen!.defaultModel).toBe("qwen-max");
	});

	test("official OpenAI agent turns use Responses for reasoning with tools", () => {
		const openai = flattened.find(({ id }) => id === "openai")!.provider;
		const module = buildModule("openai", openai);
		expect(resolveSdkCompat(module.sdkCompat)?.api).toBe("openai-responses");
		const mappings = module.getProxyBaseUrlMappings("https://proxy.example.test", "agent-test");
		expect(mappings.OPENAI_BASE_URL).toBe(mappings.OPENAI_API_BASE_URL);
	});

	test("deployment OpenAI URL overrides retain Chat Completions", () => {
		const prior = process.env.OPENAI_API_BASE_URL;
		try {
			process.env.OPENAI_API_BASE_URL = "https://deployment.example.test/v1";
			const openai = flattened.find(({ id }) => id === "openai")!.provider;
			const module = buildModule("openai", openai);
			expect(module.getUpstreamConfig()?.upstreamBaseUrl).toBe(process.env.OPENAI_API_BASE_URL);
			expect(resolveSdkCompat(module.sdkCompat)?.api).toBe("openai-completions");
		} finally {
			if (prior === undefined) delete process.env.OPENAI_API_BASE_URL;
			else process.env.OPENAI_API_BASE_URL = prior;
		}
	});

	test("OpenAI API exposes its supported transcription route", () => {
		const openai = flattened.find(({ id }) => id === "openai")?.provider;
		expect(openai).toBeDefined();
		expect(openai!.modalities).toContain("stt");
		expect(openai!.stt).toMatchObject({
			enabled: true,
			sdkCompat: "openai",
			transcriptionPath: "/audio/transcriptions",
			model: "gpt-4o-transcribe",
		});
	});

	test("provider ids are unique", () => {
		const ids = flattened.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	for (const { id, provider } of flattened) {
		describe(`provider: ${id}`, () => {
			test("has the required display/config fields", () => {
				expect(provider.displayName?.trim()).toBeTruthy();
				expect(provider.iconUrl?.trim()).toBeTruthy();
				expect(provider.apiKeyInstructions?.trim()).toBeTruthy();
				expect(provider.apiKeyPlaceholder?.trim()).toBeTruthy();
			});

			test("envVarName follows the *_API_KEY convention", () => {
				// The secret-proxy derives the base-URL env var by replacing
				// `_KEY` with `_BASE_URL`; a name that doesn't end in `_KEY`
				// would produce a broken base-URL env var.
				expect(provider.envVarName).toMatch(/_KEY$/);
				expect(provider.envVarName).toBe(provider.envVarName.toUpperCase());
			});

			test("upstreamBaseUrl is an https URL with no trailing slash", () => {
				expect(provider.upstreamBaseUrl).toMatch(/^https:\/\//);
				expect(provider.upstreamBaseUrl).not.toMatch(/\/$/);
				expect(() => new URL(provider.upstreamBaseUrl)).not.toThrow();
			});

			test("sdkCompat, when set, is a known protocol", () => {
				if (provider.sdkCompat !== undefined) {
					expect(isSdkCompat(provider.sdkCompat)).toBe(true);
				}
			});

			test("modelsEndpoint, when set, is a root-relative path", () => {
				if (provider.modelsEndpoint !== undefined) {
					expect(provider.modelsEndpoint).toMatch(/^\//);
				}
			});

			test("module exposes the API key as a secret env var", () => {
				const mod = buildModule(id, provider);
				expect(mod.getSecretEnvVarNames()).toContain(provider.envVarName);
				expect(mod.getCredentialEnvVarName()).toBe(provider.envVarName);
			});

			test("proxy base-URL mappings route through the agent-scoped proxy", () => {
				const mod = buildModule(id, provider);
				const proxyUrl = "http://proxy.internal:8118";
				const agentId = "agent-xyz";
				const mappings = mod.getProxyBaseUrlMappings(proxyUrl, agentId);

				// Provider-specific base-URL env var (e.g. GROQ_BASE_URL) is mapped.
				const baseUrlEnvVar = provider.envVarName.replace("_KEY", "_BASE_URL");
				expect(mappings[baseUrlEnvVar]).toBeDefined();
				expect(mappings[baseUrlEnvVar]).toContain(`${proxyUrl}/${id}`);

				// Only the literal `openai` provider may own OPENAI_BASE_URL — the
				// worker reads DEFAULT_PROVIDER_BASE_URL_ENV.openai === "OPENAI_BASE_URL"
				// for it. Every OTHER sdkCompat provider resolves through its own
				// <PROVIDER>_BASE_URL key (asserted above) and applies it as the model
				// baseUrl explicitly, so it must NOT also claim OPENAI_BASE_URL: sharing
				// that key let a co-installed provider clobber it on merge and mis-route
				// openai/<model> requests to the wrong slug.
				if (provider.sdkCompat === "openai") {
					if (id === "openai") {
						expect(mappings.OPENAI_BASE_URL).toBeDefined();
						expect(mappings.OPENAI_BASE_URL).toContain(`${proxyUrl}/${id}`);
					} else {
						expect(mappings.OPENAI_BASE_URL).toBeUndefined();
					}
				}
			});
		});
	}
});

/**
 * Composed-URL invariant. Production composes provider URLs with NO
 * version-segment magic (verified by the protocol-adapter E2E):
 *   - completion = the adapter-specific path appended to upstreamBaseUrl
 *                  (Anthropic Messages, OpenAI Responses, ChatGPT Codex
 *                  Responses, or OpenAI-compatible Chat Completions)
 *   - models = `${upstreamBaseUrl}${modelsEndpoint}`
 *               (ApiKeyProviderModule.fetchModelsGeneric, direct fetch)
 *
 * So a doubled version segment (`/v1/v1/`) in a composed URL is always a
 * dead route — this generic check caught 9 providers composing
 * `/v1/v1/models`. Whether each composed URL actually EXISTS upstream is
 * deliberately not pinned here: live-providers/provider-keyless.test.ts
 * probes the real APIs (keyless — a wrong path 404s, a right path 401s),
 * so reality is the oracle instead of a hand-maintained URL table.
 */
describe("composed upstream URLs", () => {
	const DOUBLED_VERSION = /\/v\d+\/v\d+\//;
	for (const { id, provider } of flattened) {
		test(`${id}: composed URLs have no doubled version segment`, () => {
			expect(providerCompletionUrl(id, provider)).not.toMatch(DOUBLED_VERSION);
			const base = provider.upstreamBaseUrl.replace(/\/$/, "");
			if (provider.modelsEndpoint) {
				expect(`${base}${provider.modelsEndpoint}`).not.toMatch(DOUBLED_VERSION);
			}
		});
	}
});
