/**
 * X like and follow writes for browser-authenticated connections.
 *
 * Both actions mirror LinkedIn `set_like`: open a scratch tab, read the state
 * from X's stable `data-testid` controls, click only when it differs, reload
 * and re-read the server-backed state, then close the scratch tab. A retry
 * that already matches never toggles. Every page step first proves the
 * signed-in `twid` account is the connection's saved account, the same guard
 * the live DM program uses.
 */

import type { ChromeActionDispatcher } from "@lobu/connector-sdk";
import { normalizeXHandle } from "./x-identity.js";

const origins = ["x.com", "*.x.com", "twitter.com", "*.twitter.com"];

/** Shared page prelude: account guard and a bounded poll. */
function pagePrelude(accountId: string): string {
	return String.raw`
    const accountId = ${JSON.stringify(accountId)};
    const assertAccount = () => {
      const raw = document.cookie.split('; ').find(cookie => cookie.startsWith('twid='));
      const identity = raw ? decodeURIComponent(raw.slice(5)) : '';
      if (!identity) throw new Error('Sign in to X in the paired browser');
      if (identity !== 'u=' + accountId) throw new Error('X account changed or belongs to another account; reconnect this connection');
    };
    const sleep = () => new Promise(resolve => setTimeout(resolve, 200));
    const wait = async (read, test, failure) => {
      for (let i = 0; i < 75; i++) {
        const result = read();
        if (result && test(result)) return result;
        await sleep();
      }
      throw new Error(failure);
    };`;
}

/**
 * Read (and with `desired` set, change) the like state of one focal post.
 * The focal article is the one linking to this status id; X marks the focal
 * post `tabindex="-1"`, which breaks a tie with a reply quoting it.
 */
export function buildXLikeExpression(
	statusId: string,
	accountId: string,
	desired: boolean | null,
): string {
	return String.raw`(async () => {
    const statusId = ${JSON.stringify(statusId)};
    const desired = ${JSON.stringify(desired)};
    ${pagePrelude(accountId)}
    const statusOf = (path) => {
      const parts = path.split('/');
      const at = parts.indexOf('status');
      return at > 0 ? parts[at + 1] : undefined;
    };
    const assertPage = () => {
      assertAccount();
      if ((location.hostname !== 'x.com' && location.hostname !== 'twitter.com') || statusOf(location.pathname) !== statusId)
        throw new Error('X post changed; refusing to like');
    };
    const read = () => {
      assertPage();
      let articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(article =>
        [...article.querySelectorAll('a[href]')].some(link => {
          try { return statusOf(new URL(link.getAttribute('href'), location.href).pathname) === statusId; }
          catch { return false; }
        }));
      if (articles.length > 1) articles = articles.filter(article => article.getAttribute('tabindex') === '-1');
      if (articles.length > 1) throw new Error('X post like control is ambiguous');
      if (!articles.length) return null;
      const buttons = [...articles[0].querySelectorAll('[data-testid="like"], [data-testid="unlike"]')];
      if (buttons.length > 1) throw new Error('X post like control is ambiguous');
      if (!buttons.length) return null;
      const button = buttons[0];
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('X like control is disabled');
      return { button, liked: button.getAttribute('data-testid') === 'unlike' };
    };
    const before = await wait(read, () => true, 'X post like control was not found');
    const changed = desired !== null && before.liked !== desired;
    if (changed) {
      assertPage();
      before.button.click();
      await wait(read, state => state.liked === desired, 'X like state could not be verified');
    }
    const after = read();
    if (!after) throw new Error('X like control disappeared');
    return { liked: after.liked, changed, tweet_id: statusId };
  })()`;
}

/**
 * Read (and with `desired` set, change) whether the signed-in account follows
 * one profile. X keys the profile's control `<userId>-follow`, `-unfollow` or
 * `-cancel` (a pending request to a protected account); suggestion cells are
 * excluded. Unfollowing confirms X's sheet when it asks.
 */
export function buildXFollowExpression(
	handle: string,
	accountId: string,
	desired: boolean | null,
): string {
	return String.raw`(async () => {
    const handle = ${JSON.stringify(handle)};
    const desired = ${JSON.stringify(desired)};
    ${pagePrelude(accountId)}
    const assertPage = () => {
      assertAccount();
      if ((location.hostname !== 'x.com' && location.hostname !== 'twitter.com') || (location.pathname.split('/')[1] || '').toLowerCase() !== handle)
        throw new Error('X profile changed; refusing to follow');
    };
    const ownProfile = () => { throw new Error('Refusing to follow or unfollow the connected X account itself'); };
    const read = () => {
      assertPage();
      if (document.querySelector('[data-testid="editProfileButton"]')) ownProfile();
      const column = document.querySelector('[data-testid="primaryColumn"]');
      if (!column) return null;
      const controls = [...column.querySelectorAll('button[data-testid]')].flatMap(button => {
        if (button.closest('[data-testid="UserCell"]')) return [];
        const testId = button.getAttribute('data-testid');
        const dash = testId.lastIndexOf('-');
        const userId = testId.slice(0, dash);
        const state = testId.slice(dash + 1);
        if (dash < 1 || ![...userId].every(char => char >= '0' && char <= '9')) return [];
        if (state !== 'follow' && state !== 'unfollow' && state !== 'cancel') return [];
        return [{ button, userId, state }];
      });
      if (!controls.length) return null;
      if (controls.some(control => control.userId !== controls[0].userId || control.state !== controls[0].state))
        throw new Error('X profile follow control is ambiguous');
      const control = controls[0];
      if (control.userId === accountId) ownProfile();
      if (control.button.disabled || control.button.getAttribute('aria-disabled') === 'true') throw new Error('X follow control is disabled');
      return control;
    };
    const result = (state, changed) => ({
      following: state.state === 'unfollow',
      pending: state.state === 'cancel',
      changed,
      user_id: state.userId,
      handle,
    });
    const before = await wait(read, () => true, 'X profile follow control was not found');
    if (desired === null) return result(before, false);
    if (before.state === 'cancel') {
      if (desired) return result(before, false);
      throw new Error('A pending X follow request exists; cancelling follow requests is not supported');
    }
    const changed = (before.state === 'unfollow') !== desired;
    if (changed) {
      assertPage();
      before.button.click();
      let confirmed = false;
      await wait(() => {
        const state = read();
        if (!desired && !confirmed && state && state.state === 'unfollow') {
          const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (confirm) { assertPage(); confirm.click(); confirmed = true; }
        }
        return state;
      }, state => state.userId === before.userId && (desired ? state.state !== 'follow' : state.state === 'follow'), 'X follow state could not be verified');
    }
    const after = read();
    if (!after) throw new Error('X follow control disappeared');
    return result(after, changed);
  })()`;
}

/**
 * Open a scratch tab on `url`, apply `desired`, then reload and read the
 * persisted state with no write. Closes only its own scratch tab.
 */
async function writeThenVerify<T>(
	browser: ChromeActionDispatcher,
	url: string,
	desired: boolean,
	build: (desired: boolean | null) => string,
	valid: (value: unknown) => value is T,
): Promise<{ effect: T; persisted: T }> {
	let tabId: number | undefined;
	try {
		const nav = await browser.dispatch<{ tab_id?: number }>("navigate", {
			url,
			new_tab: true,
			wait_for_load: true,
			allowed_origins: origins,
		});
		tabId = nav.tab_id;
		if (typeof tabId !== "number")
			throw new Error("X scratch tab was not created");
		const evaluate = async (state: boolean | null): Promise<T> => {
			const result = await browser.dispatch<{
				value?: unknown;
				exception?: { description?: unknown };
			}>("evaluate", {
				tab_id: tabId,
				expression: build(state),
				allowed_origins: origins,
			});
			const description = result.exception?.description;
			if (typeof description === "string")
				throw new Error(description.split("\n")[0]);
			if (!valid(result.value)) throw new Error("X returned no verified state");
			return result.value;
		};
		const effect = await evaluate(desired);
		// A second navigation reads server-backed state, including on a retry that
		// already matches. Never toggle again after an uncertain write result.
		await browser.dispatch("navigate", {
			url,
			tab_id: tabId,
			wait_for_load: true,
			allowed_origins: origins,
		});
		return { effect, persisted: await evaluate(null) };
	} finally {
		if (typeof tabId === "number")
			await browser.dispatch("close_tab", {
				tab_id: tabId,
				allowed_origins: origins,
			});
	}
}

export interface SetXLikeResult {
	tweet_id: string;
	tweet_url: string;
	liked: boolean;
	changed: boolean;
	verified: true;
}

/** Set the Like on one exact post as the connection's saved account. */
export async function setXLike(
	browser: ChromeActionDispatcher,
	opts: { tweetUrl: string; tweetId: string; accountId: string; liked: boolean },
): Promise<SetXLikeResult> {
	type State = { liked: boolean; changed: boolean; tweet_id: string };
	const { effect, persisted } = await writeThenVerify(
		browser,
		opts.tweetUrl,
		opts.liked,
		(desired) => buildXLikeExpression(opts.tweetId, opts.accountId, desired),
		(value): value is State =>
			typeof (value as State | undefined)?.liked === "boolean" &&
			(value as State).tweet_id === opts.tweetId,
	);
	if (persisted.liked !== opts.liked)
		throw new Error("X like state did not persist after reload");
	return {
		tweet_id: opts.tweetId,
		tweet_url: opts.tweetUrl,
		liked: opts.liked,
		changed: effect.changed,
		verified: true,
	};
}

export interface SetXFollowResult {
	handle: string;
	user_id: string;
	following: boolean;
	/** A follow of a protected account waits for its owner's approval. */
	pending: boolean;
	changed: boolean;
	verified: true;
}

/** Follow or unfollow one profile as the connection's saved account. */
export async function setXFollow(
	browser: ChromeActionDispatcher,
	opts: { handle: string; accountId: string; following: boolean },
): Promise<SetXFollowResult> {
	type State = Omit<SetXFollowResult, "verified">;
	const { effect, persisted } = await writeThenVerify(
		browser,
		`https://x.com/${opts.handle}`,
		opts.following,
		(desired) => buildXFollowExpression(opts.handle, opts.accountId, desired),
		(value): value is State =>
			typeof (value as State | undefined)?.following === "boolean" &&
			typeof (value as State).user_id === "string" &&
			(value as State).handle === opts.handle,
	);
	const settled = opts.following
		? persisted.following || persisted.pending
		: !persisted.following && !persisted.pending;
	if (!settled || persisted.user_id !== effect.user_id)
		throw new Error("X follow state did not persist after reload");
	return {
		handle: opts.handle,
		user_id: persisted.user_id,
		following: persisted.following,
		pending: persisted.pending,
		changed: effect.changed,
		verified: true,
	};
}

/**
 * Accept `name`, `@name` or an x.com / twitter.com profile URL. URLs are read
 * with the URL parser and must name exactly one path segment, so a post or
 * list URL never resolves to its author.
 */
export function parseXHandleInput(raw: string): string | null {
	const value = raw.trim();
	if (!value.startsWith("https://") && !value.startsWith("http://"))
		return normalizeXHandle(value);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	const site = host.startsWith("www.")
		? host.slice(4)
		: host.startsWith("mobile.")
			? host.slice(7)
			: host;
	if (site !== "x.com" && site !== "twitter.com") return null;
	const segments = url.pathname.split("/").filter(Boolean);
	return segments.length === 1 ? normalizeXHandle(segments[0]) : null;
}
