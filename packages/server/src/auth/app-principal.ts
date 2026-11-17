import { BlockList, isIP } from "node:net";
import { getDomain } from "tldts";

const LOCAL_ADDRESSES = new BlockList();
LOCAL_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOCAL_ADDRESSES.addAddress("0.0.0.0", "ipv4");
LOCAL_ADDRESSES.addAddress("::1", "ipv6");
LOCAL_ADDRESSES.addAddress("::", "ipv6");

function hostedRedirectHost(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	let host = url.hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
	const family = isIP(host);
	if (family !== 0 && LOCAL_ADDRESSES.check(host, family === 4 ? "ipv4" : "ipv6")) return null;
	return host;
}

/** An https redirect on a non-local host: the bearer lives on that host's servers. */
export function isHostedRedirectUri(raw: string): boolean {
	return hostedRedirectHost(raw) !== null;
}

/** An app key fits a policy principal id (255 characters). */
const MAX_LOCAL_NAME = 255 - "local:".length;

/**
 * The one derivation of a connected app's policy key, computed where the token
 * is verified and never read off a request field. A hosted web client is named
 * by the registrable domain its redirects share (private suffixes such as
 * vercel.app count, so tenants on one host stay apart); one whose redirects span
 * domains is named by its client id. A client that holds its bearer locally
 * (device flow, loopback, or a legacy row without a grant type) is named by the
 * client name it registered: self-asserted, which is safe only because app
 * rules can never loosen what the user may do. A PAT is its own app.
 */
export function deriveAppPrincipalId(
	token:
		| { kind: "pat"; patId: number | string }
		| {
				kind: "oauth";
				clientId: string;
				clientName: string | null | undefined;
				authorizationGrantType: "authorization_code" | "device_code" | null | undefined;
				redirectUris: readonly string[] | null | undefined;
		  },
): string {
	if (token.kind === "pat") return `pat:${token.patId}`;
	const hosts = token.authorizationGrantType === "authorization_code"
		? (token.redirectUris ?? []).map(hostedRedirectHost)
		: [];
	if (hosts.length > 0 && hosts.every((host) => host !== null)) {
		const domains = new Set(hosts.map((host) => getDomain(host as string, { allowPrivateDomains: true }) ?? host));
		return domains.size === 1 ? `web:${[...domains][0]}` : `client:${token.clientId}`;
	}
	const name = token.clientName?.trim();
	return name && name.length <= MAX_LOCAL_NAME ? `local:${name}` : `client:${token.clientId}`;
}
