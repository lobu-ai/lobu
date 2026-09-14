/**
 * `workspaceUnlinkedNotice` — the reply from a tenant connection with no owning
 * agent when a chat is not bound to an Automation. EVERY chat platform gets the
 * same agent deep links into the Automation editor, each rendered in that
 * platform's own link syntax and carrying that platform's own `platform=` value
 * (the editor matches it against the connection's `connector_key`). The notice
 * must remain available when the agent lookup fails.
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

	it("returns the CLI notice in the platform's own command spelling when the org has no agents (#2230)", async () => {
		const org = await createTestOrganization();
		const text = await workspaceUnlinkedNotice("telegram", org.id);
		expect(text).toContain("isn't linked");
		// The platform's own command spelling, not Slack's `/lobu link` wrapper.
		expect(text).toContain("/link <code>");
		expect(text).not.toContain("/lobu link");
	});

	// The deep link used to be gated to Slack: every other platform hard-returned
	// a linkless notice, and the one link that was built hardcoded
	// `platform=slack`, which the editor matches against the connection's
	// `connector_key` — so it would have matched nothing anyway. Enumerate the
	// class rather than the platform that happened to report it.
	it.each([
		["gchat", "/lobu link"],
		["telegram", "/link"],
		["discord", "/link"],
		["teams", "/link"],
		["whatsapp", "/link"],
	])(
		"deep-links agents on %s with that platform's own connector_key",
		async (platform, linkSpelling) => {
			setOrigin("https://app.lobu.ai");
			const org = await createTestOrganization({ slug: "acme" });
			await createTestAgent({
				organizationId: org.id,
				agentId: "planner",
				name: "Planner",
			});

			const text = await workspaceUnlinkedNotice(platform, org.id, {
				channelId: "spaces/AAQA",
				connectionSlug: BYO_CONNECTION_SLUG,
			});

			// The editor keys off `platform=` === connector_key, so it must be the
			// real platform — never a hardcoded "slack".
			expect(text).toContain(`platform=${platform}`);
			expect(text).not.toContain("platform=slack");
			expect(text).toContain(
				"https://app.lobu.ai/acme/automations/new?agent=planner",
			);
			expect(text).toContain(`connection=${BYO_CONNECTION_SLUG}`);
			expect(text).toContain(linkSpelling);
		},
	);

	// `connection` is resolved by EXACT match against `connections.slug`, so the
	// notice must name the slug and never the gateway runtime id it holds at
	// send time. Both live namespaces are non-numeric and neither can ever equal
	// a row's numeric `id`, which is what the editor used to be handed: the
	// lookup missed every time AND, because a present-but-unmatched param skips
	// the connector+team fallback, the link was worse than one carrying no
	// connection at all.
	it.each([
		["byo", BYO_CONNECTION_SLUG],
		["managed slack install", "slackinst-5915b502a2be4d3abb47cddc36ad8c6d"],
	])("carries the %s connection slug verbatim", async (_kind, slug) => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
			connectionSlug: slug,
		});

		expect(text).toContain(`connection=${slug}`);
	});

	// Google Chat's `Message.text` takes the SAME `<url|label>` hyperlink as
	// Slack mrkdwn. It used to be lumped in with the bare-URL platforms, which
	// left every agent rendered as the raw deep-link URL instead of its name.
	it.each(["slack", "gchat"])(
		"renders a labelled hyperlink on %s, never a bare URL",
		async (platform) => {
			setOrigin("https://app.lobu.ai");
			const org = await createTestOrganization({ slug: "acme" });
			await createTestAgent({
				organizationId: org.id,
				agentId: "planner",
				name: "Planner",
			});

			const text = await workspaceUnlinkedNotice(platform, org.id, {
				channelId: "spaces/AAQA",
			});

			expect(text).toContain("|Planner>");
			expect(text).not.toContain("Planner — https://");
		},
	);

	// Telegram, Discord, Teams and WhatsApp do not read the `<url|label>`
	// spelling, so all four must get the bare URL they auto-linkify — otherwise
	// the angle brackets reach the reader as literal text.
	it.each(["telegram", "discord", "teams", "whatsapp"])(
		"renders a bare labelled URL on %s",
		async (platform) => {
			setOrigin("https://app.lobu.ai");
			const org = await createTestOrganization({ slug: "acme" });
			await createTestAgent({
				organizationId: org.id,
				agentId: "planner",
				name: "Planner",
			});

			const text = await workspaceUnlinkedNotice(platform, org.id, {
				channelId: "spaces/AAQA",
			});

			expect(text).toContain("Planner — https://app.lobu.ai/acme/automations");
			expect(text).not.toContain("<http");
		},
	);

	// Slack mrkdwn decodes HTML entities, so encoding is lossless there. Google
	// Chat does not, so an entity would reach the reader verbatim — the raw
	// characters are dropped instead. Either way the label cannot terminate the
	// link early.
	it("escapes a label that could break the link, per platform", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "odd",
			name: "A&B <Co>",
		});

		const slack = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
		});
		expect(slack).toContain("|A&amp;B &lt;Co&gt;>");

		const gchat = await workspaceUnlinkedNotice("gchat", org.id, {
			channelId: "spaces/AAQA",
		});
		// No entity survives to the reader, and no `<`/`>` is left to close the
		// link early.
		expect(gchat).toContain("|A&B Co>");
		expect(gchat).not.toContain("&amp;");
	});

	it("omits the Slack `#` label prefix on platforms that name their own surfaces", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});

		const text = await workspaceUnlinkedNotice("gchat", org.id, {
			channelId: "spaces/AAQA",
			channelName: "Team Space",
		});

		// `%23` is the encoded `#` — a Google Chat space is not a Slack channel.
		expect(text).toContain("label=Team+Space");
		expect(text).not.toContain("label=%23");
	});

	it('deep-links each agent to the Automations "new" step with the channel prefilled', async () => {
		setOrigin("https://app.lobu.ai/lobu");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});
		await createTestAgent({
			organizationId: org.id,
			agentId: "builder",
			name: "Builder",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
			channelName: "general",
			connectionSlug: BYO_CONNECTION_SLUG,
		});

		// getConfiguredPublicOrigin() returns the URL *origin* (scheme+host), so the
		// /lobu gateway mount is dropped — the SPA lives at the bare origin. The link
		// targets the Automation editor with its connection event prefilled.
		// `slack:C…`, `T0TEAM`, and the `#general` label are URL-encoded. Each agent
		// is a Slack mrkdwn inline link `<url|Name>` so the agent's NAME carries the
		// link (the notice goes out via chat.postMessage text, which Slack reads as
		// mrkdwn; a bare URL would put the raw deep-link URL in its place).
		expect(text).toContain(
			"<https://app.lobu.ai/acme/automations/new?agent=planner&listen=slack%3AC0ABC123&platform=slack&team=T0TEAM&connection=agentconn-9f3c1d0e7b2a4c55&label=%23general|Planner>",
		);
		expect(text).toContain(
			"<https://app.lobu.ai/acme/automations/new?agent=builder&listen=slack%3AC0ABC123&platform=slack&team=T0TEAM&connection=agentconn-9f3c1d0e7b2a4c55&label=%23general|Builder>",
		);
		expect(text).toContain("Planner");
		expect(text).toContain("Builder");
		// The CLI path is always offered too.
		expect(text).toContain("lobu run");
		expect(text).toContain("/lobu link");
	});

	it("deep-links to Automation creation with the agent prefilled when no channel context is given", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain(
			"https://app.lobu.ai/acme/automations/new?agent=planner",
		);
	});

	it("lists agents by name (no URLs) when the public origin is not configured", async () => {
		setOrigin(undefined);
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain("Planner");
		expect(text).not.toContain("/agents/planner/automations");
		expect(text).toContain("lobu run"); // CLI path still present
	});

	it("offers agent creation, not just the CLI, when the org has no agents", async () => {
		// The person most likely just installed the app and has never seen Lobu.
		// "Install a CLI" is the wrong only-instruction: point at creating the
		// first agent, after which the agent branch deep-links this chat into
		// that agent's Automation editor.
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization();

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain(`/${org.slug}/agents/new`);
		expect(text).toContain("create your first agent");
		// The CLI path stays offered alongside it.
		expect(text).toContain("lobu run");
		expect(text).toContain("/lobu link");
		// Still no agent-list section — there are no agents to list.
		expect(text).not.toContain("Automations page");
	});

	it("keeps the CLI-only notice when no public origin makes a link possible", async () => {
		// `canLink` is false without an origin, so there is no URL to offer; the
		// notice must still say something actionable rather than dead-drop.
		setOrigin(undefined);
		const org = await createTestOrganization();

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain("lobu run");
		expect(text).not.toContain("create your first agent");
	});

	it("never throws / dead-drops for an unknown org (returns the CLI-only notice)", async () => {
		setOrigin("https://app.lobu.ai");
		const text = await workspaceUnlinkedNotice(
			"slack",
			"org_does_not_exist",
		);
		expect(text).toContain("/lobu link");
	});
});
