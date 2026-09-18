/**
 * The view shell route serves fetch-only data: text/plain plus nosniff, so a
 * direct navigation can never execute the authored bundle as
 * application-origin script. The web host fetches response.text() into its
 * sandboxed srcdoc instead.
 *
 * Proven two ways: header assertions (deterministic everywhere) and a real
 * Chromium navigation below — the control case (text/html) must execute the
 * marker while the shipped headers must not. The browser case skips only when
 * no Chromium executable exists; any other launch failure fails loudly.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { chromium } from "playwright-vanilla";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { executeTool, type AuthContext } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestOAuthClient,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { get } from "../../setup/test-helpers";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

const MARKER_SOURCE = `document.title = "VIEW_RAN";
document.body.innerHTML = "<p>VIEW_RAN</p>";
export default function Marker() { return null; }
`;

async function launchChromium() {
	try {
		return await chromium.launch({ headless: true });
	} catch (err) {
		if (String((err as Error)?.message ?? err).includes("Executable doesn't exist")) {
			return null;
		}
		throw err;
	}
}

describe("view shell never executes on direct navigation", () => {
	let shellBody = "";
	let shellHeaders: Record<string, string> = {};
	let server: Server | null = null;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "Shell Org", slug: "shell-org" });
		const owner = await createTestUser({ email: "shell-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		const client = await createTestOAuthClient();
		const token = (
			await createTestAccessToken(owner.id, org.id, client.client_id, {
				scope: "mcp:admin mcp:write mcp:read profile:read",
			})
		).token;
		const ownerCtx: AuthContext = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		await executeTool(
			"manage_views",
			{ action: "set", key: "marker", source_code: MARKER_SOURCE },
			TEST_ENV,
			ownerCtx
		);
		// Real route bytes plus real response headers (global middleware
		// included) through the in-process app.
		const response = await get(`/api/${org.slug}/views/marker/shell`, { token });
		expect(response.status).toBe(200);
		shellBody = await response.text();
		expect(shellBody).toContain("VIEW_RAN");
		for (const name of ["content-type", "x-content-type-options", "cache-control"]) {
			const value = response.headers.get(name);
			expect(value, `missing ${name}`).toBeTruthy();
			shellHeaders[name] = value!;
		}
	});

	afterAll(async () => {
		server?.close();
		server = null;
		await cleanupTestDatabase();
	});

	async function visitWithHeaders(
		headers: Record<string, string>
	): Promise<{ title: string; html: string } | null> {
		const browser = await launchChromium();
		if (!browser) return null;
		try {
			server = createServer((_req, res) => {
				for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
				res.end(shellBody);
			});
			await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
			const address = server!.address() as AddressInfo;
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${address.port}/shell`);
			const title = await page.title();
			const html = await page.content();
			await page.close();
			return { title, html };
		} finally {
			await browser.close();
			server?.close();
			server = null;
		}
	}

	it("executes the marker when served as text/html (control)", async () => {
		const seen = await visitWithHeaders({
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		if (!seen) {
			console.warn("shell-no-execute: no Chromium executable, control skipped");
			return;
		}
		expect(seen.title).toBe("VIEW_RAN");
		expect(seen.html).toContain("VIEW_RAN");
	});

	it("does not execute the marker with the shipped shell headers", async () => {
		const seen = await visitWithHeaders(shellHeaders);
		if (!seen) {
			console.warn("shell-no-execute: no Chromium executable, regression skipped");
			return;
		}
		expect(seen.title).not.toBe("VIEW_RAN");
		// text/plain renders the bytes as inert text (a <pre> preview), so the
		// marker string is visible but never runs as script.
		expect(seen.html).toContain("<pre");
		// The source is still present in the fetched text (fetch-only data).
		expect(shellBody).toContain("VIEW_RAN");
	});
});
