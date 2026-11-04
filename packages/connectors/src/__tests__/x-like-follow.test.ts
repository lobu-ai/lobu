import { beforeAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
	buildXFollowExpression,
	buildXLikeExpression,
	parseXHandleInput,
	setXFollow,
	setXLike,
} from "../x-like-follow";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let XConnector: any;
beforeAll(async () => {
	XConnector = (await import("../x")).default;
});

const SELF = "1000";
const PEER = "2000";
const STATUS = "1234567890123";
const postUrl = `https://x.com/synthetic_peer/status/${STATUS}`;
const profileUrl = "https://x.com/synthetic_peer";

function dom(html: string, url: string, account: string | null = SELF) {
	const page = new JSDOM(html, { url, runScripts: "outside-only" });
	if (account) page.window.document.cookie = `twid=u%3D${account}`;
	return page;
}

/** Each click flips a control's test id, the way X re-renders it. */
function toggles(
	page: JSDOM,
	selector: string,
	flip: (testId: string) => string,
	counter: { clicks: number },
) {
	for (const button of page.window.document.querySelectorAll(selector)) {
		(button as HTMLElement).onclick = () => {
			counter.clicks++;
			button.setAttribute(
				"data-testid",
				flip(button.getAttribute("data-testid") ?? ""),
			);
		};
	}
}

function likePage(extra = "", account: string | null = SELF, url = postUrl) {
	const page = dom(
		`<main><article data-testid="tweet" tabindex="-1"><a href="/synthetic_peer/status/${STATUS}"><time>now</time></a><button data-testid="like">Like</button></article>${extra}</main>`,
		url,
		account,
	);
	const counter = { clicks: 0 };
	toggles(
		page,
		"article[tabindex='-1'] button",
		(id) => (id === "like" ? "unlike" : "like"),
		counter,
	);
	return { page, clicks: () => counter.clicks };
}

const reply = `<article data-testid="tweet" tabindex="0"><a href="/synthetic_other/status/999999999"><time>later</time></a><button data-testid="like">Like</button></article>`;

describe("X set_like", () => {
	test("is an idempotent write taking a post and the desired state", () => {
		const action = new XConnector().definition.actions.set_like;
		expect(action.kind).toBe("write");
		expect(action.annotations.idempotentHint).toBe(true);
		expect(action.inputSchema.required).toEqual(["liked"]);
	});

	test("likes the focal post only, does not toggle on retry, and unlikes", async () => {
		const { page, clicks } = likePage(reply);
		const first = await page.window.eval(
			buildXLikeExpression(STATUS, SELF, true),
		);
		expect(first).toEqual({ liked: true, changed: true, tweet_id: STATUS });
		const retry = await page.window.eval(
			buildXLikeExpression(STATUS, SELF, true),
		);
		expect(retry.changed).toBe(false);
		expect(clicks()).toBe(1);
		expect(
			page.window.document.querySelector("article[tabindex='0'] button")
				?.getAttribute("data-testid"),
		).toBe("like");
		const removed = await page.window.eval(
			buildXLikeExpression(STATUS, SELF, false),
		);
		expect(removed).toEqual({ liked: false, changed: true, tweet_id: STATUS });
		expect(clicks()).toBe(2);
		page.window.close();
	});

	test("refuses another post, another account, a signed-out browser and ambiguous controls", async () => {
		const otherFocal = `<article data-testid="tweet" tabindex="-1"><a href="/synthetic_peer/status/${STATUS}">again</a><button data-testid="like">Like</button></article>`;
		for (const [extra, account, url, error] of [
			["", SELF, postUrl.replace("0123", "0456"), "post changed"],
			["", "3000", postUrl, "another account"],
			["", null, postUrl, "Sign in"],
			[otherFocal, SELF, postUrl, "ambiguous"],
		] as const) {
			const { page, clicks } = likePage(extra, account, url);
			await expect(
				page.window.eval(buildXLikeExpression(STATUS, SELF, true)),
			).rejects.toThrow(error);
			expect(clicks()).toBe(0);
			page.window.close();
		}
	});

	test("re-reads after reload and closes only its scratch tab when the like did not persist", async () => {
		const calls: Array<{ key: string; input: Record<string, unknown> }> = [];
		let reads = 0;
		const browser = {
			dispatch: async (key: string, input: Record<string, unknown>) => {
				calls.push({ key, input });
				if (key === "navigate") return { tab_id: 99 };
				if (key === "evaluate") {
					reads++;
					return {
						value: { tweet_id: STATUS, liked: reads === 1, changed: true },
					};
				}
				return {};
			},
		};
		await expect(
			setXLike(browser as never, {
				tweetUrl: postUrl,
				tweetId: STATUS,
				accountId: SELF,
				liked: true,
			}),
		).rejects.toThrow("did not persist");
		expect(calls.map((call) => call.key)).toEqual([
			"navigate",
			"evaluate",
			"navigate",
			"evaluate",
			"close_tab",
		]);
		expect(calls[0].input.new_tab).toBe(true);
		expect(calls.at(-1)?.input.tab_id).toBe(99);
	});

	test("rejects bad input and a connection without a saved account before touching the browser", async () => {
		const browser = {
			dispatch: async () => {
				throw new Error("browser must not be touched");
			},
		};
		const run = (input: Record<string, unknown>, sessionState = {}) =>
			new XConnector().execute({
				actionKey: "set_like",
				input,
				credentials: null,
				config: {},
				sessionState,
				browser,
			});
		expect(
			(await run({ tweet_id: STATUS, liked: "true" }, { account_id: SELF }))
				.error,
		).toContain("liked must be a boolean");
		expect(
			(
				await run(
					{ tweet_url: "https://x.com/synthetic_peer", liked: true },
					{ account_id: SELF },
				)
			).error,
		).toContain("exact X post");
		expect((await run({ tweet_id: STATUS, liked: true })).error).toContain(
			"saved account identity is unavailable",
		);
	});
});

function followPage(
	state: "follow" | "unfollow" | "cancel",
	{ userId = PEER, extra = "", url = profileUrl } = {},
) {
	const page = dom(
		`<main><div data-testid="primaryColumn"><div data-testid="placementTracking"><button data-testid="${userId}-${state}">Follow</button></div><div data-testid="UserCell"><button data-testid="3000-follow">Follow</button></div>${extra}</div></main>`,
		url,
	);
	const document = page.window.document;
	const counter = { clicks: 0, confirms: 0 };
	const control = document.querySelector(
		"[data-testid='placementTracking'] button",
	) as HTMLElement;
	control.onclick = () => {
		counter.clicks++;
		const testId = control.getAttribute("data-testid") ?? "";
		if (testId.endsWith("-follow")) {
			control.setAttribute("data-testid", `${userId}-unfollow`);
			return;
		}
		// Unfollowing waits for X's confirmation sheet.
		const confirm = document.createElement("button");
		confirm.setAttribute("data-testid", "confirmationSheetConfirm");
		confirm.onclick = () => {
			counter.confirms++;
			control.setAttribute("data-testid", `${userId}-follow`);
			confirm.remove();
		};
		document.body.append(confirm);
	};
	return {
		page,
		clicks: () => counter.clicks,
		confirms: () => counter.confirms,
	};
}

describe("X set_follow", () => {
	test("is an idempotent write taking a handle and the desired state", () => {
		const action = new XConnector().definition.actions.set_follow;
		expect(action.kind).toBe("write");
		expect(action.annotations.idempotentHint).toBe(true);
		expect(action.inputSchema.required).toEqual(["handle", "following"]);
	});

	test("follows the profile only, does not toggle on retry, and unfollows through the confirmation sheet", async () => {
		const { page, clicks, confirms } = followPage("follow");
		const followed = await page.window.eval(
			buildXFollowExpression("synthetic_peer", SELF, true),
		);
		expect(followed).toEqual({
			following: true,
			pending: false,
			changed: true,
			user_id: PEER,
			handle: "synthetic_peer",
		});
		const retry = await page.window.eval(
			buildXFollowExpression("synthetic_peer", SELF, true),
		);
		expect(retry.changed).toBe(false);
		expect(clicks()).toBe(1);
		const unfollowed = await page.window.eval(
			buildXFollowExpression("synthetic_peer", SELF, false),
		);
		expect(unfollowed).toMatchObject({ following: false, changed: true });
		expect(clicks()).toBe(2);
		expect(confirms()).toBe(1);
		expect(
			page.window.document
				.querySelector("[data-testid='UserCell'] button")
				?.getAttribute("data-testid"),
		).toBe("3000-follow");
		page.window.close();
	});

	test("keeps a pending request and refuses to cancel it", async () => {
		const pending = followPage("cancel");
		expect(
			await pending.page.window.eval(
				buildXFollowExpression("synthetic_peer", SELF, true),
			),
		).toMatchObject({ following: false, pending: true, changed: false });
		await expect(
			pending.page.window.eval(
				buildXFollowExpression("synthetic_peer", SELF, false),
			),
		).rejects.toThrow("pending X follow request");
		expect(pending.clicks()).toBe(0);
		pending.page.window.close();
	});

	test("refuses the connected account, another profile and ambiguous controls", async () => {
		for (const [options, error] of [
			[{ userId: SELF }, "connected X account itself"],
			[
				{ extra: '<a data-testid="editProfileButton">Edit profile</a>' },
				"connected X account itself",
			],
			[{ url: "https://x.com/synthetic_other" }, "profile changed"],
			[
				{ extra: '<button data-testid="4000-unfollow">Following</button>' },
				"ambiguous",
			],
		] as const) {
			const { page, clicks } = followPage("follow", options);
			await expect(
				page.window.eval(buildXFollowExpression("synthetic_peer", SELF, true)),
			).rejects.toThrow(error);
			expect(clicks()).toBe(0);
			page.window.close();
		}
	});

	test("fails when the follow does not persist after reload", async () => {
		let reads = 0;
		const browser = {
			dispatch: async (key: string) => {
				if (key === "navigate") return { tab_id: 5 };
				if (key === "evaluate") {
					reads++;
					return {
						value: {
							handle: "synthetic_peer",
							user_id: PEER,
							following: reads === 1,
							pending: false,
							changed: true,
						},
					};
				}
				return {};
			},
		};
		await expect(
			setXFollow(browser as never, {
				handle: "synthetic_peer",
				accountId: SELF,
				following: true,
			}),
		).rejects.toThrow("did not persist");
	});

	test("reads handles and profile URLs, never a post or foreign URL", () => {
		expect(parseXHandleInput("@Synthetic_Peer")).toBe("synthetic_peer");
		expect(parseXHandleInput("https://x.com/Synthetic_Peer/")).toBe(
			"synthetic_peer",
		);
		expect(parseXHandleInput("https://mobile.twitter.com/synthetic_peer")).toBe(
			"synthetic_peer",
		);
		for (const raw of [
			`https://x.com/synthetic_peer/status/${STATUS}`,
			"https://example.com/synthetic_peer",
			"x.com/synthetic_peer",
			"not a handle",
		]) {
			expect(parseXHandleInput(raw)).toBeNull();
		}
	});
});
