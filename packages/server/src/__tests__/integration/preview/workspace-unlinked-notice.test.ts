/**
 * `workspaceUnlinkedNotice` — the reply from a tenant connection with no owning
 * agent when a chat is not bound to an Automation. EVERY chat platform gets the
 * same agent deep links into the Automation editor, carrying that platform's
 * own `platform=` value (the editor matches it against the connection's
 * `connector_key`) and the connection's stored slug. These cases pin the link
 * parameters and label escaping, not the notice copy.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceUnlinkedNotice } from "../../../preview/slack";
import { __resetPublicOriginCachesForTests } from "../../../utils/public-origin";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

const ORIGIN_ENV = "PUBLIC_GATEWAY_URL";
/** A BYO chat connection's `connections.slug` shape (`agentconn-<hex>`). */
const BYO_CONNECTION_SLUG = "agentconn-9f3c1d0e7b2a4c55";

// getConfiguredPublicOrigin() memoizes PUBLIC_GATEWAY_URL on first read, so every
// case that changes the env must reset the cache to be observed.
function setOrigin(value: string | undefined) {
	if (value === undefined) delete process.env[ORIGIN_ENV];
	else process.env[ORIGIN_ENV] = value;
	__resetPublicOriginCachesForTests();
}

describe("workspaceUnlinkedNotice", () => {
	let savedOrigin: string | undefined;

	beforeEach(async () => {
		await cleanupTestDatabase();
		savedOrigin = process.env[ORIGIN_ENV];
	});

	afterEach(() => {
		setOrigin(savedOrigin);
	});

	async function orgWithAgent(name = "Planner", agentId = "planner") {
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({ organizationId: org.id, agentId, name });
		return org;
	}

	// The deep link used to be gated to Slack and hardcoded `platform=slack`,
	// which matched no connection on any other platform.
	it.each(["gchat", "telegram", "discord", "teams", "whatsapp"])(
		"deep-links agents on %s with that platform's own connector_key",
		async (platform) => {
			setOrigin("https://app.lobu.ai");
			const org = await orgWithAgent();

			const text = await workspaceUnlinkedNotice(platform, org.id, {
				channelId: "spaces/AAQA",
				connectionSlug: BYO_CONNECTION_SLUG,
			});

			expect(text).toContain(`platform=${platform}`);
			expect(text).not.toContain("platform=slack");
			expect(text).toContain("https://app.lobu.ai/acme/automations/new?agent=planner");
			expect(text).toContain(`connection=${BYO_CONNECTION_SLUG}`);
			// Only pipe-link platforms get `<url|label>`; elsewhere the angle
			// brackets would render as literal text around a dead link.
			if (platform === "gchat") {
				expect(text).toContain("|Planner>");
			} else {
				expect(text).not.toContain("<http");
				expect(text).toContain("Planner — https://app.lobu.ai/acme/automations/new?");
			}
		},
	);

	// `connection` is resolved by EXACT match against `connections.slug`; a
	// runtime id matched nothing AND skipped the editor's connector+team
	// fallback.
	it.each([
		["byo", BYO_CONNECTION_SLUG],
		["managed slack install", "slackinst-5915b502a2be4d3abb47cddc36ad8c6d"],
	])("carries the %s connection slug verbatim", async (_kind, slug) => {
		setOrigin("https://app.lobu.ai");
		const org = await orgWithAgent();

		const text = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
			connectionSlug: slug,
		});

		expect(text).toContain(`connection=${slug}`);
	});

	it("prefills every agent's Automation editor link with the encoded channel, team, connection and label", async () => {
		// The public origin's path (/lobu gateway mount) is dropped: the SPA
		// lives at the bare origin.
		setOrigin("https://app.lobu.ai/lobu");
		const org = await orgWithAgent();
		await createTestAgent({ organizationId: org.id, agentId: "builder", name: "Builder" });

		const text = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
			channelName: "general",
			connectionSlug: BYO_CONNECTION_SLUG,
		});

		for (const [agentId, name] of [["planner", "Planner"], ["builder", "Builder"]]) {
			expect(text).toContain(
				`<https://app.lobu.ai/acme/automations/new?agent=${agentId}&listen=slack%3AC0ABC123&platform=slack&team=T0TEAM&connection=agentconn-9f3c1d0e7b2a4c55&label=%23general|${name}>`,
			);
		}
	});

	it("deep-links with only the agent prefilled when no channel context is given", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await orgWithAgent();

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain("https://app.lobu.ai/acme/automations/new?agent=planner");
	});

	it("omits the Slack `#` label prefix on platforms that name their own surfaces", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await orgWithAgent();

		const text = await workspaceUnlinkedNotice("gchat", org.id, {
			channelId: "spaces/AAQA",
			channelName: "Team Space",
		});

		expect(text).toContain("label=Team+Space");
		expect(text).not.toContain("label=%23");
	});

	// Slack mrkdwn decodes HTML entities; Google Chat does not, so the raw
	// characters are dropped there. Either way the label cannot close the link.
	it("escapes a label that could break the link, per platform", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await orgWithAgent("A&B <Co>", "odd");

		const slack = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
		});
		expect(slack).toContain("|A&amp;B &lt;Co&gt;>");

		const gchat = await workspaceUnlinkedNotice("gchat", org.id, {
			channelId: "spaces/AAQA",
		});
		expect(gchat).toContain("|A&B Co>");
		expect(gchat).not.toContain("&amp;");
	});

	it("links agent creation when the org has no agents", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization();

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain(`/${org.slug}/agents/new`);
	});

	it("still returns a notice when the agent lookup fails for an unknown org", async () => {
		setOrigin("https://app.lobu.ai");
		await expect(workspaceUnlinkedNotice("slack", "org_does_not_exist")).resolves.toEqual(
			expect.any(String),
		);
	});
});
