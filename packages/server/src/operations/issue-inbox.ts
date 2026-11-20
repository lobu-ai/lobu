/**
 * Where agents report Lobu issues on this deployment: an organization's
 * published notification inbox, named by the operator in `LOBU_ISSUE_INBOX`
 * as `<organization>/<inbox>`. Unset (the self-hosted default) means there is
 * nowhere to report, and agents are not told to report. The value is
 * `lobu-team/product.issue` on Lobu Cloud.
 */
export interface IssueInbox {
	organization: string;
	inbox: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INBOX_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function issueInbox(
	env: Record<string, string | undefined> = process.env,
): IssueInbox | null {
	const raw = env.LOBU_ISSUE_INBOX?.trim();
	if (!raw) return null;
	const [organization, inbox, ...rest] = raw.split("/");
	// A malformed value names no inbox; agents must not be sent to a guess.
	if (rest.length || !SLUG.test(organization ?? "") || !INBOX_KEY.test(inbox ?? ""))
		return null;
	return { organization, inbox };
}

/** The submit call an agent should make, for instructions and failed runs. */
export function issueInboxCall(target: IssueInbox): string {
	return `notifications.submit({ organization: "${target.organization}", inbox: "${target.inbox}", ... })`;
}

export interface OperationFailureOutcome {
	/** The terminal write logged it as an issue occurrence under its fingerprint. */
	recorded: boolean;
	/**
	 * A browser connector reported `page_unrecognized`: the page was not laid out
	 * the way it knows, found before it acted, so nothing changed.
	 */
	pageUnrecognized?: boolean;
}

/**
 * Guidance returned with a run that ended without a result. Only a recorded
 * failure (one with a fingerprint, its issue grouping key) points at the issue
 * inbox: a cancelled or rejected run is not a Lobu defect. A browser connector
 * that did not recognize the page lets the agent finish the same action in the
 * browser; every other failure keeps the agent off raw browser steps.
 */
export function failedOperationNextAction(
	outcome: OperationFailureOutcome,
	target: IssueInbox | null = issueInbox(),
): string {
	const recovery = outcome.recorded && outcome.pageUnrecognized;
	const base = recovery
		? "The connector did not recognize the page and stopped before acting, so nothing changed; do not retry it. If you can use this workspace's chrome connection, you may finish this same action once in the browser: open the same target, check the signed-in account and that it is the right person or item, act, then reload and confirm the result. Chrome operations keep their own approval policy. If you cannot, tell the user what failed."
		: "Retrying the same input rarely helps unless the error says the failure is temporary. Do not substitute raw browser or shell steps for this operation without the user's consent; tell the user what failed.";
	if (!outcome.recorded || !target) return base;
	const report = `${issueInboxCall(target)} with data.evidence.failure_fingerprint and the run IDs; notifications.listInboxes({ organization: "${target.organization}" }) returns the report schema. Leave out other people's personal details.`;
	return recovery
		? `${base} Then report it so the connector gets fixed: ${report} Put the controls you used, by their visible labels, in data.diagnosis.checked.`
		: `${base} If Lobu itself looks broken, offer the user a Lobu issue report: ${report}`;
}
