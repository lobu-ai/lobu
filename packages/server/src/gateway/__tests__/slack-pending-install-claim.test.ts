/**
 * Phase 2 of the Slack marketplace "claim" flow: after a Slack-initiated
 * (marketplace) install is parked as a pending, unclaimed row,
 * `completeSlackPendingInstall` DMs the INSTALLER their connect link.
 *
 * This unit test stubs the Slack Web API (no HTTP), the pending-install store
 * (no DB), and the hosted-app credentials so the DM routing is exercised in
 * isolation. It proves the DM posted to the installer carries the connect URL
 * keyed by the team id and no secret token — authority is the Slack
 * workspace-admin check at claim time.
 *
 * IMPORTANT: never replace an entire module with `mock.module` without spreading
 * the real exports. This suite shares a process with every other gateway suite,
 * and bun's `mock.module` is process-global and cannot be undone by
 * `mock.restore()`. A prior whole-module stub of slack-installations returning
 * null from getSlackInstallByTeamId broke slack-connection-coordinator tests
 * that co-run in the same `bun test src/gateway/__tests__` process.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { __resetPublicOriginCachesForTests } from "../../utils/public-origin.js";
import * as appInstallCredentials from "../installation/app-install-credentials.js";
import * as slackInstallations from "../../lobu/stores/slack-installations.js";
import * as slackWeb from "../connections/slack-web.js";

// --- Stub the pending-install store: capture inputs, never touch Postgres. ---
const writeCalls: Array<Record<string, unknown>> = [];
const writeSlackPendingInstallMock = mock(
	async (input: Record<string, unknown>) => {
		writeCalls.push(input);
		return { id: "1" };
	},
);

// --- Stub the Slack Web API surface the coordinator uses. ---
const exchangeOAuthCode = mock(
	async (): Promise<{
		botToken: string;
		teamId: string;
		teamName: string | null;
		botUserId: string | null;
		authedUserId: string | null;
		isEnterpriseInstall: boolean;
		enterpriseId: string | null;
	}> => ({
		botToken: "xoxb-installer-token",
		teamId: "T-CLAIM",
		teamName: "Acme",
		botUserId: "B123",
		authedUserId: "U-INSTALLER",
		isEnterpriseInstall: false,
		enterpriseId: null,
	}),
);
const openDm = mock(async () => "D-INSTALLER");
const postMessage = mock(async () => undefined);
async function loadCoordinator() {
	const mod = await import("../connections/slack-connection-coordinator.js");
	return mod.completeSlackPendingInstall;
}

function callbackRequest(): Request {
	return new Request(
		"https://gateway.example.com/slack/oauth_callback?code=the-code",
		{ method: "GET" },
	);
}

describe("completeSlackPendingInstall — installer claim DM", () => {
	let savedWebUrl: string | undefined;
	// Hold spy handles so afterAll restores ONLY these — mock.restore() is
	// process-global and would wipe spies installed by co-running suites.
	let primedMethodSpy: ReturnType<typeof spyOn>;
	let resolveCredsSpy: ReturnType<typeof spyOn>;
	let writePendingSpy: ReturnType<typeof spyOn>;
	let createWebApiSpy: ReturnType<typeof spyOn>;

	beforeAll(() => {
		// Hosted app credentials are "configured" so `completeSlackPendingInstall`'s
		// exchange path runs (a truthy primed method + non-empty client id/secret).
		// Use spyOn (restored in afterAll) — process-global mock.module cannot be
		// undone and would clobber co-running suites.
		primedMethodSpy = spyOn(
			appInstallCredentials,
			"getPrimedBundledMethod",
		).mockReturnValue({
			clientIdKey: "SLACK_CLIENT_ID",
			clientSecretKey: "SLACK_CLIENT_SECRET",
		} as unknown as ReturnType<
			typeof appInstallCredentials.getPrimedBundledMethod
		>);
		resolveCredsSpy = spyOn(
			appInstallCredentials,
			"resolveAppInstallCredentials",
		).mockReturnValue({
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		writePendingSpy = spyOn(
			slackInstallations,
			"writeSlackPendingInstall",
		).mockImplementation(
			writeSlackPendingInstallMock as typeof slackInstallations.writeSlackPendingInstall,
		);
		createWebApiSpy = spyOn(slackWeb, "createSlackWebApi").mockImplementation(
			() =>
				({
					exchangeOAuthCode,
					openDm,
					postMessage,
					conversationMembers: async () => [],
					conversationInfo: async () => ({
						name: null,
						isPrivate: false,
						contextTeamId: null,
					}),
					usersInfo: async () => ({ isAdmin: false, isOwner: false }),
					revokeToken: async () => true,
					authTest: async () => ({ teamId: "T-CLAIM" }),
				}) as unknown as ReturnType<typeof slackWeb.createSlackWebApi>,
		);
	});

	afterAll(() => {
		primedMethodSpy.mockRestore();
		resolveCredsSpy.mockRestore();
		writePendingSpy.mockRestore();
		createWebApiSpy.mockRestore();
	});

	beforeEach(() => {
		writeCalls.length = 0;
		writeSlackPendingInstallMock.mockClear();
		exchangeOAuthCode.mockClear();
		openDm.mockClear();
		postMessage.mockClear();
		savedWebUrl = process.env.PUBLIC_GATEWAY_URL;
		process.env.PUBLIC_GATEWAY_URL = "https://app.lobu.ai/lobu";
		__resetPublicOriginCachesForTests();
	});

	afterEach(() => {
		if (savedWebUrl === undefined) delete process.env.PUBLIC_GATEWAY_URL;
		else process.env.PUBLIC_GATEWAY_URL = savedWebUrl;
		__resetPublicOriginCachesForTests();
	});

	test("DMs the installer a connect link with the team id (no secret token)", async () => {
		const completeSlackPendingInstall = await loadCoordinator();

		const result = await completeSlackPendingInstall(
			callbackRequest(),
			"https://gateway.example.com/slack/oauth_callback",
			null,
		);

		expect(result).toEqual({
			externalRef: "T-CLAIM",
			subjectName: "Acme",
		});

		// The DM is opened with the installer and the message is posted into it.
		expect(openDm).toHaveBeenCalledTimes(1);
		expect(openDm).toHaveBeenCalledWith("xoxb-installer-token", "U-INSTALLER");
		expect(postMessage).toHaveBeenCalledTimes(1);
		const [botToken, channel, text] = postMessage.mock.calls[0] as [
			string,
			string,
			string,
		];
		expect(botToken).toBe("xoxb-installer-token");
		expect(channel).toBe("D-INSTALLER");
		// The posted text embeds the provider-agnostic connect URL with the team id
		// as the ref — no secret token (authority is the Slack workspace-admin
		// check at claim time).
		const match = text.match(
			/https:\/\/app\.lobu\.ai\/connector\/slack\/connection\?ref=([^&\s|>]+)/,
		);
		expect(match).not.toBeNull();
		const [, refParam] = match as RegExpMatchArray;
		expect(decodeURIComponent(refParam)).toBe("T-CLAIM");
		expect(text).not.toContain("&t=");
		expect(text).not.toContain("xoxb-installer-token");

		// The pending row is parked with the installer id and no token material.
		expect(writeCalls).toHaveLength(1);
		const parked = writeCalls[0]!;
		expect(parked.installerUserId).toBe("U-INSTALLER");
	});
});
