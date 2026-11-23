/**
 * SDK manifest enumeration. Lives in its own module so `runScript` can value-
 * import it without pulling `client-sdk.ts`'s full auth/db chain into the test
 * runtime — the run-script-runtime.test.ts CI guard depends on this.
 */

import type { ToolAccessLevel } from "../auth/tool-access";
import { METHOD_METADATA } from "./method-metadata";
import { sdkMethodVisible } from "./sdk-method-access";

export type SDKMode = "read" | "full";

type SDKManifest = {
	topLevel: string[];
	byNamespace: Record<string, string[]>;
	/**
	 * Every namespace that exists in METHOD_METADATA, regardless of this mode's
	 * access filter. Lets the guest tell a KNOWN namespace hidden by the current
	 * mode (e.g. `agents` in a lower tier) from a genuinely unknown key, so it can
	 * throw a structured "not available in this mode" error instead of the opaque
	 * "Cannot read properties of undefined".
	 */
	allNamespaces: string[];
	/**
	 * Methods of a VISIBLE namespace that this mode or tier filters out, so the
	 * guest can name the right tool instead of the opaque "x is not a function".
	 */
	hiddenByNamespace: Record<string, string[]>;
	mode: SDKMode;
};

/** Every namespace present in METHOD_METADATA, mode-independent. */
function allKnownNamespaces(): string[] {
	const set = new Set<string>();
	for (const path of Object.keys(METHOD_METADATA)) {
		const dot = path.indexOf(".");
		if (dot !== -1) set.add(path.slice(0, dot));
	}
	return [...set];
}

const manifestCache = new Map<string, SDKManifest>();

function buildSDKManifest(
	mode: SDKMode,
	allowCrossOrg: boolean,
	callerMax: ToolAccessLevel,
): SDKManifest {
	const topLevel: string[] = [];
	if (sdkMethodVisible("read", callerMax, mode)) {
		if (allowCrossOrg) topLevel.push("org");
		topLevel.push("query", "log");
	}

	const byNamespace: Record<string, string[]> = {};
	const hiddenByNamespace: Record<string, string[]> = {};
	for (const [path, meta] of Object.entries(METHOD_METADATA)) {
		const dot = path.indexOf(".");
		if (dot === -1) continue;
		const ns = path.slice(0, dot);
		const target = sdkMethodVisible(meta.access, callerMax, mode)
			? byNamespace
			: hiddenByNamespace;
		(target[ns] ??= []).push(path.slice(dot + 1));
	}
	return {
		topLevel,
		byNamespace,
		allNamespaces: allKnownNamespaces(),
		hiddenByNamespace,
		mode,
	};
}

export function enumerateSDKManifest(
	mode: SDKMode,
	options?: { allowCrossOrg?: boolean; maxAccessLevel?: ToolAccessLevel },
): SDKManifest {
	const allowCrossOrg = options?.allowCrossOrg !== false;
	// Callers that omit maxAccessLevel (reaction scripts, tests) expect the
	// historical full manifest. MCP entry points pass the caller tier explicitly.
	const callerMax =
		options?.maxAccessLevel ??
		(mode === "read" ? "read" : "admin");
	const key = `${mode}:${allowCrossOrg ? "1" : "0"}:${callerMax}`;
	let manifest = manifestCache.get(key);
	if (!manifest) {
		manifest = buildSDKManifest(mode, allowCrossOrg, callerMax);
		manifestCache.set(key, manifest);
	}
	return manifest;
}