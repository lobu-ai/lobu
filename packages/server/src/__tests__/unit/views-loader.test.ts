/**
 * Generic views loader shell: the host-readiness announcement and the
 * bundle-message source gate, proven with fake host frames.
 */
import { describe, expect, it } from "bun:test";
import { renderViewsLoaderShell } from "../../views/views";

function runLoader() {
	const html = renderViewsLoaderShell();
	const script = html.split("<script>")[1]?.split("</script>")[0];
	if (!script) throw new Error("loader shell has no inline script");
	const listeners: Record<string, Array<(event: unknown) => void>> = {};
	const announced: unknown[] = [];
	const hostParent = {
		name: "host",
		postMessage: (message: unknown) => {
			announced.push(message);
		},
	};
	const written: string[] = [];
	const fakeWindow = {
		parent: hostParent,
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			(listeners[type] ??= []).push(fn);
		},
	};
	const fakeDocument = {
		readyState: "loading",
		open: () => {},
		write: (chunk: string) => {
			written.push(chunk);
		},
		close: () => {},
	};
	new Function("window", "document", script)(fakeWindow, fakeDocument);
	return { listeners, announced, hostParent, written };
}

describe("views loader shell", () => {
	it("announces readiness to the host on load", () => {
		const { listeners, announced } = runLoader();
		for (const fn of listeners.load ?? []) fn();
		expect(announced).toEqual([{ type: "lobu:views-loader-ready", version: 1 }]);
	});

	it("ignores bundle messages from any source but the host frame", () => {
		const { listeners, hostParent, written } = runLoader();
		const impostor = { name: "impostor", postMessage: () => {} };
		for (const fn of listeners.message ?? [])
			fn({ source: impostor, data: { type: "lobu:views-bundle", html: "<p>evil</p>" } });
		expect(written).toEqual([]);
		for (const fn of listeners.message ?? [])
			fn({ source: hostParent, data: { type: "lobu:views-bundle", html: "<p>ok</p>" } });
		expect(written).toEqual(["<p>ok</p>"]);
	});
});
