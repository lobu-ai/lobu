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

/**
 * Guidance returned with a failed operation run. The fingerprint is the
 * failure's issue grouping key; a report that cites it joins the issue the
 * tracker opened, or opens it.
 */
export function failedOperationNextAction(
	target: IssueInbox | null = issueInbox(),
): string {
	const base =
		"Retrying the same input rarely helps unless the error says the failure is temporary. Do not substitute raw browser or shell steps for this operation without the user's consent; tell the user what failed.";
	if (!target) return base;
	return `${base} If Lobu itself looks broken, offer the user a Lobu issue report: ${issueInboxCall(target)} with data.evidence.failure_fingerprint and the run IDs; notifications.listInboxes({ organization: "${target.organization}" }) returns the report schema. Leave out other people's personal details.`;
}
