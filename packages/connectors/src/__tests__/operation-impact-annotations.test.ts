import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", () => connectorSdkMock());

type ConnectorDefinition = {
	actions?: Record<
		string,
		{
			kind?: "read" | "write";
			annotations?: { destructiveHint?: boolean };
		}
	>;
};

let github: ConnectorDefinition;
let googleCalendar: ConnectorDefinition;
let googleGmail: ConnectorDefinition;

beforeAll(async () => {
	const [githubModule, calendarModule, gmailModule] = await Promise.all([
		import("../github"),
		import("../google_calendar"),
		import("../google_gmail"),
	]);
	github = new githubModule.default().definition;
	googleCalendar = new calendarModule.default().definition;
	googleGmail = new gmailModule.default().definition;
});

function expectWriteImpact(
	definition: ConnectorDefinition,
	expected: Record<string, "normal" | "high">,
) {
	const writeActions = Object.entries(definition.actions ?? {}).filter(
		([, action]) => action.kind !== "read",
	);
	expect(Object.keys(expected).sort()).toEqual(
		writeActions.map(([key]) => key).sort(),
	);
	for (const [key, action] of writeActions) {
		expect(action.annotations?.destructiveHint === true, key).toBe(
			expected[key] === "high",
		);
	}
}

describe("built-in connector operation impact annotations", () => {
	test("preserves destructive classification independently of org approval policy", () => {
		expectWriteImpact(github, {
			create_issue: "normal",
			add_issue_comment: "normal",
			close_issue: "normal",
			reopen_issue: "normal",
			create_pull_request: "normal",
			merge_pull_request: "high",
		});
		expectWriteImpact(googleCalendar, {
			create_event: "normal",
			update_event: "normal",
			delete_event: "high",
		});
		expectWriteImpact(googleGmail, {
			send_email: "normal",
			create_draft: "normal",
			reply: "normal",
		});
	});
});
