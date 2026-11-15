import { createHmac } from "node:crypto";
import { withAuthClientIP } from "../../auth/abuse-protection";
import type { createAuth } from "../../auth/index";

const origin = "http://localhost";

export class Browser {
	private cookies = new Map<string, string>();
	constructor(private auth: Awaited<ReturnType<typeof createAuth>>, private ip = "192.0.2.1") {}
	get cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "); }
	async request(path: string, body?: Record<string, unknown>, headers?: Record<string, string>) {
		const response = await withAuthClientIP(this.ip, () => this.auth.handler(new Request(`${origin}/api/auth${path}`, {
			method: body ? "POST" : "GET",
			headers: {
				origin,
				"content-type": "application/json",
				cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
				...headers,
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		})));
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(";");
			const separator = pair!.indexOf("=");
			const name = pair!.slice(0, separator);
			const value = pair!.slice(separator + 1);
			if (!value || /max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
		return { response, body: await response.json().catch(() => null) };
	}
}

export function totp(uri: string, offsetPeriods = 0): string {
	const secret = new URL(uri).searchParams.get("secret")!;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const bits = [...secret.replace(/=+$/, "")].map((char) =>
		alphabet.indexOf(char.toUpperCase()).toString(2).padStart(5, "0")).join("");
	const bytes = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetPeriods));
	const digest = createHmac("sha1", bytes).update(counter).digest();
	const offset = digest[digest.length - 1]! & 15;
	return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
