import {
	type PiAiApi,
	type SdkCompat,
	resolveSdkCompat,
} from "@lobu/core";

export type ProviderApi = PiAiApi | "openai-codex-responses";

export interface ProtocolProviderEntry {
	upstreamBaseUrl: string;
	sdkCompat?: SdkCompat;
}

/** Resolve the same wire adapter the worker uses for a bundled provider. */
export function resolveProviderApi(
	id: string,
	provider: ProtocolProviderEntry,
): ProviderApi | null {
	if (id === "chatgpt") return "openai-codex-responses";
	if (id === "openai") return "openai-responses";
	return resolveSdkCompat(provider.sdkCompat)?.api ?? null;
}

export function providerCompletionPath(api: ProviderApi): string {
	switch (api) {
		case "anthropic-messages":
			return "/v1/messages";
		case "openai-responses":
			return "/responses";
		case "openai-codex-responses":
			return "/codex/responses";
		case "openai-completions":
			return "/chat/completions";
	}
}

export function providerCompletionUrl(
	id: string,
	provider: ProtocolProviderEntry,
): string {
	const api = resolveProviderApi(id, provider);
	if (!api) throw new Error(`${id} does not declare a routable model protocol`);
	return `${provider.upstreamBaseUrl.replace(/\/$/, "")}${providerCompletionPath(api)}`;
}
