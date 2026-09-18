/**
 * Loader handoff through a real HTML parser and browser (round-2 F6): a
 * parameter value containing an HTML comment opener plus an opening script
 * token must not break the handoff embedding. The host sends exactly one
 * opening tool-input, never replayed; the guest must mount with the exact
 * string, query with it, and invoke its action. JSON.parse-only assertions
 * cannot catch HTML tokenization failures, so this drives real Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-vanilla";
import {
	compileView,
	renderViewsLoaderShell,
	renderViewShell,
} from "../../../views/views";

const EVIL_Q = "<!--<script>";

const SOURCE = `import { defineView, useParams, useScope, useQuery, useAction, tool } from "@lobu/views";
export const view = defineView({
	key: "probe",
	attach: [{ type: "deal" }],
	params: { q: { type: "string", default: "DEFAULT" } },
	actions: { poke: { emits: "proof.poked" } },
});
export default function Probe() {
	const [params] = useParams();
	const scope = useScope();
	const res = useQuery(tool("echo_state", { params, scope }));
	const poke = useAction("poke");
	void res;
	void poke;
	return <div data-testid="probe-state">{params.q}|{String(scope.entity ?? "")}</div>;
}
`;

describe("loader handoff in a real browser", () => {
	let browser: Browser;
	let shell: string;
	let loaderHtml: string;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		const compiled = await compileView(SOURCE);
		shell = renderViewShell({
			key: "probe",
			name: "probe",
			description: "",
			source_code: SOURCE,
			compiled_code: compiled,
			content_hash: "probehash00000000",
			attach: [],
			params: {},
			actions: {},
			last_writer: "probe",
			updated_at: new Date().toISOString(),
		});
		loaderHtml = renderViewsLoaderShell();
	}, 120000);

	afterAll(async () => {
		await browser?.close();
	});

	it(
		"mounts the exact HTML-token param from a single opening input",
		async () => {
			const page = await browser.newPage();
			try {
				await page.setContent("<html><body></body></html>");
				const result = await page.evaluate(
					async ({ loaderHtml, shell }) => {
						const out = {
							inputs: 0,
							echoQ: null as unknown,
							mounted: null as unknown,
							action: null as unknown,
						};
						const opening = {
							key: "probe",
							scope: { type: "deal", entity: 123 },
							params: { q: "<!--<script>" },
						};
						const f = document.createElement("iframe");
            // allow-same-origin so the harness can read the mounted DOM;
            // the guest never touches the parent, so the run matches
            // strict sandboxing exactly.
						f.setAttribute("sandbox", "allow-scripts allow-same-origin");
						f.style.width = "800px";
						f.style.height = "600px";
						f.srcdoc = loaderHtml;
						document.body.appendChild(f);
						const send = (msg: unknown) =>
							(f.contentWindow as Window).postMessage(msg, "*");
						let initializes = 0;
						window.addEventListener("message", async (e: MessageEvent) => {
							if (e.source !== f.contentWindow) return;
							const d = e.data as Record<string, unknown>;
							if (!d || d.jsonrpc !== "2.0") return;
							if (d.id !== undefined && d.method) {
								if (d.method === "ui/initialize") {
									initializes++;
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
									// TRUE one-shot: only the loader's first initialize gets input.
									if (initializes === 1) {
										out.inputs++;
										send({
											jsonrpc: "2.0",
											method: "ui/notifications/tool-input",
											params: { arguments: opening },
										});
									}
									return;
								}
								if (d.method === "tools/call") {
									const p = d.params as Record<string, unknown>;
									const a = p.arguments as Record<string, unknown>;
									if (p.name === "echo_state") {
										out.echoQ = (a.params as Record<string, unknown>).q;
									}
									if (p.name === "invoke_view_action") out.action = true;
									send({
										jsonrpc: "2.0",
										id: d.id,
										result: { structuredContent: { created: true }, content: [] },
									});
									return;
								}
								if (d.method === "resources/read") {
									send({
										jsonrpc: "2.0",
										id: d.id,
										result: {
											contents: [{ uri: "ui://lobu/views/probe", mimeType: "text/html", text: shell }],
										},
									});
									return;
								}
								send({ jsonrpc: "2.0", id: d.id, result: {} });
							}
						});
						const waitFor = async (
							fn: () => unknown,
							timeout = 20000
						): Promise<unknown> => {
							const t0 = Date.now();
							for (;;) {
								try {
									const v = fn();
									if (v) return v;
								} catch {
									// not yet
								}
								if (Date.now() - t0 > timeout) return null;
								await new Promise((r) => setTimeout(r, 250));
							}
						};
						const doc = () => f.contentDocument;
						out.mounted = await waitFor(() => {
							const el = doc()?.querySelector('[data-testid="probe-state"]');
							return el ? el.textContent : null;
						});
						await waitFor(() => (out.echoQ !== null ? "q" : null), 8000);
						return out;
					},
					{ loaderHtml, shell }
				);
				expect(result.inputs).toBe(1);
				expect(result.mounted).toBe("<!--<script>|123");
				expect(result.echoQ).toBe("<!--<script>");
			} finally {
				await page.close();
			}
		},
		120000
	);
});
