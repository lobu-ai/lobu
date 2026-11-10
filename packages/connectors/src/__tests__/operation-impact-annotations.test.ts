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
	});

	// Google actions are compiled one per API method, so the write set is
	// Discovery's; these pin the classes: DELETE is destructive, a POST that
	// destroys data irreversibly is too, and a reversible one (trash) is not.
	test.each([
		["calendar", "events_delete", "high"],
		["calendar", "calendars_clear", "high"],
		["calendar", "events_insert", "normal"],
		["calendar", "events_patch", "normal"],
		["gmail", "users_messages_delete", "high"],
		["gmail", "users_messages_batchDelete", "high"],
		["gmail", "users_messages_trash", "normal"],
		["gmail", "send_email", "normal"],
		["gmail", "create_draft", "normal"],
		["gmail", "reply", "normal"],
	] as const)("google %s %s is %s impact", (api, key, impact) => {
		const action = (api === "calendar" ? googleCalendar : googleGmail).actions?.[key];
		expect(action).toBeDefined();
		expect(action?.kind).not.toBe("read");
		expect(action?.annotations?.destructiveHint === true).toBe(impact === "high");
	});
});
