import { describe, expect, it } from "bun:test";
import { scopeDenialMessage } from "../../tools/access-control";

describe("scopeDenialMessage", () => {
	it("sends an owner through the app's step-up, then reconnect, then the web app", () => {
		expect(
			scopeDenialMessage({
				subject: "manage_agents.delete",
				requiredAccess: "admin",
				memberRole: "owner",
				tokenType: "oauth",
				workspace: "example-org",
			}),
		).toBe(
			"manage_agents.delete needs admin access, which this connection to example-org doesn't have (tokens aren't upgraded on refresh). As an owner of example-org, retry the action so this app asks you to grant more access; if it doesn't, disconnect and reconnect Lobu in this app's connector settings and choose 'Administer workspaces' if the consent screen offers it. If it isn't offered, this app doesn't request admin access; do this from the Lobu web app or CLI instead.",
		);
	});

	it("tells a member that admin needs a role, and never offers the admin consent level", () => {
		const message = scopeDenialMessage({
			subject: "manage_agents.delete",
			requiredAccess: "admin",
			memberRole: "member",
			tokenType: "oauth",
			workspace: "example-org",
		});
		expect(message).toBe(
			"manage_agents.delete requires admin or owner access in example-org. Your role in example-org is member, and reconnecting this app cannot change that. Ask an owner of example-org to do it, or to give you the admin role.",
		);
	});

	it("does not mention reconnecting to a member in a web session", () => {
		expect(
			scopeDenialMessage({
				subject: "manage_operations.approve",
				requiredAccess: "admin",
				memberRole: "member",
				tokenType: "session",
				workspace: "example-org",
			}),
		).toBe(
			"manage_operations.approve requires admin or owner access in example-org. Your role in example-org is member. Ask an owner of example-org to do it, or to give you the admin role.",
		);
	});

	it("sends a read-only member to 'Read and make changes' only", () => {
		const message = scopeDenialMessage({
			subject: "save_memory",
			requiredAccess: "write",
			memberRole: "member",
			tokenType: "oauth",
			workspace: "example-org",
		});
		expect(message).toContain("This connection to example-org was approved read-only");
		expect(message).toContain("choose 'Read and make changes' on the Lobu consent screen.");
		expect(message).not.toContain("Administer workspaces");
	});

	it("offers both levels when the role is unknown on an account-level call", () => {
		const message = scopeDenialMessage({
			subject: "list_organizations",
			requiredAccess: "write",
			memberRole: null,
			tokenType: "oauth",
			workspace: null,
			accountScope: true,
		});
		expect(message).toContain("This connection was approved read-only");
		expect(message).toContain(
			"'Read and make changes' (or 'Administer workspaces', if offered and you're an owner/admin)",
		);
	});

	it("tells a personal access token caller to mint a token with the scope", () => {
		const message = scopeDenialMessage({
			subject: "manage_agents.delete",
			requiredAccess: "admin",
			memberRole: "admin",
			tokenType: "pat",
			workspace: "example-org",
		});
		expect(message).toContain("This personal access token was created without it");
		expect(message).toContain("mcp:admin");
		expect(message).not.toContain("consent screen");
	});

	it("stays ASCII so it is safe inside a WWW-Authenticate error_description", () => {
		for (const requiredAccess of ["read", "write", "admin"] as const) {
			for (const memberRole of ["owner", "member", null]) {
				const message = scopeDenialMessage({
					subject: "x",
					requiredAccess,
					memberRole,
					tokenType: "oauth",
					workspace: "example-org",
				});
				expect(/^[\x20-\x7e]*$/.test(message)).toBe(true);
				expect(message).not.toContain('"');
			}
		}
	});
});
