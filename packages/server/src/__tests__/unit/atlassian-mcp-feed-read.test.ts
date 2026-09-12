import { beforeAll, describe, expect, it, mock } from "bun:test";

const calls: Array<{
	tool: string;
	args: Record<string, unknown>;
}> = [];

let responseMode: "normal" | "ambiguous-sites" | "malformed" | "missing-cursor" | "missing-exhaustion" = "normal";

mock.module("../../mcp-proxy/client", () => ({
	discoverTools: async () => [],
	assertSafeUrl: () => undefined,
	getMcpOAuthRequestedScopes: () => [],
	selectMcpOAuthClientAuthMethod: () => "none",
	registerMcpOAuthClient: async () => {
		throw new Error("unused in Atlassian feed read test");
	},
	probeMcpServer: async () => {
		throw new Error("unused in Atlassian feed read test");
	},
	callTool: async (
		_connectorKey: string,
		_config: unknown,
		_orgId: string,
		toolName: string,
		toolArgs: Record<string, unknown>,
	) => {
		calls.push({ tool: toolName, args: toolArgs });
		if (toolName === "getAccessibleAtlassianResources") {
			return {
				isError: false,
				content: [
					{
						type: "text",
						text: JSON.stringify(
							responseMode === "ambiguous-sites"
								? [
										{ id: "cloud-1", url: "https://one.atlassian.net" },
										{ id: "cloud-2", url: "https://two.atlassian.net" },
									]
								: [{ id: "cloud-1", url: "https://acme.atlassian.net" }],
						),
					},
				],
			};
		}
		if (responseMode === "malformed" || responseMode === "missing-cursor" || responseMode === "missing-exhaustion") {
			const text = responseMode === "malformed"
				? "Try again later"
				: JSON.stringify(responseMode === "missing-cursor" ? { issues: [], isLast: false } : { issues: [] });
			return { content: [{ type: "text", text }] };
		}
		const token = typeof toolArgs.nextPageToken === "string" ? toolArgs.nextPageToken : undefined;
		if (!token) {
			return {
				isError: false,
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{ id: "1", key: "KAN-1", summary: "one", updated: "2026-01-01T12:00:00Z" },
								{ id: "2", key: "KAN-2", summary: "two", updated: "2026-01-01T12:00:00Z" },
							],
							nextPageToken: "page-2",
							isLast: false,
						}),
					},
				],
			};
		}
		return {
			isError: false,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						issues: [
							{ id: "3", key: "KAN-3", summary: "three" },
							{ id: "4", key: "KAN-4", summary: "four" },
						],
						isLast: true,
					}),
				},
			],
		};
	},
}));

let readAtlassianMcpFeed: typeof import("../../operations/atlassian-mcp-feed").readAtlassianMcpFeed;

beforeAll(async () => {
	({ readAtlassianMcpFeed } = await import("../../operations/atlassian-mcp-feed"));
});

describe("readAtlassianMcpFeed", () => {
  const windowParams = {
    organizationId: "org-window", connectionId: 1, connectorKey: "mcp.atlassian",
    mcpConfig: { upstream_url: "https://mcp.atlassian.com/v1/mcp", tool_prefix: "atlassian" },
    feedConfig: { cloud_id: "cloud-window" }, connectionConfig: {}, baseQuery: "project = KAN",
    window: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
  };
  it.each(["malformed", "missing-cursor", "missing-exhaustion"] as const)("rejects %s window results", async (mode) => {
    responseMode = mode;
    await expect(readAtlassianMcpFeed(windowParams)).rejects.toThrow(/page|cursor|malformed/i);
  });
  it("binds fixed Jira bounds and returns source coverage", async () => {
    responseMode = "normal";
    calls.length = 0;
    const result = await readAtlassianMcpFeed(windowParams);
    expect(result.window).toEqual({ ...windowParams.window, axis: "updated_at" });
    expect(calls[0].args.jql).toContain(`updated >= ${Date.parse(windowParams.window.start)}`);
    expect(calls[0].args.jql).toContain(`updated < ${Date.parse(windowParams.window.end)}`);
    expect(result.hasMore).toBe(true);
  });
	it("returns nextPageToken and passes it to the next source request", async () => {
		calls.length = 0;
		responseMode = "normal";
		const first = await readAtlassianMcpFeed({
			organizationId: "org-1",
			connectionId: 505,
			connectorKey: "mcp.mcp-atlassian-com",
			mcpConfig: {
				upstream_url: "https://mcp.atlassian.com/v1/mcp",
				tool_prefix: "mcp_atlassian_com",
			},
			feedConfig: { cloud_id: "cloud-1" },
			connectionConfig: {},
			baseQuery: "project = KAN",
			limit: 2,
		});

		expect(calls.map((call) => call.tool)).toEqual(["searchJiraIssuesUsingJql"]);
		expect(calls[0].args).toMatchObject({
			cloudId: "cloud-1",
			jql: "project = KAN ORDER BY updated DESC",
			maxResults: 2,
		});
		expect(first.rows.map((row) => row.key)).toEqual(["KAN-1", "KAN-2"]);
		expect(first.nextCursor).toBe("page-2");

		const second = await readAtlassianMcpFeed({
			organizationId: "org-1",
			connectionId: 505,
			connectorKey: "mcp.mcp-atlassian-com",
			mcpConfig: {
				upstream_url: "https://mcp.atlassian.com/v1/mcp",
				tool_prefix: "mcp_atlassian_com",
			},
			feedConfig: { cloud_id: "cloud-1" },
			connectionConfig: {},
			baseQuery: "project = KAN",
			cursor: first.nextCursor,
			limit: 2,
		});
		expect(calls[1].args.nextPageToken).toBe("page-2");
		expect(second.rows.map((row) => row.key)).toEqual(["KAN-3", "KAN-4"]);
		expect(second.hasMore).toBe(false);
	});

	it("rejects an ambiguous multi-site grant", async () => {
		calls.length = 0;
		responseMode = "ambiguous-sites";
		await expect(
			readAtlassianMcpFeed({
				organizationId: "org-1",
				connectionId: 505,
				connectorKey: "mcp.mcp-atlassian-com",
				mcpConfig: {
					upstream_url: "https://mcp.atlassian.com/v1/mcp",
					tool_prefix: "mcp_atlassian_com",
				},
				feedConfig: {},
				connectionConfig: {},
				baseQuery: "project = KAN",
			}),
		).rejects.toThrow("multiple accessible Jira sites");
	});

	it("rejects offsets so callers cannot force a provider page re-walk", async () => {
		calls.length = 0;
		responseMode = "normal";
		await expect(
			readAtlassianMcpFeed({
				organizationId: "org-1",
				connectionId: 505,
				connectorKey: "mcp.mcp-atlassian-com",
				mcpConfig: {
					upstream_url: "https://mcp.atlassian.com/v1/mcp",
					tool_prefix: "mcp_atlassian_com",
				},
				feedConfig: { cloud_id: "cloud-1", max_results: 1 },
				connectionConfig: {},
				baseQuery: "project = KAN",
				offset: 20,
				limit: 1,
			}),
		).rejects.toThrow("returned cursor");
		expect(calls).toHaveLength(0);
	});
});
