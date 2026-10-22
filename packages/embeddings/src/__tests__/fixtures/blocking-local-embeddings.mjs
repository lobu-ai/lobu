// Stand-in for the local ONNX component (LOBU_RUNTIME_EMBEDDINGS_ENTRY).
// onnxruntime-node runs a forward pass synchronously on the calling thread, so
// this fake does the same: a `block:<ms>` text busy-waits that long before
// returning, the way a large batch does on a contended CPU. `fail` throws like
// a model error; `crash` ends the inference thread (process.exit on a worker
// thread stops only that thread, not the service).
export async function batchGenerateLocalEmbeddings(texts) {
	if (texts.includes("fail")) throw new Error("component failed");
	if (texts.includes("crash")) {
		process.exit(1);
		// Bun may finish the current task before the thread stops; never answer.
		return new Promise(() => {});
	}
	return texts.map((text) => {
		if (text.startsWith("block:")) {
			const until = Date.now() + Number(text.slice("block:".length));
			while (Date.now() < until) {
				// Synchronous, like an ONNX forward pass.
			}
		}
		return new Array(768).fill(0.001);
	});
}
