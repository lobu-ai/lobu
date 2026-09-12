/**
 * Connector runtime parity self-check.
 *
 * One shared function run from BOTH entrypoints — the worker Docker image
 * (`node dist/bin.js self-check`) and the built CLI (`lobu connector
 * runtime-self-check`) — so both assert the identical compile + isolate
 * execution path. The only per-surface difference is the connector
 * source discovery roots (monorepo vs worker image vs npm-installed CLI).
 *
 * The result also reports the isolate lane (`isolate_lane`): whether this
 * runtime can load `isolated-vm`, the V8 addon every connector run needs.
 * That section never flips `ok` — a Bun or Node 25 host legitimately lacks the
 * addon and simply runs no connector code — but the worker
 * image smoke asserts `isolate_lane.available` separately, because the image
 * exists to run the isolate lane and its native build is otherwise unproven.
 *
 * Why it exists: the worker image once shipped to prod missing `COPY
 * packages/core`, so `@lobu/connector-sdk`'s transitive `@lobu/core` import
 * dangled and every feed sync crashed — yet all CI was green, because CI builds
 * and pushes the image but never RUNS it. This gate runs the built artifact and
 * asserts its resolution/compile/execute graph holds. It touches no network, DB,
 * gateway, or OAuth, and passes under `docker run --network=none`.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createIsolateConnectorCompiler,
} from "../compile/index.js";
import { executeDaemonBuiltin } from "../daemon/builtins/index.js";
import type { ExecutorJob } from "../executor/interface.js";
import {
	registerConnectorRuntimeDependencyLoader,
	stageConnectorRuntimeDependencies,
} from "../executor/runtime-dependency-loader.js";
import { executeCompiledConnector } from "../executor/runtime.js";
import {
	isolatedVmSpecifier,
	isolatedVmUnavailableReason,
	loadIsolatedVm,
} from "../isolate/load.js";

/**
 * Synthetic no-op connector, inline so the check is self-contained and ships
 * identically in the worker image and the published CLI (both from `dist/`). It
 * is not a real bundled connector (the catalog never scans it) and touches no
 * network/DB/filesystem, so it passes under `--network=none`.
 */
const SYNTHETIC_CONNECTOR_SOURCE = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class SelfCheckNoopConnector extends ConnectorRuntime {
  definition = {
    key: 'self_check_noop',
    name: 'Self-Check No-Op',
    description: 'Synthetic connector for the connector-runtime self-check.',
    version: '0.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      noop: {
        key: 'noop',
        name: 'No-Op',
        description: 'Emits one synthetic event.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {},
        sync: async () => ({
          events: [
            {
              origin_id: 'self-check-noop-1',
              semantic_type: 'observation',
              occurred_at: new Date(0),
              payload_text: 'self-check noop event',
            },
          ],
          checkpoint: { ran: true },
          metadata: { items_found: 1, items_skipped: 0 },
        }),
      },
    },
  };
}
`;

export interface SelfCheckEntry {
	name: string;
	ok: boolean;
	detail: string;
}

/**
 * Whether this runtime can host `lane: 'isolate'` runs. Snake_case on purpose:
 * the image smokes read it with `jq '.isolate_lane.available'`.
 */
export interface SelfCheckIsolateLane {
	/** `isolated-vm` loaded; `selectExecutor` can build an `IsolateExecutor`. */
	available: boolean;
	/** Why not, when unavailable; `null` when available. */
	reason: string | null;
	/** Installed version of the build this Node line uses; `null` if absent. */
	isolated_vm_version: string | null;
	node_version: string;
}

export interface SelfCheckResult {
	ok: boolean;
	/** Which entrypoint ran the check — for log/parity-debugging only. */
	surface: "cli" | "worker" | "unknown";
	connectorSourceDir: string | null;
	connectorCount: number;
	checks: SelfCheckEntry[];
	/** Informational: does not participate in `ok` (see module doc). */
	isolate_lane: SelfCheckIsolateLane;
}

export interface SelfCheckOptions {
	/**
	 * Connector source discovery roots, highest priority first; the first
	 * existing one wins. Each surface passes its own layout. Defaults cover the
	 * monorepo + worker image.
	 */
	connectorSourceCandidates?: readonly string[];
	/** Label recorded on the result so logs say which entrypoint ran. */
	surface?: SelfCheckResult["surface"];
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

// This module lives at `packages/connector-worker/{src,dist}/self-check/`, so
// `../../../connectors/...` reaches the bundled connectors from both the TS
// source and the built dist (and from `/app/...` in the worker image).
const DEFAULT_CONNECTOR_SOURCE_CANDIDATES: readonly string[] = [
	resolve(HERE, "../../../connectors/src"),
	resolve(HERE, "../../../connectors/dist"),
	// npm-installed CLI ships connector-worker + connectors side-by-side.
	resolve(HERE, "../connectors"),
	resolve(HERE, "connectors"),
	// Project-root fallbacks for custom runtimes.
	resolve(process.cwd(), "packages/connectors/src"),
	resolve(process.cwd(), "connectors"),
];

function firstExistingDir(candidates: readonly string[]): string | null {
	for (const dir of candidates) {
		if (existsSync(dir)) return dir;
	}
	return null;
}

const errMsg = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/**
 * Write `content` inside a private OS temp directory, stage the runtime package
 * facade used by both ESM and CommonJS resolution, run `fn`, then remove the
 * directory. This keeps startup independent of whether cwd is writable.
 */
async function withRuntimeTempFile<T>(
	ext: string,
	content: string,
	fn: (filePath: string) => Promise<T>,
): Promise<T> {
	const tempDir = await mkdtemp(join(tmpdir(), "lobu-self-check-"));
	const filePath = join(tempDir, `connector${ext}`);
	try {
		await stageConnectorRuntimeDependencies(tempDir);
		await writeFile(filePath, content, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		return await fn(filePath);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * One-level-deep scan mirroring the server catalog's `collectConnectorSourceFiles`:
 * top-level `*.ts` plus one subdir level, skipping `__tests__`, `_`-prefixed
 * dirs, and `.d.ts`. Non-connector files (index/util) carry no ConnectorRuntime
 * class and are dropped after compile.
 */
async function collectConnectorSourceFiles(dirPath: string): Promise<string[]> {
	const paths: string[] = [];
	const isConnectorFile = (name: string) =>
		extname(name) === ".ts" && !name.endsWith(".d.ts");
	for (const entry of await readdir(dirPath, { withFileTypes: true })) {
		const entryPath = resolve(dirPath, entry.name);
		if (entry.isFile()) {
			if (isConnectorFile(entry.name)) paths.push(entryPath);
		} else if (
			entry.isDirectory() &&
			entry.name !== "__tests__" &&
			!entry.name.startsWith("_")
		) {
			// An unreadable connector subdir IS a packaging defect for a parity
			// gate, so let the readdir error propagate (caught by the enclosing
			// `connectors-instantiate` check) rather than silently skipping it.
			for (const sub of await readdir(entryPath, { withFileTypes: true })) {
				if (sub.isFile() && isConnectorFile(sub.name)) {
					paths.push(resolve(entryPath, sub.name));
				}
			}
		}
	}
	return paths.sort();
}

function findConnectorRuntimeClass(
	mod: Record<string, unknown>,
): (new () => unknown) | null {
	const looksLikeConnector = (val: unknown): val is new () => unknown =>
		typeof val === "function" &&
		// biome-ignore lint/suspicious/noExplicitAny: duck-typing the runtime contract
		!!(val as any).prototype?.sync &&
		// biome-ignore lint/suspicious/noExplicitAny: duck-typing the runtime contract
		!!(val as any).prototype?.execute;
	// A `.cjs` bundle imported from ESM arrives as `{ default: module.exports }`,
	// so the connector class sits one level down; a real ESM module has it at
	// the top. Search the inner namespace first, then the outer one -- and only
	// once when they are the same object.
	const inner =
		mod.default && typeof mod.default === "object"
			? (mod.default as Record<string, unknown>)
			: null;
	for (const scope of inner ? [inner, mod] : [mod]) {
		const found =
			Object.values(scope).find(looksLikeConnector) ??
			(looksLikeConnector(scope.default) ? scope.default : null);
		if (found) return found;
	}
	return null;
}

interface DiscoveredConnector {
	sourcePath: string;
	key: string;
	name: string;
	version: string;
}

/**
 * Compile a connector, import the resulting bundle, and read its `definition`.
 * Importing a runtime-compiled bundle is inherently dynamic — reading a
 * connector's `definition` requires evaluating it — not a new lazy-load
 * codepath. Returns `null` for
 * files carrying no ConnectorRuntime class (index/util files).
 */
async function instantiateConnector(
	sourcePath: string,
	compile: (filePath: string) => Promise<string>,
): Promise<DiscoveredConnector | null> {
	const compiled = await compile(sourcePath);
	return withRuntimeTempFile(".cjs", compiled, async (tmpFile) => {
		const mod = (await import(pathToFileURL(tmpFile).href)) as Record<
			string,
			unknown
		>;
		const RuntimeClass = findConnectorRuntimeClass(mod);
		if (!RuntimeClass) return null;
		const { definition: def } = new RuntimeClass() as {
			definition?: Record<string, unknown>;
		};
		if (!def || typeof def !== "object") {
			throw new Error("ConnectorRuntime class exposes no `definition`.");
		}
		for (const field of ["key", "name", "version"] as const) {
			if (typeof def[field] !== "string" || !def[field]) {
				throw new Error(`definition.${field} is missing.`);
			}
		}
		return {
			sourcePath,
			key: def.key as string,
			name: def.name as string,
			version: def.version as string,
		};
	});
}

/**
 * Compile and run the synthetic connector through the real compile + default
 * `IsolateExecutor` path. Throws on any failure so the caller records a failed check.
 */
async function runSyntheticConnector(
	compile: (filePath: string) => Promise<string>,
): Promise<void> {
	// esbuild needs a file entry, so stage the inline source in a temp `.ts`.
	const compiled = await withRuntimeTempFile(
		".ts",
		SYNTHETIC_CONNECTOR_SOURCE,
		compile,
	);
	const job: ExecutorJob = {
		mode: "sync",
		feedKey: "noop",
		config: {},
		checkpoint: null,
		entityIds: [],
		credentials: null,
		sessionState: null,
		env: {}, // hermetic: no inherited host secrets
	};

	let eventCount = 0;
	// No custom executor — defaults to the real IsolateExecutor.
	const result = await executeCompiledConnector({
		compiledCode: compiled,
		job,
		hooks: {
			onEventChunk: (events) => {
				eventCount += events.length;
			},
		},
	});

	if (result.mode !== "sync") {
		throw new Error(`Expected sync result, got mode=${result.mode}.`);
	}
	if (eventCount < 1) {
		throw new Error(
			"Ran but emitted no events — the compile/execute event stream is broken.",
		);
	}
}

/**
 * Probe the isolate lane the way `selectExecutor` does — through the memoized
 * `loadIsolatedVm()` — and read the installed addon's version from the
 * package this Node line resolves. The version read is best-effort metadata:
 * `available` is the assertion.
 */
export async function probeIsolateLane(): Promise<SelfCheckIsolateLane> {
	const node_version = process.versions.node;
	const specifier = isolatedVmSpecifier();
	let isolated_vm_version: string | null = null;
	if (specifier) {
		try {
			const pkgPath = createRequire(import.meta.url).resolve(
				`${specifier}/package.json`,
			);
			const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
				version?: unknown;
			};
			if (typeof pkg.version === "string") isolated_vm_version = pkg.version;
		} catch {
			// Not installed (optionalDependency skipped) — reported via `reason`.
		}
	}
	const available = (await loadIsolatedVm()) !== null;
	const reason = available
		? null
		: (isolatedVmUnavailableReason() ??
			`${specifier} did not load on Node ${node_version}: the optionalDependency is missing or its native build failed`);
	return { available, reason, isolated_vm_version, node_version };
}

/**
 * Fast boot gate for a worker that is about to advertise connector
 * capabilities. It compiles and executes the synthetic connector through the
 * real isolate path, so a runtime that cannot load the SDK fails before its
 * first poll can claim production work.
 */
export async function assertConnectorRuntimeLoadable(): Promise<void> {
	registerConnectorRuntimeDependencyLoader();
	const { compileConnectorForIsolateFromFile } = createIsolateConnectorCompiler({ cacheMax: 1 });
	await runSyntheticConnector(compileConnectorForIsolateFromFile);
}

/**
 * Run the shared connector-runtime parity self-check. Each assertion is
 * recorded as a `{ ok }` entry rather than thrown; the top-level `ok` is the
 * AND of all of them.
 */
export async function runConnectorRuntimeSelfCheck(
	opts?: SelfCheckOptions,
): Promise<SelfCheckResult> {
	registerConnectorRuntimeDependencyLoader();
	const checks: SelfCheckEntry[] = [];
	const require_ = createRequire(import.meta.url);

	// Run `fn` (sync or async); record ok with its returned detail, or the error.
	const check = async (
		name: string,
		fn: () => unknown | Promise<unknown>,
	): Promise<void> => {
		try {
			const detail = await fn();
			checks.push({
				name,
				ok: true,
				detail: typeof detail === "string" ? detail : "ok",
			});
		} catch (err) {
			checks.push({ name, ok: false, detail: errMsg(err) });
		}
	};

	// @lobu/core is anchored at the SDK (the way the SDK consumes it) to reproduce
	// the exact prod edge that dangled: `.../connector-sdk/node_modules/@lobu/core`.
	// Anchoring at connector-worker would only resolve in the hoisted dev
	// workspace and falsely fail in the isolated-linker image. The `import(...)`
	// probes are intentional runtime-resolution checks, not lazy module loads.
	const sdkRequire = () =>
		createRequire(require_.resolve("@lobu/connector-sdk"));
	await check("resolve:@lobu/connector-sdk", () =>
		require_.resolve("@lobu/connector-sdk"),
	);
	await check(
		"import:@lobu/connector-sdk",
		() => import("@lobu/connector-sdk"),
	);
	await check("resolve:@lobu/core", () => sdkRequire().resolve("@lobu/core"));
	await check(
		"import:@lobu/core",
		() => import(pathToFileURL(sdkRequire().resolve("@lobu/core")).href),
	);


	const candidates =
		opts?.connectorSourceCandidates ?? DEFAULT_CONNECTOR_SOURCE_CANDIDATES;
	const connectorSourceDir = firstExistingDir(candidates);
	await check("connector-source-dir", () => {
		if (!connectorSourceDir) {
			throw new Error(
				`No connector source directory found. Tried: ${candidates.join(", ")}.`,
			);
		}
	});

	// One compiler instance (mtime-LRU cache) across every connector + fixture.
	const { compileConnectorForIsolateFromFile } = createIsolateConnectorCompiler();

	// Discover, compile, and instantiate every connector; then assert key uniqueness.
	const discovered: DiscoveredConnector[] = [];
	await check("connectors-instantiate", async () => {
		if (!connectorSourceDir) throw new Error("No connector source directory.");
		for (const file of await collectConnectorSourceFiles(connectorSourceDir)) {
			const conn = await instantiateConnector(file, compileConnectorForIsolateFromFile);
			if (conn) discovered.push(conn);
		}
		if (discovered.length === 0) {
			throw new Error(
				`No connector definitions discovered under ${connectorSourceDir}.`,
			);
		}
		return `${discovered.length} connectors instantiated with key/name/version.`;
	});
	await check("connector-keys-unique", () => {
		const seen = new Map<string, string>();
		const dupes: string[] = [];
		for (const c of discovered) {
			const prev = seen.get(c.key);
			if (prev) dupes.push(`${c.key} (${prev} + ${c.sourcePath})`);
			else seen.set(c.key, c.sourcePath);
		}
		if (dupes.length)
			throw new Error(`Duplicate connector keys: ${dupes.join("; ")}.`);
		return `${seen.size} unique keys.`;
	});

	// Synthetic connector compiles + runs through the DEFAULT IsolateExecutor.
	await check("synthetic-connector-execute", async () => {
		await runSyntheticConnector(compileConnectorForIsolateFromFile);
		return "compiled + executed via default IsolateExecutor; emitted >=1 event.";
	});

	// Recovery/control primitives must remain executable even when the dynamic
	// connector compiler or its npm resolution graph is unhealthy. This call is
	// intentionally direct and therefore proves the packaged dist contains the
	// daemon-owned os.shell backend.
	await check("daemon-builtin:os.shell/run", async () => {
		const result = await executeDaemonBuiltin({
			connectorKey: "os.shell",
			actionKey: "run",
			input: { command: "printf 'lobu-shell-self-check\\n'", cwd: process.cwd() },
		});
		if (!result.ok) {
			const output = result.output
				? `; output=${JSON.stringify(result.output)}`
				: "";
			throw new Error(`${result.code}: ${result.error}${output}`);
		}
		if (result.output.stdout !== "lobu-shell-self-check\n") {
			throw new Error(`Unexpected stdout: ${JSON.stringify(result.output.stdout)}.`);
		}
		if (result.output.stderr !== "" || result.output.exit_code !== 0) {
			throw new Error(`Unexpected shell result: ${JSON.stringify(result.output)}.`);
		}
		return "executed from packaged worker code without connector compilation.";
	});

	return {
		ok: checks.every((c) => c.ok),
		surface: opts?.surface ?? "unknown",
		connectorSourceDir,
		connectorCount: discovered.length,
		checks,
		isolate_lane: await probeIsolateLane(),
	};
}

/** Pretty-print a self-check result to stderr (human-readable mode). */
export function printSelfCheckResult(result: SelfCheckResult): void {
	const lines = [
		`connector runtime self-check (${result.surface}): ${result.ok ? "PASS" : "FAIL"}`,
	];
	if (result.connectorSourceDir) {
		lines.push(
			`  connector source: ${result.connectorSourceDir} (${result.connectorCount} connectors)`,
		);
	}
	for (const c of result.checks) {
		lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
	}
	const lane = result.isolate_lane;
	lines.push(
		lane.available
			? `  isolate lane: available (isolated-vm ${lane.isolated_vm_version ?? "unknown"}, Node ${lane.node_version})`
			: `  isolate lane: unavailable on Node ${lane.node_version} — ${lane.reason}`,
	);
	process.stderr.write(`${lines.join("\n")}\n`);
}
