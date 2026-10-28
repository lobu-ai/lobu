import { describe, expect, test } from "bun:test";
import {
	type ActionApprovalDetails,
	buildActionApprovalCard,
	formatActionApprovalBody,
} from "../../notifications/triggers";

/**
 * Pins that untrusted names, reasons and connection labels interpolated into
 * approval Markdown cannot forge links, emphasis, headings or extra
 * paragraphs, and that a no-input ask still gets its decision buttons.
 *
 * Chat summary budgets and native controls are covered by event-card.test.ts;
 * durable delivery tests cover stored approval evidence and routing.
 */

describe("approval notification rendering", () => {
	test("Markdown escaping neutralises link and emphasis delimiters", () => {
		// One hostile name. The Markdown body must not let it forge a link or a
		// bold run, and Slack's entity escaping must not leak into it — the chat
		// side of this pair is pinned in `event-card.test.ts`.
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "delete",
			actorLabel: "[Review [nested]](https://evil)",
			entityId: 5,
			entityType: "topic",
			entityName: "*Urgent* <!channel> & [click](https://evil)",
			proposal: { name: "*Urgent* <!channel> & [click](https://evil)" },
			reason: "# [Review [nested]](https://evil)",
		};

		const body = formatActionApprovalBody({ details });
		// Markdown: every link/emphasis delimiter defanged; `&` stays a literal
		// `&` (Slack's entity escaping must not leak into Markdown).
		expect(body).toContain(
			String.raw`**\[Review \[nested\]\](https://evil)** wants to delete ` +
				String.raw`\*Urgent\* \<!channel\> & \[click\](https://evil) (#5).`,
		);
		expect(body).not.toContain("&amp;");
		// Leading `#` must not become a heading in the reason paragraph.
		expect(body).toContain(
			"\n\n" + String.raw`\# \[Review \[nested\]\](https://evil)`,
		);
	});

	test("markdown escaping covers strikethrough, autolinks, and unmatched brackets", () => {
		// The three vectors that survived a narrower escape set: `~~x~~` rendered
		// as <del>, `<https://evil>` became a real anchor, and a stray `]` closed
		// our link label early so the rest of the name escaped the anchor.
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "delete",
			actorLabel: "~~trusted agent~~",
			entityId: 7,
			entityType: "topic",
			entityName: "Budget] <https://evil.example>",
			entityUrl: "https://app.lobu.ai/acme/topic/budget",
			proposal: { entity_ids: [886] },
			reason: null,
		};
		const body = formatActionApprovalBody({ details });

		expect(body).toContain(
			String.raw`**\~\~trusted agent\~\~** wants to delete ` +
				String.raw`[Budget\] \<https://evil.example\>](https://app.lobu.ai/acme/topic/budget).`,
		);
		// Our own diff/link chrome must survive — only the values are escaped.
		expect(body).toContain("](https://app.lobu.ai/acme/topic/budget)");
		// Brackets in JSON values are escaped too; the renderer strips the
		// backslashes, so the user still reads "[ 886 ]" (asserted in
		// owletto's markdown-text.inline.test.tsx).
		expect(body).toContain(String.raw`- Entity ids: \[ 886 \]`);
	});

	test("multiline names collapse so the summary stays one sentence", () => {
		// A blank line inside a name would split the summary across Markdown
		// paragraphs, and the card preview (first block only) would then show a
		// misleading half-sentence: "wants to delete Bad".
		const body = formatActionApprovalBody({
			details: {
				kind: "entity_change",
				operation: "delete",
				actorLabel: "An\nagent",
				entityId: 5,
				entityType: "topic",
				entityName: "Bad\n\nName",
				reason: null,
			},
		});
		expect(body).toBe("**An agent** wants to delete Bad Name (#5).");

		expect(
			formatActionApprovalBody({
				connectionName: "Git\nHub",
				approvalUrl: "/acme/runs/1",
			}),
		).toContain("A queued action on Git Hub is waiting");
	});

	test("generic approval escapes the connection name", () => {
		// The non-structured branch interpolates connectionName straight into the
		// Markdown body; unescaped it could forge an external "Review" anchor.
		expect(
			formatActionApprovalBody({
				connectionName: "GitHub](https://evil.example) [x",
				approvalUrl: "/acme/runs/46",
			}),
		).toBe(
			String.raw`A queued action on GitHub\](https://evil.example) \[x is waiting for your review.` +
				"\n\nReview: [Review in Lobu](/acme/runs/46)",
		);
	});

	test("setext underlines of any length are escaped", () => {
		// A single "=" under a line turns it into an <h1>; the escape must not be
		// limited to the 3+ runs that form a `---` thematic break.
		for (const underline of ["=", "==", "--", "---"]) {
			const body = formatActionApprovalBody({
				details: {
					kind: "entity_change",
					operation: "delete",
					actorLabel: "An automation",
					entityId: 1,
					entityType: "topic",
					entityName: "X",
					reason: underline,
				},
			});
			expect(body.split("\n").pop()).toBe(`\\${underline}`);
		}
	});

	test("renderer-owned diff delimiters are not escaped away", () => {
		// `~old~` is OUR strikethrough, not user text. Escaping the assembled
		// diff line turned it into a literal `\~old\~`.
		const body = formatActionApprovalBody({
			details: {
				kind: "entity_field_change",
				entityId: 9,
				entityType: "topic",
				fields: { severity: "critical" },
				current: { severity: "high" },
				reason: null,
			},
		});
		expect(body).toContain("- Severity: ~high~\n→ critical");
	});

	test("an ask that takes no input still gets decision buttons", () => {
		// The one surviving caller. `inputSchema: null` is the caller ASSERTING
		// the decision carries no answer — omitting it must not get buttons that
		// would discard one.
		const card = buildActionApprovalCard({
			runId: 47,
			approvalUrl: "https://app.lobu.ai/acme/runs/47",
			summary: "Ship it?",
			inputSchema: null,
		});
		const actions = (
			card as unknown as {
				children: Array<{
					type: string;
					children?: Array<{ id?: string; url?: string }>;
				}>;
			}
		).children
			.filter((c) => c.type === "actions")
			.flatMap((c) => c.children ?? []);
		expect(actions.map((a) => a.id ?? a.url)).toEqual([
			"run-approval:47:approve",
			"run-approval:47:reject",
			"https://app.lobu.ai/acme/runs/47",
		]);
	});
});
