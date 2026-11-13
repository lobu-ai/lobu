import { describe, expect, it } from "vitest";
import {
	compileConnectorForIsolateFromFile,
	findBundledConnectorFile,
} from "../../utils/connector-catalog";

/**
 * A connector that drives a page injects a program by serialising a function
 * with `Function.prototype.toString()` and evaluating `(<source>)()` there.
 * That works only while every binding the function needs lives INSIDE it.
 *
 * The connector's own suite already proves the SOURCE function is
 * self-contained. This proves the shipped artifact is, which is a different
 * claim: the gateway ships the COMPILED bundle, and bundling is free to hoist
 * a shared helper to module scope and reference it from inside the function.
 * esbuild does exactly that when it downlevels object spread or optional
 * chaining (`__spreadValues`, `__objRest`). The serialised text would then
 * name an identifier the page cannot resolve, and the run would die with a
 * ReferenceError at injection — with nothing failing at build or type-check
 * time, and no test between the two catching it.
 */
const INJECTED_PROGRAMS = [
	{
		connectorKey: "whatsapp.web",
		programFn: "whatsAppWebAdapterProgram",
		installs: "__owlettoWhatsAppAdapterV1",
	},
];

/** Slice a top-level function declaration out of compiled bundle text. */
function extractFunction(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	expect(start, `${name} is not a top-level function in the bundle`).toBeGreaterThan(-1);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	throw new Error(`unbalanced braces reading ${name}`);
}

/** The page globals the program may rely on. Anything else is a free binding. */
function stubPage(installed: Record<string, unknown>) {
	return {
		globalThis: installed,
		document: {
			querySelector: () => null,
			querySelectorAll: () => [],
			addEventListener: () => {},
		},
		window: { require: () => null, addEventListener: () => {} },
		location: { origin: "https://web.whatsapp.com" },
		setTimeout: () => 0,
		clearTimeout: () => {},
		console: { log: () => {}, warn: () => {}, error: () => {} },
	};
}

describe("injected page programs survive bundling", () => {
	for (const program of INJECTED_PROGRAMS) {
		it(`${program.connectorKey}: the compiled ${program.programFn} still installs`, async () => {
			const file = findBundledConnectorFile(program.connectorKey);
			expect(file, `${program.connectorKey} must ship in the image`).not.toBeNull();
			const compiled = await compileConnectorForIsolateFromFile(file as string);

			// A hoisted downlevel helper is the specific way bundling breaks this.
			const source = extractFunction(compiled, program.programFn);
			for (const helper of ["__spreadValues", "__spreadProps", "__objRest", "__async"]) {
				expect(
					source.includes(helper),
					`serialised ${program.programFn} references bundle-scope ${helper}`,
				).toBe(false);
			}

			// Evaluate it the way the page does. A binding that escaped to module
			// scope throws ReferenceError here instead of in a live browser.
			const installed: Record<string, unknown> = {};
			const page = stubPage(installed);
			const names = Object.keys(page);
			const run = new Function(
				...names,
				`"use strict"; return (${source})("synthetic-version");`,
			) as (...args: unknown[]) => unknown;
			run(...names.map((name) => page[name as keyof typeof page]));

			expect(Object.keys(installed)).toContain(program.installs);
			expect(
				typeof (installed[program.installs] as { invoke?: unknown } | undefined)?.invoke,
			).toBe("function");
		});
	}
});
