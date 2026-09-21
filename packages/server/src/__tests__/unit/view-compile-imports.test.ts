/**
 * `compileView` bundles UNTRUSTED author source with esbuild. The compiler runs
 * inside the server process with its filesystem, so the import graph is a
 * security boundary, not a convenience: anything esbuild resolves is inlined
 * verbatim into a browser bundle the whole org can read back over the shell
 * route.
 *
 * The contract these pin: exactly the React runtime and `@lobu/views` resolve.
 * Every other specifier — a relative file, a parent-directory traversal, an
 * absolute path, an arbitrary npm dependency, a node builtin — is rejected at
 * resolve time with a message naming the specifier, never bundled and never
 * silently emptied.
 */
import { describe, expect, it } from "bun:test";
import { compileView } from "../../views/views";
import { ToolUserError } from "../../utils/errors";

async function compileError(source: string): Promise<string> {
	try {
		await compileView(source);
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		const message = (err as ToolUserError).message;
		// The DENIAL must come from the allowlist plugin, not from esbuild
		// merely failing to find the file. Both currently reject, so without
		// this the plugin could rot into dead code and the suite stay green:
		// the only thing left would be the absent `resolveDir`, and a later
		// edit restoring it for any reason would silently reopen the hole.
		expect(message).toContain("lobu-view-runtime");
		expect(message).toContain("is not allowed in a view");
		return message;
	}
	throw new Error("compileView resolved, but the import should be rejected");
}

describe("compileView import allowlist", () => {
	it("rejects a relative import of the server's own package.json", async () => {
		const message = await compileError(
			`import pkg from './package.json';\nexport default function V() { return pkg.name; }`,
		);
		expect(message).toContain("./package.json");
		expect(message).not.toContain("@lobu/server");
	});

	it("rejects a parent-directory traversal", async () => {
		const message = await compileError(
			`import p from '../../package.json';\nexport default function V() { return p.name; }`,
		);
		expect(message).toContain("../../package.json");
		expect(message).not.toContain("lobu-monorepo");
	});

	it("rejects an absolute filesystem path", async () => {
		const message = await compileError(
			`import p from '${process.cwd()}/package.json';\nexport default function V() { return p.name; }`,
		);
		expect(message).toContain("package.json");
	});

	it("rejects a server source module even with an explicit extension", async () => {
		const message = await compileError(
			`import { VIEW_KEY_RE } from './src/views/views.ts';\nexport default function V() { return String(VIEW_KEY_RE); }`,
		);
		expect(message).toContain("./src/views/views.ts");
	});

	it("rejects an arbitrary npm dependency of the server", async () => {
		const message = await compileError(
			`import { Hono } from 'hono';\nexport default function V() { return typeof Hono; }`,
		);
		expect(message).toContain("hono");
	});

	it("rejects a node builtin", async () => {
		const message = await compileError(
			`import fs from 'node:fs';\nexport default function V() { return typeof fs; }`,
		);
		expect(message).toContain("node:fs");
	});

	// The allowlist matches the specifier EXACTLY. A subpath of an allowed
	// package is not allowed: `react/package.json` and
	// `@lobu/views/../../../package.json` would otherwise re-open the same file
	// read through a name that merely starts with a permitted prefix.
	it("rejects subpaths and traversals through an allowed package", async () => {
		for (const specifier of [
			"react/package.json",
			"@lobu/views/package.json",
			"@lobu/views/../../../package.json",
			"./node_modules/hono/package.json",
		]) {
			const message = await compileError(
				`import x from '${specifier}';\nexport default function V() { return x; }`,
			);
			expect(message).toContain(specifier);
		}
	});

	it("still bundles the allowed React and @lobu/views runtime", async () => {
		const compiled = await compileView(
			`import { useState } from 'react';
import { defineView, useQuery } from '@lobu/views';
export const view = defineView({ key: 'ok', attach: [{ workspace: true }] });
export default function V() {
  const [n] = useState(1);
  useQuery(null);
  return n;
}`,
		);
		expect(compiled.length).toBeGreaterThan(0);
	});
});
