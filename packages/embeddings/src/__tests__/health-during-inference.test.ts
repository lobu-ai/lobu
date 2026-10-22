import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Prod regression: the local model's forward pass is synchronous, so running it
// on the HTTP thread left /health unanswered for the whole request and the
// kubelet's readiness/liveness probes timed out. Spawn the REAL server under
// both runtimes that launch it (bun in the container, node+tsx in the
// embedded runtime) with a component that blocks like ONNX does, and require
// /health to answer while an embed request is still computing.

const PKG_ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(import.meta.dir, "..", "server.ts");
const BLOCKING_COMPONENT = join(import.meta.dir, "fixtures", "blocking-local-embeddings.mjs");
const INFERENCE_MS = 3000;
const PROBE_TIMEOUT_MS = 1000;

const RUNTIMES = [
	{ name: "bun (container CMD)", command: "bun", args: [SERVER], port: 18961 },
	{ name: "node+tsx (embedded runtime)", command: "node", args: ["--import", "tsx", SERVER], port: 18962 },
];

async function waitForHealth(base: string): Promise<void> {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
			if (res.ok) return;
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("server never became healthy");
}

describe("/health stays responsive while local inference runs", () => {
	for (const runtime of RUNTIMES) {
		test(runtime.name, async () => {
			const child = spawn(runtime.command, runtime.args, {
				cwd: PKG_ROOT,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PORT: String(runtime.port),
					EMBEDDINGS_BACKEND: "local",
					EMBEDDINGS_SERVICE_TOKEN: "",
					LOBU_RUNTIME_EMBEDDINGS_ENTRY: BLOCKING_COMPONENT,
				},
			});
			const base = `http://127.0.0.1:${runtime.port}`;
			try {
				await waitForHealth(base);

				const started = Date.now();
				const embed = fetch(`${base}/api/embeddings`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ texts: [`block:${INFERENCE_MS}`] }),
				});
				// Let the request reach the model before probing.
				await new Promise((r) => setTimeout(r, 500));

				const probeStarted = Date.now();
				const health = await fetch(`${base}/health`, {
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				}).catch((error: unknown) => error);
				const probeMs = Date.now() - probeStarted;

				const res = await embed;
				const body = (await res.json()) as { embeddings: number[][] };

				expect(health).toBeInstanceOf(Response);
				expect((health as Response).status).toBe(200);
				// The probe answered while inference was still running.
				expect(probeStarted + probeMs).toBeLessThan(started + INFERENCE_MS);
				expect(res.status).toBe(200);
				expect(body.embeddings).toHaveLength(1);
				expect(body.embeddings[0]).toHaveLength(768);
			} finally {
				child.kill("SIGKILL");
				await new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) resolve();
					else child.on("exit", () => resolve());
				});
			}
		}, 30000);
	}
});
