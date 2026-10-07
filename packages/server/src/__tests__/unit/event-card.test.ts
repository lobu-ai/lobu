import { describe, expect, test } from "bun:test";
import { cardToBlockKit } from "@chat-adapter/slack";
import { cardToDiscordPayload } from "@chat-adapter/discord";
import { cardToGoogleCard } from "@chat-adapter/gchat";
import { addActionOrigin } from "../../notifications/action-card-state";
import { buildEventChatMessage } from "../../notifications/event-card";

function sections(message: ReturnType<typeof buildEventChatMessage>) {
	return cardToBlockKit(message.card).flatMap((block) =>
		block.type === "section" && "text" in block && block.text &&
		typeof block.text === "object" && "text" in block.text ? [String(block.text.text)] : [],
	);
}

describe("event chat messages", () => {
	test("Google Chat keeps custom links and native approval callbacks", () => {
		const url = "https://app.example/synthetic/events/42";
		const custom = JSON.stringify(cardToGoogleCard(buildEventChatMessage({
			body: "Choose an option.", url,
		}).card));
		expect(custom).toContain(JSON.stringify({ openLink: { url } }).slice(1, -1));
		expect(custom).not.toContain('"action":');

		const native = JSON.stringify(cardToGoogleCard(buildEventChatMessage({
			body: "Run the operation?", decisionRunId: 47,
			url: "https://app.example/synthetic/runs/47",
			details: 'Input: {"enabled":false,"count":0}',
		}).card, { endpointUrl: "https://gateway.example/lobu/webhooks/gchat" }));
		expect(native).toContain("run-approval:47:approve");
		expect(native).toContain("run-approval:47:reject");
		expect(native).toContain("https://gateway.example/lobu/webhooks/gchat");
		expect(native).toContain('enabled');
		expect(native).toContain('false');
		expect(native).toContain('count');
	});

	test.each([
		["Delete all records after you [review](URL)?", "Delete all records after you review?"],
		["[Delete all records?](URL)", "Delete all records?"],
	])("keeps question text in a review link: %s", (body, expected) => {
		const url = "https://app.example/synthetic/runs/47";
		const message = buildEventChatMessage({
			body: `${body.replace("URL", url)}\n\nReview: [Review in Lobu](${url})`,
			url,
			decisionRunId: 47,
		});
		expect(sections(message)).toEqual([expected]);
		expect(message.fallbackText).toContain(expected);
	});

	test("bounds Slack headers while preserving the full title in fallback text", () => {
		const title = "Release ".repeat(25);
		const message = buildEventChatMessage({ title, body: "Ready for review." });
		const header = cardToBlockKit(message.card).find((block) => block.type === "header");
		expect(header?.text.text.length).toBeLessThanOrEqual(150);
		expect(header?.text.text).toEndWith("…");
		expect(message.fallbackText).toContain(title);
	});

	test("oversized approvals fit Discord's single embed and require full review", () => {
		const message = buildEventChatMessage({
			body: "evidence ".repeat(500),
			decisionRunId: 49,
			url: "https://app.example/synthetic/runs/49",
		});
		const card = addActionOrigin(message.card, { kind: "automation", label: "&".repeat(240) });
		const payload = cardToDiscordPayload(card);
		expect(payload.embeds[0]?.description?.length).toBeLessThanOrEqual(4096);
		expect(JSON.stringify(payload)).not.toContain("run-approval:");
		expect(JSON.stringify(payload)).toContain("Open the full review");
	});

	test("custom events expose one canonical link and a readable summary", () => {
		const message = buildEventChatMessage({
			title: "Release ballot", body: "Choose **A** or **B**.",
			url: "https://app.example/synthetic/events/42",
		});
		expect(sections(message)).toEqual(["Choose A or B."]);
		expect(message.fallbackText).toContain("Open event: https://app.example/synthetic/events/42");
		expect(JSON.stringify(message.card)).not.toContain('"type":"button"');
		expect(JSON.stringify(message.card)).not.toContain("run-approval:");
	});

	test("escaped previews fit actual Slack sections without partial entities", () => {
		const message = buildEventChatMessage({
			body: "<!channel> " + "& ".repeat(2000),
			url: "https://app.example/synthetic/events/42",
		});
		expect(sections(message).join("")).toContain("&lt;!channel&gt;");
		for (const text of sections(message)) {
			expect(text.length).toBeLessThanOrEqual(3000);
			expect(text).not.toMatch(/&(amp?|lt?|gt?)?…$/);
		}
	});

	test("native approvals keep all bounded evidence and their existing action ids", () => {
		const body = "Start " + "& evidence ".repeat(150) + " final field";
		const message = buildEventChatMessage({
			body, decisionRunId: 47, url: "https://app.example/synthetic/runs/47",
			details: 'Input:\n{"enabled":false,"count":0,"nested":{"value":"kept"}}',
		});
		const rendered = sections(message);
		expect(rendered).toHaveLength(1);
		expect(rendered.join("")).toContain("final field");
		expect(rendered.join("")).toContain('"enabled":false,"count":0');
		for (const text of rendered) expect(text.length).toBeLessThanOrEqual(3000);
		const card = JSON.stringify(message.card);
		expect(card).toContain("run-approval:47:approve");
		expect(card).toContain("run-approval:47:reject");
	});

	test("oversized native evidence requires full review instead of a blind decision", () => {
		const message = buildEventChatMessage({
			body: "review ".repeat(6000), decisionRunId: 48,
			url: "https://app.example/synthetic/runs/48",
		});
		expect(sections(message).join("")).toContain("Open the full review");
		expect(JSON.stringify(message.card)).not.toContain("run-approval:");
		expect(message.fallbackText).toContain("Review in Lobu:");
		expect(cardToBlockKit(message.card).length).toBeLessThan(50);
	});
});
