import { parentPort, Worker } from "node:worker_threads";
import { loadLocalEmbeddings } from "./local-runtime.js";

// onnxruntime-node runs each forward pass synchronously on the calling thread,
// so local inference on the HTTP thread stalls every other request — /health
// included — for the whole embed call. It runs on this worker thread instead.
//
// The worker re-loads the service's own entry module (the caller passes its
// `import.meta.url`): that is the one file every launch layout has — the .ts
// source under bun or tsx, tsc's dist, and the CLI's esbuild bundle — and the
// entry hands control to `runInferenceWorker` when it is not the main thread.

interface InferenceRequest {
	id: number;
	texts: string[];
	batchSize: number;
}

type InferenceResponse =
	| { id: number; embeddings: number[][] }
	| { id: number; error: string };

interface Pending {
	resolve: (embeddings: number[][]) => void;
	reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function failPending(error: Error): void {
	for (const entry of pending.values()) entry.reject(error);
	pending.clear();
}

function spawnWorker(entry: URL): Worker {
	// Node runs a TS entry only through tsx (the embedded runtime forks the
	// source with `--import tsx`), and tsx registers its loader on the main
	// thread only — so register it inside the worker before loading the entry.
	// Bun, tsc's dist and the CLI bundle load the entry directly.
	if (entry.pathname.endsWith(".ts") && !process.versions.bun) {
		const tsxApi = import.meta.resolve("tsx/esm/api");
		return new Worker(
			`import(${JSON.stringify(tsxApi)}).then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.href)}); });`,
			{ eval: true },
		);
	}
	return new Worker(entry);
}

function getWorker(entry: URL): Worker {
	if (worker) return worker;
	const spawned = spawnWorker(entry);
	spawned.on("message", (message: InferenceResponse) => {
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if ("error" in message) request.reject(new Error(message.error));
		else request.resolve(message.embeddings);
	});
	spawned.on("error", (error) => {
		failPending(error instanceof Error ? error : new Error(String(error)));
	});
	// A dead worker is replaced on the next request instead of bricking the
	// local backend until the process restarts.
	spawned.on("exit", (code) => {
		if (worker === spawned) worker = null;
		failPending(new Error(`Embeddings inference worker exited with code ${code}`));
	});
	// The HTTP server keeps the process alive; an idle worker must not.
	spawned.unref();
	worker = spawned;
	return spawned;
}

export function generateLocalEmbeddingsOffThread(
	entry: URL,
	texts: string[],
	batchSize: number,
): Promise<number[][]> {
	const target = getWorker(entry);
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		target.postMessage({ id, texts, batchSize } satisfies InferenceRequest);
	});
}

export function runInferenceWorker(): void {
	const port = parentPort;
	if (!port) throw new Error("runInferenceWorker must run on a worker thread");
	port.on("message", async ({ id, texts, batchSize }: InferenceRequest) => {
		try {
			const { batchGenerateLocalEmbeddings } = await loadLocalEmbeddings();
			const embeddings = await batchGenerateLocalEmbeddings(texts, batchSize);
			port.postMessage({ id, embeddings } satisfies InferenceResponse);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Embedding generation failed";
			port.postMessage({ id, error: message } satisfies InferenceResponse);
		}
	});
}
