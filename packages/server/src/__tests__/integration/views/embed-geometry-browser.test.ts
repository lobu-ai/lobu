/**
 * `<EmbeddedView>` slot geometry in real Chromium. The host lays each child
 * over its slot from the rect the guest reports, so the report has to follow
 * every way a slot moves — not only resizes: content shifting it at a fixed
 * size, a reorder, a transform transition, a nested scroller — and has to say
 * which part is actually shown, so a child never covers the parent's own
 * dialog or the area its scroller clips. jsdom has no layout, so only a real
 * browser can prove this.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-vanilla";
import { compileView, renderViewShell, viewRuntimeScript } from "../../../views/views";

const SOURCE = `import { defineView, EmbeddedView } from "@lobu/views";
export const view = defineView({ key: "geo", attach: [] });
export default function Geo() {
	return (
		<div style={{ position: "relative", height: 900, margin: 0 }}>
			<div id="abs" style={{ position: "absolute", top: 50, left: 0, width: "50%" }}>
				<EmbeddedView id="abs" view="child" minHeight={100} />
			</div>
			<div id="list" style={{ position: "absolute", top: 220, left: 420, width: 300, display: "flex", flexDirection: "column" }}>
				<div id="first" style={{ height: 60 }} />
				<div id="wrap"><EmbeddedView id="list" view="child" minHeight={80} /></div>
			</div>
			<div id="scroller" style={{ position: "absolute", top: 400, left: 420, width: 300, height: 150, overflow: "auto" }}>
				<div style={{ height: 100 }} />
				<EmbeddedView id="inner" view="child" minHeight={100} />
				<div style={{ height: 400 }} />
			</div>
		</div>
	);
}
`;

const FOCUS_PARENT = `import { defineView, EmbeddedView } from "@lobu/views";
export const view = defineView({ key: "outer", attach: [] });
export default function Outer() {
	return (
		<div>
			<button id="before">before</button>
			<EmbeddedView id="kid" view="kid" minHeight={80} />
			<button id="after">after</button>
		</div>
	);
}
`;

const FOCUS_CHILD = `import { defineView } from "@lobu/views";
export const view = defineView({ key: "kid", attach: [] });
export default function Kid() {
	return (
		<div>
			<p>no stop here</p>
			<button id="first">first</button>
			<button id="last">last</button>
		</div>
	);
}
`;

async function shellFor(key: string, source: string): Promise<string> {
	const compiled = await compileView({ entrypoint: "index.tsx", files: { "index.tsx": source } });
	return renderViewShell(
		{
			key,
			name: key,
			description: "",
			source_code: source,
			compiled_code: compiled,
			content_hash: `${key}hash0000000000`.slice(0, 16),
			attach: [],
			params: {},
			actions: {},
			resources: [],
			last_writer: key,
			updated_at: new Date().toISOString(),
		},
		"https://app.example/acme/",
		await viewRuntimeScript()
	);
}

type Rect = { x: number; y: number; width: number; height: number; clip?: Rect };

describe("embedded view slot geometry in a real browser", () => {
	let browser: Browser;
	let shell: string;
	let outerShell: string;
	let kidShell: string;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		const compiled = await compileView({ entrypoint: "index.tsx", files: { "index.tsx": SOURCE } });
		shell = renderViewShell(
			{
				key: "geo",
				name: "geo",
				description: "",
				source_code: SOURCE,
				compiled_code: compiled,
				content_hash: "geohash000000000",
				attach: [],
				params: {},
				actions: {},
				resources: [],
				last_writer: "geo",
				updated_at: new Date().toISOString(),
			},
			"https://app.example/acme/",
			await viewRuntimeScript()
		);
		outerShell = await shellFor("outer", FOCUS_PARENT);
		kidShell = await shellFor("kid", FOCUS_CHILD);
	}, 120000);

	afterAll(async () => {
		await browser?.close();
	});

	it(
		"follows a slot that moves without resizing and reports only what is shown",
		async () => {
			const page = await browser.newPage();
			try {
				await page.setContent("<html><body style='margin:0'></body></html>");
				const steps = await page.evaluate(async ({ shell }) => {
					const last: Record<string, Rect> = {};
					let syncs = 0;
					const f = document.createElement("iframe");
					// allow-same-origin only so the harness can move the guest's DOM;
					// the guest itself never reaches the parent.
					f.setAttribute("sandbox", "allow-scripts allow-same-origin");
					f.style.cssText = "width:800px;height:700px;border:0;display:block";
					f.srcdoc = shell;
					document.body.appendChild(f);
					const send = (msg: unknown) => (f.contentWindow as Window).postMessage(msg, "*");
					window.addEventListener("message", (e: MessageEvent) => {
						if (e.source !== f.contentWindow) return;
						const d = e.data as Record<string, unknown>;
						if (!d || d.jsonrpc !== "2.0" || d.id === undefined || !d.method) return;
						if (d.method === "ui/initialize") {
							send({
								jsonrpc: "2.0",
								id: d.id,
								result: {
									protocolVersion: "2026-01-26",
									hostInfo: { name: "h", version: "1" },
									hostCapabilities: {},
									hostContext: { theme: "light" },
								},
							});
							send({
								jsonrpc: "2.0",
								method: "ui/notifications/tool-input",
								params: { arguments: { key: "geo", scope: {}, params: {} } },
							});
							return;
						}
						if (d.method === "lobu/embeds/sync") {
							syncs += 1;
							const embeds = (d.params as { embeds: Array<{ id: string; rect: Rect }> }).embeds;
							for (const slot of embeds) last[slot.id] = slot.rect;
							send({
								jsonrpc: "2.0",
								id: d.id,
								result: { embeds: embeds.map((s) => ({ id: s.id, status: "mounted" })) },
							});
							return;
						}
						send({ jsonrpc: "2.0", id: d.id, result: {} });
					});
					const settle = () => new Promise((r) => setTimeout(r, 400));
					const until = async (fn: () => boolean, ms = 15000) => {
						const t0 = Date.now();
						while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
					};
					await until(() => !!last.abs && !!last.list && !!last.inner);
					await settle();
					const doc = f.contentDocument as Document;
					const el = (id: string) => doc.getElementById(id) as HTMLElement;
					const snap = (label: string) => ({ label, syncs, ...JSON.parse(JSON.stringify(last)) });
					const out = [snap("start")];

					// Position only: the slot and the body keep their size.
					el("abs").style.top = "250px";
					await settle();
					out.push(snap("moved"));

					// Reorder: the block above moves below; nothing resizes.
					el("list").appendChild(el("first"));
					await settle();
					out.push(snap("reordered"));

					// A transform transition: no layout change at all.
					el("abs").style.transition = "transform 200ms linear";
					el("abs").style.transform = "translateY(100px)";
					await new Promise((r) => setTimeout(r, 700));
					out.push(snap("transformed"));

					// Nested scroller: the slot scrolls into full view.
					el("scroller").scrollTop = 100;
					await settle();
					out.push(snap("scrolled"));

					// A dialog laid over the slot: the child hides, then returns.
					const dialog = doc.createElement("div");
					dialog.setAttribute("role", "dialog");
					dialog.style.cssText = "position:fixed;top:300px;left:0;width:380px;height:200px";
					doc.body.appendChild(dialog);
					await settle();
					out.push(snap("dialog"));
					dialog.remove();
					await settle();
					out.push(snap("dialog-closed"));

					// The frame narrows: a percentage-wide slot follows.
					f.style.width = "600px";
					await settle();
					out.push(snap("narrow"));

					// Idle: nothing changes, nothing is sent.
					const idle = syncs;
					await new Promise((r) => setTimeout(r, 1000));
					out.push({ label: "idle", syncs: syncs - idle });
					f.remove();
					return out;
				}, { shell });
				const at = (label: string) => steps.find((s) => s.label === label) as Record<string, Rect> & { syncs: number };
				const y = (label: string, id: string) => Math.round(at(label)[id].y);

				// Where each slot really is after every kind of move.
				expect({
					start: y("start", "abs"),
					moved: y("moved", "abs"),
					reordered: y("reordered", "list"),
					transformed: y("transformed", "abs"),
					scrolled: y("scrolled", "inner"),
				}).toEqual({ start: 50, moved: 250, reordered: 220, transformed: 350, scrolled: 400 });
				// The inner slot sits at 500 inside a scroller ending at 550: half shown.
				expect(at("start").inner.clip).toMatchObject({ y: 500, height: 50 });
				expect(at("scrolled").inner.clip).toBeUndefined();
				expect(at("dialog").abs.clip).toMatchObject({ width: 0, height: 0 });
				expect(at("dialog").list.clip).toBeUndefined();
				expect(at("dialog-closed").abs.clip).toBeUndefined();
				expect(Math.round(at("narrow").abs.width)).toBe(300);
				expect(at("idle").syncs).toBe(0);
			} finally {
				await page.close();
			}
		},
		120000
	);

	it(
		"moves keyboard focus straight onto the child's first or last control",
		async () => {
			const page = await browser.newPage();
			try {
				await page.setContent("<html><body style='margin:0'></body></html>");
				// A harness host doing what the web host does: the parent's slot asks
				// for focus, the child's frame (out of the tab order) receives it.
				await page.evaluate(
					({ outerShell, kidShell }) => {
						const frame = (name: string, shell: string, tabIndex?: number) => {
							const f = document.createElement("iframe");
							f.name = name;
							f.setAttribute("sandbox", "allow-scripts");
							if (tabIndex !== undefined) f.tabIndex = tabIndex;
							f.style.cssText = "width:400px;height:200px;border:0;display:block";
							f.srcdoc = shell;
							document.body.appendChild(f);
							return f;
						};
						const outer = frame("outer", outerShell);
						const kid = frame("kid", kidShell, -1);
						const w = window as unknown as { kidReady: boolean };
						w.kidReady = false;
						const send = (f: HTMLIFrameElement, msg: unknown) =>
							(f.contentWindow as Window).postMessage(msg, "*");
						const answer = (f: HTMLIFrameElement, id: unknown, result: unknown) =>
							send(f, { jsonrpc: "2.0", id, result });
						window.addEventListener("message", (e: MessageEvent) => {
							const f = e.source === outer.contentWindow ? outer : e.source === kid.contentWindow ? kid : null;
							const d = e.data as Record<string, unknown>;
							if (!f || !d || d.jsonrpc !== "2.0" || !d.method) return;
							if (d.method === "ui/notifications/initialized" && f === kid) w.kidReady = true;
							if (d.id === undefined) return;
							if (d.method === "ui/initialize") {
								answer(f, d.id, {
									protocolVersion: "2026-01-26",
									hostInfo: { name: "h", version: "1" },
									hostCapabilities: {},
									hostContext: { theme: "light" },
								});
								send(f, {
									jsonrpc: "2.0",
									method: "ui/notifications/tool-input",
									params: { arguments: { key: f.name, scope: {}, params: {} } },
								});
								return;
							}
							if (d.method === "lobu/embeds/sync") {
								const embeds = (d.params as { embeds: Array<{ id: string }> }).embeds;
								answer(f, d.id, { embeds: embeds.map((s) => ({ id: s.id, status: "mounted" })) });
								return;
							}
							if (d.method === "lobu/embeds/focus") {
								kid.focus();
								send(kid, {
									jsonrpc: "2.0",
									method: "lobu/notifications/focus-enter",
									params: { direction: (d.params as { direction?: string }).direction },
								});
								answer(f, d.id, {});
								return;
							}
							answer(f, d.id, {});
						});
					},
					{ outerShell, kidShell }
				);
				const frameNamed = async (name: string) => {
					for (let i = 0; i < 100; i++) {
						const f = page.frames().find((x) => x.name() === name);
						if (f) return f;
						await page.waitForTimeout(50);
					}
					throw new Error(`frame ${name} missing`);
				};
				const outer = await frameNamed("outer");
				const kid = await frameNamed("kid");
				await outer.waitForSelector("#after");
				await kid.waitForSelector("#last");
				await page.waitForFunction(() => (window as unknown as { kidReady: boolean }).kidReady);
				await outer.waitForSelector("[data-lobu-embed][data-state=mounted]");
				const focused = async () => ({
					outer: await outer.evaluate(() => document.hasFocus() ? document.activeElement?.id || document.activeElement?.tagName : null),
					kid: await kid.evaluate(() => document.hasFocus() ? document.activeElement?.id || document.activeElement?.tagName : null),
				});
				const settle = () => page.waitForTimeout(300);
				// Focus enters the parent's frame from the page first, as it does when
				// a visitor tabs into it or the host hands focus back to it.
				const start = async (id: string) => {
					await page.evaluate(() => (document.querySelector("iframe[name=outer]") as HTMLIFrameElement).focus());
					await outer.focus(id);
				};

				await start("#after");
				await page.keyboard.press("Shift+Tab");
				await settle();
				const backward = await focused();

				await start("#before");
				await page.keyboard.press("Tab");
				await settle();
				const forward = await focused();

				expect({ forward: forward.kid, backward: backward.kid }).toEqual({ forward: "first", backward: "last" });
			} finally {
				await page.close();
			}
		},
		120000
	);
});
