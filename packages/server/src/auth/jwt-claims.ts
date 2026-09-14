/**
 * Reading claims out of a provider-issued JWT we already hold.
 */

/**
 * Decode the claims (payload) of a JWT without verifying its signature. Safe
 * here because these are our own server-stored tokens from a TLS code exchange
 * — same trust level as the access token we already store and use. Mirrors
 * better-auth's own `decodeJwt`. Returns null on any malformation.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
	const seg = jwt.split(".")[1];
	if (!seg) return null;
	try {
		return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return null;
	}
}
