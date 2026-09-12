import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { validateEmbeddingDimensions } from "./embedding-utils.js";
import {
	DEFAULT_BATCH_SIZE,
	DEFAULT_DIMENSIONS,
	getLocalModelName,
} from "./metadata.js";
import { loadLocalEmbeddings } from "./local-runtime.js";
import { scrubSecrets } from "./internal/scrub-secrets.js";
import {
	generateOpenAIEmbeddings,
	OpenAIEmbeddingsTimeoutError,
} from "./openai.js";

interface EmbeddingRequest {
	texts?: unknown;
	model?: string;
}

const DEFAULT_PORT = 8790;
const DEFAULT_TIMEOUT_MS = 30000;
// Hard DoS limits per request.
const MAX_TEXTS_PER_REQUEST = 256;
const MAX_TEXT_BYTES = 32 * 1024;
// Allowlist for client-supplied model identifiers — rejects whitespace, path
// segments, and shell metacharacters.
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

const app = new Hono();

function resolveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function scrubServerSecrets(message: string): string {
	return scrubSecrets(message, [
		process.env.EMBEDDINGS_API_KEY ?? "",
		process.env.EMBEDDINGS_SERVICE_TOKEN ?? "",
	]);
}

function parseTexts(
	payload: EmbeddingRequest,
): { texts: string[] } | { error: string } {
	if (!Array.isArray(payload.texts)) {
		return { error: "texts must be an array of strings" };
	}

	if (payload.texts.length > MAX_TEXTS_PER_REQUEST) {
		return {
			error: `texts cannot contain more than ${MAX_TEXTS_PER_REQUEST} entries`,
		};
	}

	const texts: string[] = [];
	for (const value of payload.texts) {
		if (typeof value !== "string") {
			return { error: "texts must be an array of strings" };
		}
		const trimmed = value.trim();
		if (!trimmed) {
			return { error: "texts cannot contain empty strings" };
		}
		if (Buffer.byteLength(trimmed, "utf8") > MAX_TEXT_BYTES) {
			return { error: `each text must be at most ${MAX_TEXT_BYTES} bytes` };
		}
		texts.push(trimmed);
	}

	if (texts.length === 0) {
		return { error: "texts cannot be empty" };
	}

	return { texts };
}

// Constant-time bearer-token compare. timingSafeEqual requires equal-length
// buffers; reject mismatched lengths up front (length itself isn't secret).
function tokensMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

function requireAuth(request: Request): string | null {
	const token = process.env.EMBEDDINGS_SERVICE_TOKEN;
	if (!token) {
		return null;
	}

	const header = request.headers.get("authorization") || "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match || !tokensMatch(match[1]!, token)) {
		return "Unauthorized";
	}

	return null;
}

app.get("/health", (c) => {
	const backend = (process.env.EMBEDDINGS_BACKEND || "local").toLowerCase();
	const model =
		backend === "openai" ? process.env.EMBEDDINGS_MODEL : getLocalModelName();
	return c.json({ ok: true, backend, model });
});

app.post("/api/embeddings", async (c) => {
	const authError = requireAuth(c.req.raw);
	if (authError) {
		return c.json({ error: authError }, 401);
	}

	let payload: EmbeddingRequest;
	try {
		payload = (await c.req.json()) as EmbeddingRequest;
	} catch {
		return c.json({ error: "Invalid JSON payload" }, 400);
	}

	const parsed = parseTexts(payload);
	if ("error" in parsed) {
		return c.json({ error: parsed.error }, 400);
	}

	const backend = (process.env.EMBEDDINGS_BACKEND || "local").toLowerCase();
	const expectedDimensions = resolveNumber(
		process.env.EMBEDDINGS_DIMENSIONS,
		DEFAULT_DIMENSIONS,
	);
	const timeoutMs = resolveNumber(
		process.env.EMBEDDINGS_TIMEOUT_MS,
		DEFAULT_TIMEOUT_MS,
	);
	const normalize = process.env.EMBEDDINGS_NORMALIZE !== "false";

	try {
		if (backend === "openai") {
			const apiKey = process.env.EMBEDDINGS_API_KEY;
			if (!apiKey) {
				return c.json(
					{ error: "EMBEDDINGS_API_KEY is required for openai backend" },
					500,
				);
			}

			const apiUrl =
				process.env.EMBEDDINGS_API_URL ||
				"https://api.openai.com/v1/embeddings";
			const model = payload.model || process.env.EMBEDDINGS_MODEL;
			if (!model) {
				return c.json(
					{ error: "EMBEDDINGS_MODEL is required for openai backend" },
					500,
				);
			}
			// Client-supplied model strings are validated; env-var fallback is trusted.
			if (payload.model && !MODEL_NAME_PATTERN.test(payload.model)) {
				return c.json({ error: "invalid model identifier" }, 400);
			}

			const embeddings = await generateOpenAIEmbeddings({
				texts: parsed.texts,
				apiUrl,
				apiKey,
				model,
				expectedDimensions,
				normalize,
				timeoutMs,
			});

			return c.json({
				model,
				dimensions: expectedDimensions,
				embeddings,
			});
		}

		const batchSize = resolveNumber(
			process.env.EMBEDDINGS_BATCH_SIZE,
			DEFAULT_BATCH_SIZE,
		);
		const { batchGenerateLocalEmbeddings } = await loadLocalEmbeddings();
		const embeddings = await batchGenerateLocalEmbeddings(
			parsed.texts,
			batchSize,
		);

		for (const embedding of embeddings) {
			validateEmbeddingDimensions(
				embedding,
				expectedDimensions,
				"Local embeddings response",
			);
		}

		return c.json({
			model: getLocalModelName(),
			dimensions: expectedDimensions,
			embeddings,
		});
	} catch (error) {
		const rawMessage =
			error instanceof Error ? error.message : "Embedding generation failed";
		// Defense-in-depth scrub before logging/returning.
		const message = scrubServerSecrets(rawMessage);
		console.error("[EmbeddingsService] Error:", message);
		if (error instanceof OpenAIEmbeddingsTimeoutError) {
			return c.json({ error: message }, 504);
		}
		return c.json({ error: message }, 500);
	}
});

// When forked by the embedded runtime (startEmbeddings), exit if the parent
// dies without a graceful teardown — otherwise the child is orphaned and leaks
// until killed by hand. Standalone `npm start` has no IPC channel, so
// process.send is undefined and this never fires.
//
// Register the listener BEFORE checking process.connected: Node does not
// replay a 'disconnect' emitted before a listener exists, and the parent can
// die mid-module-load (imports run before this line). Register-then-check is
// gap-free — no event can be processed between two synchronous statements.
if (process.send) {
	process.on("disconnect", () => process.exit(143));
	if (!process.connected) process.exit(143);
}

const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

serve({
	fetch: app.fetch,
	port,
});

console.log(`[EmbeddingsService] Listening on port ${port}`);
