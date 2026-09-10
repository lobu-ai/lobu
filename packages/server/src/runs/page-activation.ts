import { ToolUserError } from "../utils/errors";

export const DEFAULT_PAGE_ACTIVATION_SECONDS = 86_400;

export function normalizePageActivationUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ToolUserError(`Invalid page activation URL '${value}'.`, 422);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ToolUserError("Page activation URLs must use HTTP or HTTPS.", 422);
	}
	// Preserve query order, repeated values, fragments and trailing slashes: each
	// can identify a different resource. URL handles host case and default ports.
	return url.toString();
}

export function normalizePageActivationUrls(values: string[]): string[] {
	const urls = [...new Set(values.map(normalizePageActivationUrl))];
	if (urls.length === 0 || urls.length > 8) {
		throw new ToolUserError("Page activation requires between 1 and 8 unique URLs.", 422);
	}
	return urls;
}

// Chrome extension 0.6.1 is the first release that verifies the trusted exact
// target URL itself before acting on an activated tab.
export function supportsExactPageActivation(version: string | null | undefined): boolean {
	if (!version || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
	const [major, minor, patch] = version.split(".").map(Number);
	return major > 0 || minor > 6 || (minor === 6 && patch >= 1);
}
