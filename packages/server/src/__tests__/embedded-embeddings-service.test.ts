import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddings } from "../embedded-runtime";

// `lobu run` forks the embeddings service for the gateway alone: it must not be
// reachable from other hosts or callable without the gateway's credential. Drives
// the real fork; the openai backend keeps the run from loading the local model.
describe("startEmbeddings (embedded embeddings service)", () => {
	const saved = {
		url: process.env.EMBEDDINGS_SERVICE_URL,
		token: process.env.EMBEDDINGS_SERVICE_TOKEN,
		backend: process.env.EMBEDDINGS_BACKEND,
		apiKey: process.env.EMBEDDINGS_API_KEY,
	};
	let child: Awaited<ReturnType<typeof startEmbeddings>>;
	let url = "";
	let port = 0;

	beforeAll(async () => {
		delete process.env.EMBEDDINGS_SERVICE_URL;
		delete process.env.EMBEDDINGS_SERVICE_TOKEN;
		delete process.env.EMBEDDINGS_API_KEY;
		process.env.EMBEDDINGS_BACKEND = "openai";
		child = await startEmbeddings();
		url = process.env.EMBEDDINGS_SERVICE_URL ?? "";
		port = Number(new URL(url).port);
		const deadline = Date.now() + 20_000;
		for (;;) {
			try {
				if ((await fetch(`${url}/health`)).ok) break;
			} catch {
				// Not listening yet.
			}
			if (Date.now() > deadline) throw new Error("embeddings service did not start");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}, 30_000);

	afterAll(() => {
		child?.kill();
		for (const [key, value] of Object.entries({
			EMBEDDINGS_SERVICE_URL: saved.url,
			EMBEDDINGS_SERVICE_TOKEN: saved.token,
			EMBEDDINGS_BACKEND: saved.backend,
			EMBEDDINGS_API_KEY: saved.apiKey,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const embed = (headers: Record<string, string> = {}) =>
		fetch(`${url}/api/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ texts: ["hello"] }),
		});

	it("mints a per-boot token and refuses callers without it", async () => {
		const token = process.env.EMBEDDINGS_SERVICE_TOKEN ?? "";
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect((await embed()).status).toBe(401);
		expect((await embed({ Authorization: "Bearer wrong" })).status).toBe(401);
		// Past auth, the request reaches the backend (no API key configured here).
		const authorized = await embed({ Authorization: `Bearer ${token}` });
		expect(authorized.status).toBe(500);
		expect(await authorized.json()).toEqual({
			error: "EMBEDDINGS_API_KEY is required for openai backend",
		});
	});

	it("listens on loopback only", async () => {
		const lan = Object.values(networkInterfaces())
			.flat()
			.find((address) => address && address.family === "IPv4" && !address.internal);
		if (!lan) return; // No non-loopback interface on this host to probe.
		await expect(fetch(`http://${lan.address}:${port}/health`)).rejects.toThrow();
	});
});
