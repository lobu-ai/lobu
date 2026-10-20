/**
 * Live follow-up chips from a real model, opt-in, gated on OPENAI_API_KEY.
 *
 * The deterministic suites cover parsing and delivery of chips, never what a
 * real model does with FOLLOW_UP_SUGGESTIONS_PROMPT. This asks the prompt the
 * way `askAside` does (the transcript, then the prompt as one more user
 * message) and checks the three cases the prompt is written for: a reply that
 * offers next steps yields chips, a finished answer and a question the user
 * must answer yield none. Runs under `make test-providers-live`.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	FOLLOW_UP_SUGGESTIONS_PROMPT,
	parseFollowUpSuggestions,
} from "@lobu/core/agent-tooling";
import {
	type Context,
	completeSimple,
	type Model,
} from "@mariozechner/pi-ai";

const apiKey = process.env.OPENAI_API_KEY;
const MODEL_ID = process.env.LIVE_SUGGESTIONS_MODEL || "gpt-5.4";
const TIMEOUT_MS = 60_000;
setDefaultTimeout(TIMEOUT_MS + 10_000);

const model = {
	id: MODEL_ID,
	name: MODEL_ID,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
} as Model<any>;

async function chipsAfter(user: string, assistant: string) {
	const now = Date.now();
	const context: Context = {
		systemPrompt: "You are a research agent that helps plan short videos.",
		messages: [
			{ role: "user", content: user, timestamp: now },
			{
				role: "assistant",
				content: [{ type: "text", text: assistant }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: now,
			},
			{ role: "user", content: FOLLOW_UP_SUGGESTIONS_PROMPT, timestamp: now },
		],
	};
	const reply = await completeSimple(model, context, {
		apiKey,
		maxTokens: 400,
		timeoutMs: TIMEOUT_MS,
	});
	expect(reply.errorMessage).toBeUndefined();
	const text = reply.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
	return parseFollowUpSuggestions(text);
}

describe.skipIf(!apiKey)("follow-up suggestions prompt (live)", () => {
	test("turns the reply's own offers into chips", async () => {
		const chips = await chipsAfter(
			"Give me three hook ideas for a video about cold brew coffee.",
			[
				"1. \"You've been making cold brew wrong.\"",
				'2. "This costs 40 cents and beats any cafe."',
				'3. "12 hours, one jar, zero effort."',
				"",
				"If you want, I can write a full 30-second script for one of these, or plan a week of posts around them.",
			].join("\n"),
		);
		expect(chips.length).toBeGreaterThan(0);
		expect(chips.length).toBeLessThanOrEqual(3);
	});

	test("returns none for a finished answer", async () => {
		const chips = await chipsAfter(
			"What's the max length of a TikTok caption?",
			"A TikTok caption can be up to 4,000 characters.",
		);
		expect(chips).toEqual([]);
	});

	test("returns none for a question only the user can answer", async () => {
		const chips = await chipsAfter(
			"Help me plan videos for my channel.",
			"Happy to. What is your channel about, and who is your audience?",
		);
		expect(chips).toEqual([]);
	});
});
