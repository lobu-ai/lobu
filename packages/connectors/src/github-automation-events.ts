import type {
	ConnectorAutomationEvent,
	ConnectorAutomationSignalDraft,
	EventEnvelope,
	SubscriptionCandidate,
} from "@lobu/connector-sdk";
import { normalizeGithubRepoFullName } from "./github-identity.js";

export const GITHUB_PULL_REQUEST_SUPPORTED_EVENTS = [
	"pull_request.updated",
	"comment.created",
	"comment.updated",
] as const;

export const GITHUB_PULL_REQUEST_SUGGESTED_EVENTS = [
	"pull_request.updated",
] as const;

export const GITHUB_AUTOMATION_EVENTS: ConnectorAutomationEvent[] = [
	{
		key: "pull_request.created",
		label: "A pull request is created",
		description:
			"Runs for each newly opened pull request observed after the last sync. Webhooks mark the feed due so the poll (not the webhook payload itself) produces the signal.",
		resourceType: "pull_request",
		filterSchema: {
			type: "object",
			properties: {
				repository: {
					type: "string",
					title: "Repository",
					description: "Optional owner/repository filter.",
				},
			},
		},
		defaults: { execution: "turn", activeRun: "queue", output: "silent" },
	},
	...GITHUB_PULL_REQUEST_SUPPORTED_EVENTS.map(
		(key): ConnectorAutomationEvent => ({
			key,
			label: key
				.split(".")
				.map((part) => part.replaceAll("_", " "))
				.join(" · "),
			resourceType: "pull_request",
			defaults: {
				execution: "turn",
				activeRun: "queue",
				output: "silent",
			},
		}),
	),
	{
		key: "stargazer",
		label: "A repository is starred",
		description:
			"Runs for each new star on a tracked repository, recorded live from the star webhook or by the stargazers poll, whichever sees it first.",
		// Derived record signals carry resource_type = the event kind.
		resourceType: "stargazer",
		defaults: { execution: "turn", activeRun: "queue", output: "silent" },
	},
	{
		key: "commits.updated",
		label: "Repository commits change",
		description: "Runs for newly collected commits in this connection.",
		resourceType: "repository",
		defaults: { execution: "turn", activeRun: "queue", output: "silent" },
	},
];

/**
 * Whether a GitHub feed sync should attach automation_signals to envelopes.
 * Cold start and checkpoint-reset runs walk lookback_days of history; first-seen
 * rows would all fire pull_request.created and flood subscribers. Only emit
 * Automation signals once a prior last_sync_at exists (steady-state delta).
 */
export function githubSyncShouldEmitAutomationSignals(
	checkpoint: { last_sync_at?: unknown } | null | undefined,
): boolean {
	const lastSync = checkpoint?.last_sync_at;
	return typeof lastSync === "string" && lastSync.trim().length > 0;
}

export function githubPullRequestResourceRef(
	fullName: string,
	pullNumber: number,
): string {
	const normalized =
		normalizeGithubRepoFullName(fullName) ?? fullName.toLowerCase();
	return `github:pull_request:${normalized}#${pullNumber}`;
}

export function githubPullRequestSubscribable(
	fullName: string,
	pullNumber: number,
): SubscriptionCandidate {
	const normalized =
		normalizeGithubRepoFullName(fullName) ?? fullName.toLowerCase();
	return {
		connector_key: "github",
		resource_type: "pull_request",
		resource_ref: githubPullRequestResourceRef(normalized, pullNumber),
		label: `GitHub PR ${normalized}#${pullNumber}`,
		suggested_event_keys: [...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS],
	};
}

function githubRepository(
	metadata: Record<string, unknown>,
): string | undefined {
	const value = metadata.repository ?? metadata.github_repo_full_name;
	return typeof value === "string"
		? (normalizeGithubRepoFullName(value) ?? value.toLowerCase())
		: undefined;
}

/**
 * Interpret a GitHub EventEnvelope inside the connector package. The gateway
 * later supplies platform-owned routing/idempotency fields after persistence.
 */
export function githubAutomationSignalDrafts(
	event: EventEnvelope,
): ConnectorAutomationSignalDraft[] {
	const metadata = event.metadata ?? {};
	const repository = githubRepository(metadata);
	const occurredAt =
		event.occurred_at instanceof Date
			? event.occurred_at.toISOString()
			: String(event.occurred_at);
	const base = {
		label: event.title || `GitHub ${event.origin_type ?? "event"}`,
		input_text:
			[event.title, event.payload_text].filter(Boolean).join("\n\n") ||
			`GitHub ${event.origin_type ?? "event"}: ${event.origin_id}`,
		url: event.source_url,
		occurred_at: occurredAt,
	};

	if (event.origin_type === "commit") {
		const attributes: Record<string, string | number | boolean | null> = {};
		if (repository) attributes.repository = repository;
		if (typeof metadata.sha === "string") attributes.sha = metadata.sha;
		return [
			{
				...base,
				event_type: "commits.updated",
				resource_type: "repository",
				resource_ref: repository
					? `github:repository:${repository}`
					: event.origin_id,
				attributes,
			},
		];
	}

	if (
		event.origin_type !== "pull_request" &&
		event.origin_type !== "pr_comment"
	) {
		return [];
	}
	const numericPullNumber = Number(
		metadata.pull_number ??
			metadata.number ??
			event.origin_parent_id?.match(/_(\d+)$/)?.[1] ??
			event.origin_id.match(/_(\d+)$/)?.[1],
	);
	const pullNumber = Number.isFinite(numericPullNumber)
		? numericPullNumber
		: undefined;
	const resourceRef =
		repository && pullNumber !== undefined
			? githubPullRequestResourceRef(repository, pullNumber)
			: (event.origin_parent_id ?? event.origin_id);
	const attributes: Record<string, string | number | boolean | null> = {};
	if (repository) attributes.repository = repository;
	if (pullNumber !== undefined) attributes.pull_number = pullNumber;
	if (typeof metadata.state === "string") attributes.state = metadata.state;

	return [
		{
			...base,
			event_type:
				event.origin_type === "pull_request"
					? "pull_request.created"
					: "comment.created",
			updated_event_type:
				event.origin_type === "pull_request"
					? "pull_request.updated"
					: "comment.updated",
			resource_type: "pull_request",
			resource_ref: resourceRef,
			attributes,
		},
	];
}
