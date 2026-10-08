import {
	Actions,
	Button,
	Card,
	CardText,
	LinkButton,
	markdownToPlainText,
	type ActionsElement,
	type CardChild,
} from "chat";
import { clampEscaped, escapeSlackText } from "../utils/slack-text";

/** One chat presentation for event summaries and native, server-owned decisions. */
export function buildEventChatMessage(params: {
	title?: string;
	body?: string | null;
	url?: string | null;
	linkLabel?: string;
	decisionRunId?: number | null;
	/** Plain-text evidence supplied by the native approval producer. */
	details?: string;
}) {
	const body = params.url
		? params.body?.split("\n")
			.filter((line) => line.trim().match(/^(?:Review:\s*)?\[Review in Lobu\]\((.*)\)$/)?.[1] !== params.url)
			.join("\n")
		: params.body;
	const text = [markdownToPlainText(body ?? "").trim(), params.details]
		.filter(Boolean).join("\n\n");
	const escaped = escapeSlackText(text);
	// Discord joins card sections into one 4096-character description. Reserve
	// room for attribution and the review notice; larger decisions open the web.
	const budget = params.decisionRunId ? 2400 : 1800;
	const complete = escaped.length <= budget;
	const summary = clampEscaped(escaped, budget);
	const children: CardChild[] = [];
	if (summary) children.push(CardText(summary));
	if (params.decisionRunId && !complete) {
		children.push(CardText("Open the full review to see all details and decide."));
	}
	const actions: ActionsElement["children"] = [];
	if (params.decisionRunId && complete) {
		actions.push(
			Button({
				id: "run-approval:" + params.decisionRunId + ":approve",
				label: "Approve", style: "primary", value: "approve",
			}),
			Button({
				id: "run-approval:" + params.decisionRunId + ":reject",
				label: "Reject", style: "danger", value: "reject",
			}),
		);
	}
	const linkLabel = params.linkLabel ?? (params.decisionRunId ? "Review in Lobu" : "Open event");
	if (params.url) actions.push(LinkButton({ url: params.url, label: linkLabel }));
	if (actions.length) children.push(Actions(actions));
	const title = params.title && params.title.length > 150
		? params.title.slice(0, 149) + "…" : params.title;
	return {
		card: Card({ title, children }),
		fallbackText: [
			params.title,
			text.length > budget ? text.slice(0, budget - 1) + "…" : text,
			params.url ? linkLabel + ": " + params.url : null,
		].filter(Boolean).join("\n\n"),
	};
}
