/**
 * Keyless provider validation — network-gated, but needs NO API keys.
 *
 * The oracle is each provider's own live API: a request carrying a placeholder
 * credential to the protocol-correct completion or models path is rejected
 * before inference, so a 404/405 catches an upstream route that disappeared.
 * The placeholder matters: Google answers a request with no credential at all
 * with 404, which would read as a missing route. Exact protocol
 * serialization is covered deterministically by the worker adapter E2E; this
 * network check only detects upstream drift. Model ids are never pinned here —
 * every model list comes live from the provider's own listing.
 *
 * Everything is derived from config/providers.json, mirroring production
 * composition: completion path comes from the production adapter protocol;
 * models =
 * `upstreamBaseUrl + modelsEndpoint` (fetchModelsGeneric).
 *
 * Runs as part of `make test-providers-live` (this directory) — so even a
 * zero-key invocation validates every endpoint. Excluded from the default CI
 * gates (needs network).
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SdkCompat } from "@lobu/core";
import { providerCompletionUrl } from "./provider-protocol.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../../..");

interface ProviderEntry {
	displayName: string;
	upstreamBaseUrl: string;
	modelsEndpoint?: string;
	sdkCompat?: SdkCompat;
}

const registry = JSON.parse(
	readFileSync(resolve(repoRoot, "config/providers.json"), "utf-8"),
) as { providers: Array<{ id: string; providers?: ProviderEntry[] }> };

const flattened = registry.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

const TIMEOUT_MS = 20_000;
setDefaultTimeout(60_000);

async function probe(
	url: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url, {
		...init,
		headers: {
			...init?.headers,
			authorization: "Bearer keyless-probe-placeholder",
		},
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	let body: unknown = await res.text();
	try {
		body = JSON.parse(body as string);
	} catch {
		/* non-JSON is fine for status-only checks */
	}
	return { status: res.status, body };
}

for (const { id, provider } of flattened) {
	const base = provider.upstreamBaseUrl.replace(/\/$/, "");
	const completionUrl = providerCompletionUrl(id, provider);

	describe(`keyless: ${id} (${provider.displayName})`, () => {
		test(
			"completion endpoint exists (route must not 404)",
			async () => {
				const { status } = await probe(completionUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				expect(
					[404, 405].includes(status),
					`${id} completion route ${completionUrl} answered ${status} — ` +
						"the composed URL does not exist upstream",
				).toBe(false);
			},
		);

		test.skipIf(!provider.modelsEndpoint)(
			"models endpoint exists (route must not 404)",
			async () => {
				const url = `${base}${provider.modelsEndpoint}`;
				const { status } = await probe(url);
				expect(
					[404, 405].includes(status),
					`${id} models route ${url} answered ${status} — ` +
						"the composed URL does not exist upstream",
				).toBe(false);
			},
		);
	});
}
