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

interface Job extends InferenceRequest {
	embeddings: number[][];
}

/**
 * Pick the next request to advance one batch: the one with the fewest batches
 * left, oldest first on a tie. A one-text search query then waits for at most
 * the batch already running, not for every connector backfill queued ahead of
 * it (prod: 30-50 s behind 256-text requests on this one thread).
 */
function nextJob(jobs: Job[]): Job {
	const remaining = (job: Job) =>
		Math.ceil((job.texts.length - job.embeddings.length) / job.batchSize);
	return jobs.reduce((best, job) => (remaining(job) < remaining(best) ? job : best));
}

export function runInferenceWorker(): void {
	if (!parentPort) throw new Error("runInferenceWorker must run on a worker thread");
	const port = parentPort;
	const jobs: Job[] = [];
	let pumping = false;

	async function pump(): Promise<void> {
		if (pumping) return;
		pumping = true;
		try {
			const { batchGenerateLocalEmbeddings } = await loadLocalEmbeddings();
			while (jobs.length > 0) {
				// A forward pass blocks this thread, so a request that arrives
				// mid-batch is only seen here: yield to the message queue before
				// choosing the next batch.
				await new Promise((resolve) => setImmediate(resolve));
				const job = nextJob(jobs);
				const start = job.embeddings.length;
				try {
					const batch = job.texts.slice(start, start + job.batchSize);
					const vectors = await batchGenerateLocalEmbeddings(batch, batch.length);
					// A short answer would misalign every later batch, and an
					// empty one would never finish the request.
					if (vectors.length !== batch.length) {
						throw new Error(`Local embeddings returned ${vectors.length} vectors for ${batch.length} texts`);
					}
					job.embeddings.push(...vectors);
					if (job.embeddings.length < job.texts.length) continue;
					port.postMessage({ id: job.id, embeddings: job.embeddings } satisfies InferenceResponse);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Embedding generation failed";
					port.postMessage({ id: job.id, error: message } satisfies InferenceResponse);
				}
				jobs.splice(jobs.indexOf(job), 1);
			}
		} catch (error) {
			// The component itself failed to load: fail everything queued.
			const message =
				error instanceof Error ? error.message : "Embedding generation failed";
			for (const job of jobs.splice(0)) {
				port.postMessage({ id: job.id, error: message } satisfies InferenceResponse);
			}
		} finally {
			pumping = false;
		}
	}

	port.on("message", (request: InferenceRequest) => {
		jobs.push({ ...request, batchSize: Math.max(1, request.batchSize), embeddings: [] });
		void pump();
	});
}
