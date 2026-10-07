/**
 * Isolate-lane eligibility for connector code.
 *
 * Bundles the connector SDK root and every bundled connector with the exact
 * esbuild options the isolate lane uses (`ISOLATE_LANE_BUILD_OPTIONS`), then:
 *
 *  1. asserts the SDK root pulls in no Node builtin and none of `@lobu/core`'s
 *     heavy graph (winston, Sentry, OpenTelemetry) — the property that makes a
 *     connector bundle loadable inside a V8 isolate at all;
 *  2. pins the Node builtins each bundled connector imports — adding `node:fs`
 *     to an isolate-eligible connector fails here instead of at a tenant's
 *     first run;
 *  3. loads every isolate-eligible connector in a real `isolated-vm` context
 *     and checks its default export came out the other side.
 *
 * Eligibility is decided by `findIsolateIneligibleBuiltins` — the same function
 * the runtime gates on — rather than restated here: the pin below records what
 * each bundle imports, and the runtime decides which of those disqualify it.
 * Restating it is how `postgres` ended up pinned to a process lane that no
 * longer exists, listing transport builtins it had already stopped importing.
 *
 * Runs under Node (vitest); like `run-script-runtime.test.ts` it FAILS rather
 * than skips when `isolated-vm` cannot load, because a silent skip is exactly
 * how the runtime lane would rot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import { ISOLATE_LANE_BUILD_OPTIONS } from "../../../utils/compiler-core";
import { compileConnectorSource } from "../../../utils/connector-compiler";
import { flattenConnectorSourceFromFile } from "@lobu/connector-worker/compile";
import { findIsolateIneligibleBuiltins, GUEST_PRELUDE } from "@lobu/connector-worker/isolate";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "../../../../..");
const SDK_DIR = join(PACKAGES_DIR, "connector-sdk");
const CONNECTORS_DIR = join(PACKAGES_DIR, "connectors/src");
const PERSONAL_AGENT_DIR = resolve(PACKAGES_DIR, "../examples/personal-agent");

/**
 * Node builtins each bundled connector's own bundle imports, keyed by file
 * stem. Hand-edited, never regenerated: a change here is a deliberate decision
 * about what a connector may depend on.
 *
 * Importing a builtin is NOT the same as needing a process — the isolate
 * prelude supplies several of them. {@link ISOLATE_INELIGIBLE} derives the
 * connectors that genuinely cannot run in an isolate from this map.
 */
const CONNECTOR_BUILTIN_IMPORTS: Record<string, string[]> = {
	// Webhook signature verification (HMAC); `crypto` comes from the prelude.
	github: ["crypto"],
	jira: ["crypto"],
	linear: ["crypto"],
	// Reaches its database over the isolate's Direct Sockets bridge, so it needs
	// no transport builtin; what is left is all prelude-provided.
	postgres: ["buffer", "events", "stream"],
};

/**
 * Connectors importing a builtin the isolate prelude does not supply, decided
 * by the runtime's own gate so this file cannot drift from it.
 */
const ISOLATE_INELIGIBLE = Object.keys(CONNECTOR_BUILTIN_IMPORTS).filter(
	(stem) =>
		findIsolateIneligibleBuiltins(
			CONNECTOR_BUILTIN_IMPORTS[stem]!.map((b) => `require("${b}")`).join(";"),
		).length > 0,
);

const BUILTINS = new Set(builtinModules);
function isNodeBuiltin(spec: string): boolean {
	return spec.startsWith("node:") || BUILTINS.has(spec);
}

/**
 * Resolve `@lobu/connector-sdk` (root and every `exports` subpath) to its
 * TypeScript source, so a stale `dist` can neither hide nor invent a builtin.
 */
function sdkSourcePlugin(): Plugin {
	const pkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")) as {
		exports: Record<string, unknown>;
	};
	const map = new Map<string, string>();
	for (const [key, value] of Object.entries(pkg.exports)) {
		const target =
			typeof value === "string"
				? value
				: ((value as { import?: string | { default?: string }; default?: string }).import ??
					(value as { default?: string }).default);
		const file = typeof target === "string" ? target : target?.default;
		if (!file) continue;
		const src = file.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
		map.set(key === "." ? "@lobu/connector-sdk" : `@lobu/connector-sdk/${key.slice(2)}`, join(SDK_DIR, src));
	}
	return {
		name: "sdk-source",
		setup(b) {
			b.onResolve({ filter: /^@lobu\/connector-sdk(\/.*)?$/ }, (args) => {
				const hit = map.get(args.path);
				if (!hit) return { errors: [{ text: `Unknown @lobu/connector-sdk subpath: ${args.path}` }] };
				return { path: hit };
			});
		},
	};
}

interface BundleReport {
	code: string;
	bytes: number;
	inputs: string[];
	builtins: Map<string, string[]>;
}

async function bundle(entry: string): Promise<BundleReport> {
	const result = await build({
		...ISOLATE_LANE_BUILD_OPTIONS,
		entryPoints: [entry],
		bundle: true,
		write: false,
		metafile: true,
		logLevel: "silent",
		absWorkingDir: PACKAGES_DIR,
		plugins: [sdkSourcePlugin()],
	});
	const metafile = result.metafile as Metafile;
	const builtins = new Map<string, string[]>();
	for (const [input, meta] of Object.entries(metafile.inputs)) {
		for (const imp of meta.imports) {
			if (imp.external && isNodeBuiltin(imp.path)) {
				const key = imp.path.replace(/^node:/, "");
				builtins.set(key, [...(builtins.get(key) ?? []), input]);
			}
		}
	}
	const code = result.outputFiles[0]?.text ?? "";
	return { code, bytes: Buffer.byteLength(code), inputs: Object.keys(metafile.inputs), builtins };
}

function listBundledConnectors(): string[] {
	return readdirSync(CONNECTORS_DIR)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.filter((f) => /export default (class|defineConnector)/.test(readFileSync(join(CONNECTORS_DIR, f), "utf8")))
		.sort();
}

type IsolatedVm = typeof import("isolated-vm");
async function loadIsolatedVm(): Promise<IsolatedVm> {
	const major = Number(process.versions.node.split(".")[0]);
	// Two ABI builds ship as optionalDependencies; see sandbox/run-script.ts.
	const mod = major >= 26 ? await import("isolated-vm-next") : await import("isolated-vm");
	return ((mod as { default?: IsolatedVm }).default ?? mod) as IsolatedVm;
}

/**
 * The guest gets exactly what a bare isolate host must provide for module
 * init: a CJS shell, a `require` that fails closed, and the handful of globals
 * pure-JS dependencies touch while loading (timers, console, process.env).
 * Anything else missing surfaces as a ReferenceError and fails the test.
 */
/**
 * The REAL guest prelude, not a hand-rolled stub. A stub whose `require` always
 * throws can only load a connector that requires nothing, which silently turned
 * this test into a check on four connectors' import lists rather than on
 * whether they load — `github` requires `node:crypto`, which the prelude serves
 * from `global.crypto`.
 */
const GUEST_PREAMBLE = GUEST_PRELUDE;

const GUEST_RUNNER = `
(function () {
  var def = module.exports.default;
  return JSON.stringify({ kind: def === null ? 'null' : typeof def, isClass: typeof def === 'function' && /^class\\b/.test(Function.prototype.toString.call(def)) });
})()`;

async function loadInIsolate(ivm: IsolatedVm, code: string): Promise<{ kind: string; isClass: boolean }> {
	const isolate = new ivm.Isolate({ memoryLimit: 256 });
	try {
		const context = await isolate.createContext();
		await context.global.set("global", context.global.derefInto());
		// The prelude captures its host bridge at eval time and calls it from
		// module scope (postgres reads its transport there), so a context without
		// these dies on `applySync` of undefined. Stubs, not fakes: this test asks
		// whether a connector LOADS, never what a capability returns.
		const okEnvelope = { __lobu: 1, ok: true, value: undefined };
		await context.global.set("__host_sync", new ivm.Reference(() => okEnvelope));
		await context.global.set("__host_async", new ivm.Reference(async () => okEnvelope));
		await context.global.set("__host_env_json", "{}");
		const script = await isolate.compileScript(`${GUEST_PREAMBLE}\n${code}\n${GUEST_RUNNER}`);
		const out = (await script.run(context, { timeout: 10_000, copy: true })) as string;
		return JSON.parse(out);
	} finally {
		isolate.dispose();
	}
}

const HEAVY_INPUT = /(^|\/)(winston|@sentry|@opentelemetry|@grpc)(\/|$)|packages\/core\/dist\/(index|logger|sentry|credentials)\.js$/;

describe("connector isolate lane", () => {
	it("SDK root bundles without Node builtins or @lobu/core's heavy graph", async () => {
		const report = await bundle(join(SDK_DIR, "src/index.ts"));
		expect(Object.fromEntries(report.builtins)).toEqual({});
		expect(report.inputs.filter((p) => HEAVY_INPUT.test(p))).toEqual([]);
		// ~330 KB today; the cap trips long before core's 6 MB graph creeps back.
		expect(report.bytes).toBeLessThan(1_000_000);
	});

	it("pins the Node builtins each bundled connector imports", async () => {
		const files = listBundledConnectors();
		expect(files.length).toBeGreaterThan(20);
		const actual: Record<string, string[]> = {};
		for (const file of files) {
			const report = await bundle(join(CONNECTORS_DIR, file));
			if (report.builtins.size > 0) actual[file.replace(/\.ts$/, "")] = [...report.builtins.keys()].sort();
		}
		expect(actual).toEqual(CONNECTOR_BUILTIN_IMPORTS);
	});

	it("loads every isolate-eligible bundled connector in a V8 isolate", async () => {
		const ivm = await loadIsolatedVm();
		const all = listBundledConnectors();
		const eligible = all.filter((f) => !ISOLATE_INELIGIBLE.includes(f.replace(/\.ts$/, "")));
		// Every ineligible entry must name a real connector file.
		expect(eligible.length).toBe(all.length - ISOLATE_INELIGIBLE.length);
		// EVERY bundled connector is isolate-eligible. `os_shell` was the last
		// exception and it is gone: shell execution belongs to the device daemon
		// builtin, which the gateway never compiled. Anything appearing here is a
		// connector that would be silently dropped from the catalog.
		expect(ISOLATE_INELIGIBLE).toEqual([]);
		expect(eligible.length).toBeGreaterThan(15);
		for (const file of eligible) {
			const report = await bundle(join(CONNECTORS_DIR, file));
			let loaded: { kind: string; isClass: boolean };
			try {
				loaded = await loadInIsolate(ivm, report.code);
			} catch (error) {
				throw new Error(`${file} failed to load in an isolate: ${error instanceof Error ? error.message : String(error)}`);
			}
			expect(loaded.kind, `${file} default export`).toMatch(/^(function|object)$/);
		}
	});
});

/**
 * The `personal-agent` example ships a LinkedIn connector that declares LIVE
 * browser feeds and local Data Export (takeout) feeds under ONE connector key,
 * so a person met in the live feed and a person in the CSV export collapse onto
 * the same identity.
 *
 * That made it the case the bundled connectors above never cover: a single
 * `node:fs` import reached transitively by the takeout half rejected the WHOLE
 * bundle, so the LIVE feeds failed with "requires Node builtins [fs, path]"
 * before a browser was ever dispatched (Lobu#3392). Compiling here — with the
 * real build options, the real eligibility gate and a real isolate — is what
 * distinguishes "the parser split is tidy" from "the live lane actually loads".
 *
 * Only mixed live/takeout connectors are asserted eligible. A connector whose
 * every feed reads the filesystem (the twitter/instagram/google takeouts) is
 * legitimately ineligible and declares `requiredCapability: "os.files"`, which
 * no worker serves yet; pinning that here would freeze an unrelated decision.
 */
describe("personal-agent example: mixed live/takeout connector", () => {
	const ENTRY = join(PERSONAL_AGENT_DIR, "linkedin.connector.ts");

	it("compiles to an isolate-eligible bundle so the live feeds can load", async () => {
		const report = await bundle(ENTRY);
		// The gate the runtime itself applies, not a restatement of it.
		expect(findIsolateIneligibleBuiltins(report.code)).toEqual([]);
		// `crypto` is prelude-provided (stableId hashes takeout row identity);
		// `fs`/`path` appearing here is the regression this test exists for.
		expect([...report.builtins.keys()].sort()).toEqual(["crypto"]);
	});

	it("loads and executes in a real isolate, exposing the connector's feeds", async () => {
		const ivm = await loadIsolatedVm();
		const report = await bundle(ENTRY);
		const loaded = await loadInIsolate(ivm, report.code);
		expect(loaded.kind).toBe("function");
		expect(loaded.isClass).toBe(true);
	});

	/**
	 * Construction and feed dispatch inside the guest — not just module init.
	 * A bundle can load and still be useless if the class body touches a
	 * capability the isolate lacks, so this instantiates the connector and reads
	 * the definition the platform reads, in the isolate.
	 */
	it("constructs in the isolate and still declares every live and takeout feed", async () => {
		const ivm = await loadIsolatedVm();
		const report = await bundle(ENTRY);
		const isolate = new ivm.Isolate({ memoryLimit: 256 });
		try {
			const context = await isolate.createContext();
			await context.global.set("global", context.global.derefInto());
			const okEnvelope = { __lobu: 1, ok: true, value: undefined };
			await context.global.set("__host_sync", new ivm.Reference(() => okEnvelope));
			await context.global.set("__host_async", new ivm.Reference(async () => okEnvelope));
			await context.global.set("__host_env_json", "{}");
			const runner = `
(function () {
  var Connector = module.exports.default;
  var def = new Connector().definition;
  return JSON.stringify({ key: def.key, feeds: Object.keys(def.feeds).sort(), actions: Object.keys(def.actions || {}).sort() });
})()`;
			const script = await isolate.compileScript(`${GUEST_PREAMBLE}\n${report.code}\n${runner}`);
			const out = JSON.parse(
				(await script.run(context, { timeout: 10_000, copy: true })) as string,
			) as { key: string; feeds: string[]; actions: string[] };

			expect(out.key).toBe("linkedin");
			// The three live browser feeds — the ones the isolate rejection was
			// blocking — plus the ten takeout feeds, pinned by key because a feed
			// key is the persisted identity a feed row and its checkpoint key on.
			// The split moved the takeout readers into another module, so this is
			// what catches a feed dropped or renamed on the way out.
			expect(out.feeds).toEqual([
				"applied_jobs",
				"companies",
				"company_updates",
				"connections",
				"endorsements",
				"events",
				"home_feed",
				"invitations",
				"jobs",
				"learning",
				"media",
				"messages",
				"profile",
			]);
			expect(out.actions).toContain("prepare_comment");
		} finally {
			isolate.dispose();
		}
	});

	/**
	 * The takeout half is preserved, not silently disabled. Inside the isolate
	 * there is no filesystem, so a takeout feed must FAIL LOUDLY naming the
	 * missing capability — never return zero events, which a scheduler would
	 * record as a clean empty sync and advance right past.
	 */
	it("fails a takeout feed loudly in the isolate instead of syncing it empty", async () => {
		const ivm = await loadIsolatedVm();
		const report = await bundle(ENTRY);
		const isolate = new ivm.Isolate({ memoryLimit: 256 });
		try {
			const context = await isolate.createContext();
			await context.global.set("global", context.global.derefInto());
			const okEnvelope = { __lobu: 1, ok: true, value: undefined };
			await context.global.set("__host_sync", new ivm.Reference(() => okEnvelope));
			await context.global.set("__host_async", new ivm.Reference(async () => okEnvelope));
			await context.global.set("__host_env_json", "{}");
			const runner = `
(function () {
  var Connector = module.exports.default;
  var def = new Connector().definition;
  return def.feeds.connections.sync({
    feedKey: 'connections',
    config: { takeout_dir: '/nonexistent/export' },
    checkpoint: null,
    credentials: null,
    entityIds: [],
  }).then(
    function (r) { return JSON.stringify({ outcome: 'resolved', events: r.events.length }); },
    function (e) { return JSON.stringify({ outcome: 'threw', message: String(e && e.message) }); }
  );
})()`;
			const script = await isolate.compileScript(`${GUEST_PREAMBLE}\n${report.code}\n${runner}`);
			const out = JSON.parse(
				(await script.run(context, { timeout: 10_000, copy: true, promise: true })) as string,
			) as { outcome: string; events?: number; message?: string };

			expect(out.outcome).toBe("threw");
			expect(out.message).toMatch(/filesystem/i);
		} finally {
			isolate.dispose();
		}
	});

	/**
	 * The DEPLOYABLE artifact, not just the repo layout.
	 *
	 * A stored connector source must be a single file: the server writes
	 * `source_code` alone into a temp dir and its `import-guard` plugin rejects
	 * every relative import. So the split modules cannot be uploaded directly —
	 * and neither could the pre-split file, which has imported
	 * `./linkedin-identity.ts` for far longer. `flattenConnectorSourceFromFile`
	 * flattens them; this asserts the flattened text is what the server actually
	 * accepts, so "the tests pass" cannot diverge from "this can be applied".
	 */
	it("flattens to a single-file source the server's own compiler accepts", async () => {
		const flat = await flattenConnectorSourceFromFile(ENTRY);
		// No relative import may survive: each one is a compile error upstream.
		expect(flat).not.toMatch(/from\s+["']\.\.?\//);
		// The REAL compile entry point an uploaded `source_code` goes through:
		// `resolveConnectorInstallSource` calls exactly this, so the build options
		// and the eligibility gate come from the pipeline rather than being
		// restated here (a restated option list is how a test starts passing on
		// config the server no longer uses). It throws
		// `IsolateLaneIneligibleError` itself when a builtin survives.
		const compiled = await compileConnectorSource(flat);
		expect(compiled.compiledCode.length).toBeGreaterThan(0);
		// And the compiled artifact is still isolate-eligible.
		expect(findIsolateIneligibleBuiltins(compiled.compiledCode)).toEqual([]);
	});

	/**
	 * THE regression, stated as the run that failed: a live `home_feed` sync now
	 * gets far enough to ask for the Chrome dispatcher.
	 *
	 * Before the split it never reached its own code — module init threw
	 * "requires Node builtins [fs, path]" and the sync failed BEFORE browser
	 * dispatch, which is precisely what Lobu#3392 recorded. Asserting the error
	 * is now the dispatcher's (no extension is paired in a test isolate) proves
	 * the failure moved past module loading into the live path. It is not a
	 * claim that a real scrape succeeds — that needs a signed-in browser.
	 */
	it("reaches extension dispatch on a live feed instead of failing at module load", async () => {
		const ivm = await loadIsolatedVm();
		const report = await bundle(ENTRY);
		const isolate = new ivm.Isolate({ memoryLimit: 256 });
		try {
			const context = await isolate.createContext();
			await context.global.set("global", context.global.derefInto());
			const okEnvelope = { __lobu: 1, ok: true, value: undefined };
			await context.global.set("__host_sync", new ivm.Reference(() => okEnvelope));
			await context.global.set("__host_async", new ivm.Reference(async () => okEnvelope));
			await context.global.set("__host_env_json", "{}");
			const runner = `
(function () {
  var Connector = module.exports.default;
  var def = new Connector().definition;
  return def.feeds.home_feed.sync({
    feedKey: 'home_feed',
    config: { min_scrolls: 1, max_scrolls: 2 },
    checkpoint: null,
    credentials: null,
    entityIds: [],
    sessionState: null,
  }).then(
    function () { return JSON.stringify({ outcome: 'resolved' }); },
    function (e) { return JSON.stringify({ outcome: 'threw', message: String(e && e.message) }); }
  );
})()`;
			const script = await isolate.compileScript(`${GUEST_PREAMBLE}\n${report.code}\n${runner}`);
			const out = JSON.parse(
				(await script.run(context, { timeout: 10_000, copy: true, promise: true })) as string,
			) as { outcome: string; message?: string };

			expect(out.outcome).toBe("threw");
			// The LIVE path's own precondition, reached and reported...
			expect(out.message).toBe("Browser setup is required for this connection");
			// ...and emphatically not the module-load rejection it used to be.
			expect(out.message).not.toMatch(/Node builtin|node:fs|node:path/);
		} finally {
			isolate.dispose();
		}
	});
});
