import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright-vanilla";
import { afterEach, beforeEach, expect, it } from "vitest";
import { generateSecureToken, hashToken } from "../../auth/oauth/utils";
import { upsertEntityApprovalPolicy } from "../../authz/entity-policy";
import { createConnectorOperationRun } from "../../runs/queue-service";
import { requestSourceAttribution } from "../../worker-api/device-source-attribution";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestConnection, seedOwnerContext } from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";

declare const chrome: {
	storage: { local: { set(settings: Record<string, string>): Promise<void> } };
	tabs: {
		create(options: { url: string; active: boolean }): Promise<{ id: number }>;
		query(
			query: Record<string, unknown>,
		): Promise<Array<{ id: number; url?: string }>>;
		get(id: number): Promise<{ id: number }>;
	};
};

beforeEach(cleanupTestDatabase);
afterEach(cleanupTestDatabase);

// Real Chromium -> HTTP -> production gateway handlers -> test Postgres.
// Only the target website is a fixture. Worker registration, authentication,
// manifest ingestion, routing, ownership injection and completion are real.
it("persists pinned browser actions, shares agent tabs, and protects user tabs", async () => {
	const sql = getTestDb();
	const { org, user } = await seedOwnerContext();
	await upsertEntityApprovalPolicy(org.id, {
		resourceClass: "connector_action", connectorKey: "chrome", effects: { execute: "auto" },
	});
	// Device connections auto-wire only in their owner's personal org, which is
	// where a real paired browser lands.
	await sql`UPDATE organization SET metadata = ${sql.json({ personal_org_for_user_id: user.id })} WHERE id = ${org.id}`;
	const temporary = await mkdtemp(join(tmpdir(), "lobu-chrome-gateway-test-"));
	const browsers: BrowserContext[] = [];
	const transportErrors: string[] = [];
	const server = createServer(async (req, res) => {
		try {
			if (req.url?.startsWith("/fixture/")) {
				res.setHeader("Content-Type", "text/html");
				res.end(
					'<!doctype html><title>Gateway browser fixture</title><button id="increment" onclick="this.textContent=++window.clicks">Increment</button><script>window.clicks=0</script>',
				);
				return;
			}
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const response = await post(req.url!, {
				body: raw ? JSON.parse(raw) : undefined,
				headers:
					typeof req.headers.authorization === "string"
						? { Authorization: req.headers.authorization }
						: {},
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(await response.text());
		} catch (error) {
			transportErrors.push(String(error));
			res.writeHead(500);
			res.end("{}");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No fixture port");
	const origin = `http://127.0.0.1:${address.port}`;
	async function until<T>(
		read: () => Promise<T | undefined>,
		description: string,
	): Promise<T> {
		const deadline = Date.now() + 40000;
		while (Date.now() < deadline) {
			const value = await read();
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(
			`Timed out: ${description}; transport errors: ${transportErrors.join("; ")}`,
		);
	}
	try {
		const extension = join(temporary, "extension");
		await cp(
			fileURLToPath(
				new URL("../../../../owletto/apps/chrome", import.meta.url),
			),
			extension,
			{ recursive: true },
		);
		const manifest = JSON.parse(
			await readFile(join(extension, "manifest.json"), "utf8"),
		);
		manifest.host_permissions = [`${origin}/*`];
		await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
		await writeFile(
			join(extension, "probe.html"),
			"<!doctype html><title>Synthetic extension controller</title>",
		);
		async function pair(suffix: string) {
			const workerId = `synthetic-browser-${suffix}-${generateSecureToken(4)}`;
			const token = `owl_pat_${generateSecureToken(24)}`;
			await sql`
        INSERT INTO personal_access_tokens (token_hash, token_prefix, user_id, organization_id, name, scope, worker_id, created_at, updated_at)
        VALUES (${hashToken(token)}, ${token.slice(0, 12)}, ${user.id}, ${org.id}, 'Synthetic browser test', 'device_worker:run', ${workerId}, NOW(), NOW())
      `;
			const browser = await chromium.launchPersistentContext(
				join(temporary, suffix),
				{
					channel: "chromium",
					headless: true,
					args: [
						`--disable-extensions-except=${extension}`,
						`--load-extension=${extension}`,
					],
				},
			);
			browsers.push(browser);
			const worker =
				browser.serviceWorkers()[0] ??
				(await browser.waitForEvent("serviceworker"));
			const control = await browser.newPage();
			await control.goto(new URL("./probe.html", worker.url()).href);
			await control.evaluate(
				async (settings) => chrome.storage.local.set(settings),
				{
					"owletto.gatewayUrl": origin,
					"owletto.workerId": workerId,
					"owletto.accessToken": token,
				},
			);
			const device = await until(async () => {
				const [row] = await sql<
					{ id: string }[]
				>`SELECT d.id FROM device_workers d
          WHERE d.worker_id = ${workerId} AND d.connector_manifests ? 'chrome'
            AND EXISTS (
              SELECT 1 FROM connector_definitions cd
              WHERE cd.organization_id = ${org.id} AND cd.key = 'chrome' AND cd.status = 'active'
                AND cd.version = d.connector_manifests->'chrome'->'manifest'->>'version'
            )`;
				return row;
			}, `${suffix} authenticated registration and manifest ingestion`);
			return { browser, control, workerId, deviceId: device.id };
		}
		const selected = await pair("selected");
		const other = await pair("other");
		await sql`INSERT INTO agents (id, organization_id, name) VALUES ('synthetic-controller', ${org.id}, 'Research agent')`;
		await sql`INSERT INTO oauth_clients (id, client_name, redirect_uris)
      VALUES ('synthetic-mcp-client', 'Registered MCP client', ARRAY['https://client.example/callback'])`;
		await sql`UPDATE device_workers SET label = 'Selected browser' WHERE id = ${selected.deviceId}::uuid`;
		let sourceAttribution = requestSourceAttribution({
			isAuthenticated: true,
			tokenType: "oauth",
			agentId: "synthetic-controller",
			clientId: "synthetic-mcp-client",
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "chrome",
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		let connectionId = connection.id;
		const context = {
			title: "Lobu · Gateway fixture",
			kind: "run" as const,
			flow_id: "synthetic-flow-a",
		};
		async function action(
			operationKey: string,
			operationInput: Record<string, unknown>,
			flowId = context.flow_id,
		) {
			const created = await createConnectorOperationRun({
				organizationId: org.id,
				connectionId,
				connectorKey: "chrome",
				operationKey,
				operationInput,
				approvalMode: "device",
				createdByUserId: user.id,
				policyPrincipalKind: "user",
				runMetadata: { source_attribution: sourceAttribution },
				sdkBrowserContext: { ...context, flow_id: flowId },
			});
			return until(async () => {
				const [row] = await sql<
					{
						status: string;
						action_output: Record<string, unknown>;
						error_message: string | null;
						claimed_by: string;
					}[]
				>`
          SELECT status, action_output, error_message, claimed_by FROM runs WHERE id = ${created.runId}
        `;
				return row && ["completed", "failed"].includes(row.status)
					? row
					: undefined;
			}, `${operationKey} durable completion`);
		}
		const unpinned = await action("navigate", {
			url: `${origin}/fixture/page`,
		});
		expect(unpinned.status).toBe("failed");
		expect(unpinned.error_message).toMatch(/not paired to a specific device/);
		// Reconcile pins a connection to each registered browser on its own poll
		// cycle, so wait for the selected one rather than reading once.
		const paired = await until(async () => {
			const [row] = await sql<
				{ id: number }[]
			>`SELECT id FROM connections WHERE organization_id = ${org.id} AND connector_key = 'chrome' AND device_worker_id = ${selected.deviceId}::uuid AND status = 'active'`;
			return row;
		}, "a connection pinned to the selected browser");
		connectionId = Number(paired.id);
		const opened = await action("navigate", {
			url: `${origin}/fixture/page`,
			wait_for_load: true,
		});
		expect(opened.status, opened.error_message ?? "navigate failed").toBe(
			"completed",
		);
		expect(opened.claimed_by).toBe(selected.workerId);
		const tabId = opened.action_output.tab_id;
		expect(Number.isInteger(tabId)).toBe(true);
		const evaluated = await action("evaluate", {
			tab_id: tabId,
			expression: 'document.querySelector("#increment").click(); window.clicks',
		});
		expect(evaluated.status, evaluated.error_message ?? "evaluate failed").toBe(
			"completed",
		);
		expect(evaluated.action_output.value).toBe(1);
		// Agent tabs are shared: another session may act in this one.
		const shared = await action(
			"evaluate",
			{ tab_id: tabId, expression: "window.clicks" },
			"synthetic-flow-b",
		);
		expect(shared.status, shared.error_message ?? "evaluate failed").toBe(
			"completed",
		);
		expect(shared.action_output.value).toBe(1);
		// The real worker receives server-owned provenance and the real sidepanel
		// shows it while an admitted tool is executing, then clears on completion.
		const panel = await selected.browser.newPage();
		await panel.goto(new URL("./sidepanel.html", selected.control.url()).href);
		const inFlight = action("evaluate", {
			tab_id: tabId,
			expression: "new Promise(resolve => setTimeout(() => resolve(window.clicks), 5000))",
			await_promise: true,
			source_attribution: { agent_name: "Impersonated owner" },
		});
		await until(async () => {
			const text = await panel.locator("#control-activity").textContent();
			return text?.includes("Managed agent: Research agent") ? text : undefined;
		}, "authenticated agent visible in the actual extension sidepanel");
		const activeText = await panel.locator("#control-activity").textContent();
		expect(activeText).toContain("via Registered MCP client");
		expect(activeText).toContain("Executing on Selected browser");
		expect(activeText).not.toContain("Impersonated owner");
		expect((await inFlight).status).toBe("completed");
		await until(async () => await panel.locator("#control-activity").isHidden() ? true : undefined, "completion clears the control indicator");
		sourceAttribution = requestSourceAttribution({
			isAuthenticated: true,
			tokenType: "oauth",
			clientId: "synthetic-mcp-client",
		});
		const clientFlight = action("evaluate", {
			tab_id: tabId, expression: "new Promise(resolve => setTimeout(() => resolve(1), 3000))", await_promise: true,
		});
		await until(async () => (await panel.locator("#control-activity").textContent())?.includes("MCP client: Registered MCP client") ? true : undefined, "MCP-only requester has its own label");
		expect((await clientFlight).status).toBe("completed");
		await panel.close();
		// A tab the user opened is readable but not mutable without the grant,
		// and a caller cannot launder it through an activation id of its own.
		const userTab = await selected.control.evaluate(
			(url) => chrome.tabs.create({ url, active: false }).then((tab) => tab.id),
			`${origin}/fixture/page`,
		);
		const denied = await action("evaluate", {
			tab_id: userTab,
			expression: "window.clicks=999",
			activation_tab_id: userTab,
		});
		expect(denied.status).toBe("failed");
		expect(denied.error_message).toMatch(/user's tab/);
		expect(
			await other.control.evaluate(() =>
				chrome.tabs
					.query({})
					.then((tabs) => tabs.some((tab) => tab.url?.includes("/fixture/"))),
			),
		).toBe(false);
		const closed = await action("close_tab", { tab_id: tabId });
		expect(closed.status).toBe("completed");
		expect(
			await selected.control.evaluate(
				(id) =>
					chrome.tabs.get(id).then(
						() => true,
						() => false,
					),
				tabId as number,
			),
		).toBe(false);
		expect(transportErrors).toEqual([]);
	} finally {
		for (const browser of browsers) await browser.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(temporary, { recursive: true, force: true });
	}
}, 180000);
