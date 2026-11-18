/**
 * LinkedIn network actions: connection requests (send, withdraw), removing a
 * connection, following people and companies, and listing pending sent
 * invitations. Each write opens a scratch tab on the exact profile or company,
 * acts only through the controls LinkedIn renders for that named member,
 * re-reads the state after a reload, and closes its tab. Controls are matched
 * by their accessible names, which carry the member's name, so a control for
 * another member (sidebars, feeds, sticky headers) is never clicked.
 */

import type {
  ActionContext,
  ActionResult,
  ChromeActionDispatcher,
} from "@lobu/connector-sdk";
import { requireBrowser } from "@lobu/connector-sdk";
import {
  LINKEDIN_ALLOWED_ORIGINS,
  linkedInScriptArgument,
} from "./linkedin-browser-script.js";
import { canonicalCompanyUrl, canonicalProfileUrl } from "./linkedin-search.js";

/**
 * Connection requests this connector sends per LinkedIn account per UTC day
 * from one browser. LinkedIn restricts accounts that invite in bursts well
 * before its own weekly limit, so the connector caps itself.
 */
export const DAILY_CONNECTION_REQUEST_LIMIT = 20;
const MAX_NOTE_CHARS = 300;
const MAX_EMAIL_CHARS = 254;
const MAX_LISTED_INVITATIONS = 200;
const DEFAULT_LISTED_INVITATIONS = 50;
export const SENT_INVITATIONS_URL =
  "https://www.linkedin.com/mynetwork/invitation-manager/sent/";

export type LinkedInNetworkRequest =
  | { op: "read"; kind: "profile" | "company"; path: string }
  | ({ op: "connect"; kind: "profile"; path: string } & InvitationBudget)
  | ({
      op: "invite";
      kind: "profile";
      path: string;
      name: string;
      note: string | null;
      email: string | null;
    } & InvitationBudget)
  | { op: "withdraw" | "remove"; kind: "profile"; path: string; account: string }
  | {
      op: "follow";
      kind: "profile" | "company";
      path: string;
      account: string;
      following: boolean;
    }
  | { op: "list"; limit: number };

/** The signed-in account and its daily invitation allowance. */
interface InvitationBudget {
  account: string;
  daily_limit: number;
  /** UTC day (YYYY-MM-DD) the allowance is counted on. */
  day: string;
}

/** What the page reports about one member or company. */
export interface LinkedInRelationship {
  name: string;
  /** Members only: connected, pending (sent request), none, or unavailable (no Connect offered). */
  relation?: "connected" | "pending" | "none" | "unavailable";
  degree?: string | null;
  following: boolean | null;
}

/** A refusal the page made before acting (nothing was sent or changed). */
interface Refusal {
  refused: string;
  message: string;
}

type PageResult =
  | (LinkedInRelationship & {
      changed?: boolean;
      /** Connect: LinkedIn's invite route for this member, when one can be sent. */
      invite_url?: string;
      requests_sent_today?: number;
      /** The write's own outcome was lost; only the reload can tell whether it landed. */
      uncertain?: string;
    })
  | Refusal;

/**
 * The page program. Requests are passed as inert JSON. Writes check the
 * signed-in member first, act at most once, and leave verification of the
 * persisted state to a fresh read after reload.
 */
export function buildLinkedInNetworkExpression(
  request: LinkedInNetworkRequest
): string {
  return String.raw`(async () => {
    const req = ${linkedInScriptArgument(request)};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const shown = el => !!el && el.getClientRects().length > 0;
    const text = el => (el && (el.innerText || el.textContent) || '').trim();
    const refuse = (refused, message) => ({ refused, message });
    const wait = async (read, message, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        const value = read();
        if (value) return value;
        await sleep(200);
      }
      if (message) throw new Error(message);
      return null;
    };
    const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };
    const pathOf = value => {
      const path = decoded(value).toLowerCase();
      return path.endsWith('/') ? path : path + '/';
    };
    const onTarget = () => {
      if (!location.hostname.endsWith('linkedin.com')) return false;
      const here = pathOf(location.pathname);
      // An invitation is sent from LinkedIn's invite route for the same member.
      if (req.op === 'invite') {
        const vanity = new URLSearchParams(location.search).get('vanityName') || '';
        return here === '/preload/custom-invite/' && '/in/' + vanity.toLowerCase() + '/' === req.path;
      }
      return here.startsWith(req.path);
    };
    const assertPage = () => {
      if (!onTarget()) throw new Error('LinkedIn page changed; refusing to act');
    };
    const assertAccount = async () => {
      const cookie = document.cookie.split('; ').find(c => c.startsWith('JSESSIONID='));
      if (!cookie) throw new Error('Not logged into LinkedIn');
      let csrf = decoded(cookie.slice('JSESSIONID='.length));
      if (csrf.startsWith('"') && csrf.endsWith('"')) csrf = csrf.slice(1, -1);
      const response = await fetch('/voyager/api/me', {
        credentials: 'include',
        headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0' },
      });
      if (!response.ok) throw new Error('LinkedIn account check failed (HTTP ' + response.status + ')');
      const self = await response.json();
      if (self?.miniProfile?.entityUrn !== req.account)
        throw new Error('The signed-in LinkedIn account is not the connected account; refusing to act');
    };
    // LinkedIn renders confirmations as a native <dialog> with no role.
    const dialogs = () => [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')].filter(shown);
    const labelled = root => [root, ...root.querySelectorAll('[aria-label]')]
      .filter(el => shown(el) && el.getAttribute('aria-label'));
    const findLabel = (els, label) => els.filter(el => el.getAttribute('aria-label') === label);
    const enabled = el => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const click = el => {
      assertPage();
      if (!enabled(el)) throw new Error('LinkedIn control is disabled');
      el.click();
    };
    const buttonNamed = (root, names) => [...root.querySelectorAll('button')]
      .filter(b => shown(b) && (names.includes(text(b)) || names.includes(b.getAttribute('aria-label') || '')));
    const dismiss = async dialog => {
      const close = buttonNamed(dialog, ['Dismiss', 'Cancel'])[0];
      if (close) close.click();
      await wait(() => !dialogs().includes(dialog), null, 15);
    };

    // ── Member profile ──────────────────────────────────────────
    const unfollowLabels = name => ['Following, click to unfollow ' + name, 'Following ' + name, 'Unfollow ' + name];
    const hasMore = el => [...el.querySelectorAll('button')].some(b => shown(b) && text(b) === 'More');
    /** The member's own header: the innermost section around the heading that names them. */
    const profileCard = () => {
      let title = document.title;
      if (title.startsWith('(')) title = title.slice(title.indexOf(')') + 1).trim();
      const end = title.lastIndexOf(' | LinkedIn');
      const name = end > 0 ? title.slice(0, end).trim() : '';
      if (!name) return null;
      const heading = [...document.querySelectorAll('main h1, main h2')].find(h => shown(h) && text(h) === name);
      let card = heading;
      while (card && !(card.tagName === 'SECTION' && hasMore(card))) card = card.parentElement;
      if (!card) return null;
      const more = [...card.querySelectorAll('button')].filter(b => shown(b) && text(b) === 'More');
      if (more.length !== 1) throw new Error('LinkedIn profile menu is ambiguous');
      const lines = text(card).split('\n').map(line => line.trim());
      const badge = lines.find(line => line === '· 1st' || line === '· 2nd' || line.startsWith('· 3rd'));
      return { card, name, more: more[0], degree: badge ? badge.slice(2) : null };
    };
    const openMenu = async more => {
      if (more.getAttribute('aria-expanded') !== 'true') more.click();
      return wait(() => document.querySelectorAll('[role="menu"]').length
        ? [...document.querySelectorAll('[role="menu"]')].filter(shown)[0] : null,
        'LinkedIn profile menu did not open');
    };
    const closeMenu = async more => {
      if (more.getAttribute('aria-expanded') === 'true') more.click();
      await wait(() => more.getAttribute('aria-expanded') !== 'true', null, 10);
    };
    /** The member's relationship and the controls that change it; the More menu is left open. */
    const profileState = async () => {
      assertPage();
      const top = await wait(profileCard, 'LinkedIn profile header was not found');
      if (!top.name) throw new Error('LinkedIn profile name was not found');
      const menu = await openMenu(top.more);
      const els = [...labelled(top.card), ...labelled(menu)];
      const one = label => {
        const found = findLabel(els, label);
        return found[0] || null;
      };
      const controls = {
        follow: one('Follow ' + top.name),
        unfollow: unfollowLabels(top.name).map(one).find(Boolean) || null,
        invite: one('Invite ' + top.name + ' to connect'),
        pending: one('Pending, click to withdraw invitation sent to ' + top.name),
        remove: labelled(menu).filter(el => el.getAttribute('aria-label') === 'Remove connection')[0] || null,
      };
      if (controls.follow && controls.unfollow) throw new Error('LinkedIn follow state is ambiguous');
      if ([controls.invite, controls.pending, controls.remove].filter(Boolean).length > 1)
        throw new Error('LinkedIn connection state is ambiguous');
      const relation = controls.pending ? 'pending'
        : controls.remove || top.degree === '1st' ? 'connected'
        : controls.invite ? 'none' : 'unavailable';
      const following = controls.follow ? false : controls.unfollow ? true : null;
      return { top, controls, state: { name: top.name, relation, degree: top.degree, following } };
    };

    // ── Company page ────────────────────────────────────────────
    const companyState = async () => {
      assertPage();
      const read = () => {
        const els = labelled(document.querySelector('main') || document.body);
        const found = [...document.querySelectorAll('main h1, main h2')].filter(shown).map(heading => {
          const name = text(heading);
          const follow = findLabel(els, 'Follow ' + name)[0] || null;
          const unfollow = els.find(el => unfollowLabels(name).includes(el.getAttribute('aria-label'))) || null;
          return { name, follow, unfollow };
        }).filter(match => match.name && (match.follow || match.unfollow));
        // Suggested pages carry their own names, so only the page's heading matches.
        if (found.length > 1) throw new Error('LinkedIn company header is ambiguous');
        return found[0] || null;
      };
      const found = await wait(read, 'LinkedIn company follow control was not found');
      if (found.follow && found.unfollow) throw new Error('LinkedIn follow state is ambiguous');
      return { controls: found, state: { name: found.name, following: !found.follow } };
    };

    /** Wait out a confirmation LinkedIn may show, confirming only the named action. */
    const confirm = async names => {
      const dialog = await wait(() => dialogs()[0] || null, null, 50);
      if (!dialog) return;
      const button = buttonNamed(dialog, names)[0];
      if (!button) {
        const message = text(dialog).slice(0, 300);
        await dismiss(dialog);
        throw new Error('LinkedIn showed an unexpected dialog: ' + message);
      }
      click(button);
      await wait(() => !dialogs().includes(dialog), 'LinkedIn confirmation did not close');
    };

    /** This browser's per-account count of invitations sent today (UTC). */
    const counterKey = () => 'lobu.linkedin.connection_requests.' + req.account + '.' + req.day;
    const sentToday = () => Number(localStorage.getItem(counterKey())) || 0;
    const dailyLimit = () => sentToday() >= req.daily_limit
      ? refuse('daily_limit_reached', 'Already sent ' + sentToday() + ' connection requests today from this browser (limit ' + req.daily_limit + '); try again tomorrow')
      : null;

    if (req.op === 'invite') {
      assertPage();
      await assertAccount();
      const limited = dailyLimit();
      if (limited) return limited;
      const used = sentToday();
      const dialog = await wait(() => dialogs()[0] || null, 'LinkedIn invitation dialog did not open', 50);
      const sendBare = buttonNamed(dialog, ['Send without a note'])[0];
      const addNote = buttonNamed(dialog, ['Add a note'])[0];
      if (!sendBare && !addNote && !buttonNamed(dialog, ['Send invitation'])[0]) {
        const message = text(dialog).slice(0, 300);
        await dismiss(dialog);
        // LinkedIn explains its own invitation limits only in prose.
        return refuse(message.toLowerCase().includes('limit') ? 'invitation_limit_reached' : 'unexpected_dialog', 'LinkedIn did not offer to send an invitation: ' + message);
      }
      const setValue = (field, value) => {
        const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        if (field.value !== value) throw new Error('LinkedIn did not accept the typed value');
      };
      const emailField = [...dialog.querySelectorAll('input[name="email"]')].filter(shown)[0];
      if (emailField) {
        if (!req.email) {
          await dismiss(dialog);
          return refuse('email_required', 'LinkedIn requires ' + req.name + "'s email address before it accepts an invitation; pass email to send one");
        }
        setValue(emailField, req.email);
      }
      let send = sendBare;
      if (req.note) {
        if (addNote) addNote.click();
        const note = await wait(() => [...document.querySelectorAll('textarea[name="message"]')].filter(shown)[0] || null, 'LinkedIn note field did not open');
        setValue(note, req.note);
        send = await wait(() => buttonNamed(document, ['Send invitation'])[0] || null, 'LinkedIn send button was not found');
      }
      if (!send) throw new Error('LinkedIn send button was not found');
      await wait(() => enabled(send), 'LinkedIn kept the send button disabled');
      // Count the attempt before clicking: an uncertain send still spends budget.
      localStorage.setItem(counterKey(), String(used + 1));
      click(send);
      await wait(() => !dialogs().some(d => d === dialog || d.contains(send)), 'LinkedIn invitation dialog did not close');
      const after = dialogs()[0];
      if (after) {
        const message = text(after).slice(0, 300);
        await dismiss(after);
        throw new Error('LinkedIn showed a dialog after sending; check the invitation: ' + message);
      }
      return { name: req.name, relation: 'pending', following: null, changed: true, requests_sent_today: used + 1 };
    }

    if (req.op === 'list') {
      const rows = () => [...document.querySelectorAll('main a[aria-label^="Withdraw invitation sent to "]')].filter(shown).map(link => {
        let row = link.parentElement;
        while (row && row !== document.body && !row.querySelector('a[href*="/in/"]')) row = row.parentElement;
        const profile = row && row.querySelector('a[href*="/in/"]');
        const lines = text(row).split('\n').map(line => line.trim()).filter(Boolean);
        const name = link.getAttribute('aria-label').slice('Withdraw invitation sent to '.length);
        const at = lines.indexOf(name);
        return {
          name,
          headline: at >= 0 && lines[at + 1] && !lines[at + 1].startsWith('Sent ') ? lines[at + 1] : null,
          profile_url: profile ? profile.href : null,
          sent: lines.find(line => line.startsWith('Sent ')) || null,
        };
      });
      await wait(() => document.querySelector('main') && (rows().length || text(document.querySelector('main')).includes('Sent')), 'LinkedIn sent invitations did not load');
      await sleep(800);
      let seen = rows().length;
      for (let i = 0; i < 20 && seen < req.limit; i++) {
        const more = buttonNamed(document, ['Load more', 'Show more', 'Show more results'])[0];
        if (more) more.click(); else window.scrollTo(0, document.body.scrollHeight);
        await sleep(1200);
        const now = rows().length;
        if (now === seen && !more) break;
        seen = now;
      }
      const tab = [...document.querySelectorAll('main a[href*="/invitation-manager/sent/"]')].map(text).find(t => t.startsWith('People'));
      const total = tab ? Number(tab.slice('People'.length).trim().split(' ')[0].split(',').join('')) : NaN;
      const all = rows();
      return { invitations: all.slice(0, req.limit), total: Number.isFinite(total) ? total : null, truncated: all.length > req.limit };
    }

    /**
     * Wait until the page itself shows the change. Returning earlier lets the
     * connector's reload cancel LinkedIn's request while it is still in flight.
     */
    const shows = async (readState, test) => {
      let last = null;
      for (const deadline = Date.now() + 12000; Date.now() < deadline;) {
        await sleep(500);
        last = await readState().catch(error => ({ error: String(error && error.message || error) }));
        if (!last.error && test(last)) return { ...last, changed: true };
      }
      throw new Error('LinkedIn did not show the change on ' + location.href + ': ' + JSON.stringify(last));
    };

    if (req.kind === 'company') {
      const { controls, state } = await companyState();
      if (req.op === 'read' || state.following === req.following) return { ...state, changed: false };
      await assertAccount();
      click(req.following ? controls.follow : controls.unfollow);
      if (!req.following) await confirm(['Unfollow']);
      return shows(async () => (await companyState()).state, now => now.following === req.following);
    }

    const { top, controls, state } = await profileState();
    const done = changed => closeMenu(top.more).then(() => ({ ...state, changed }));
    const profileNow = async () => {
      const now = await profileState();
      await closeMenu(now.top.more);
      return now.state;
    };
    if (req.op === 'read') return done(false);
    await assertAccount();

    if (req.op === 'follow') {
      if (state.following === null) throw new Error('LinkedIn shows no follow control for ' + state.name);
      if (state.following === req.following) return done(false);
      click(req.following ? controls.follow : controls.unfollow);
      if (!req.following) await confirm(['Unfollow']);
      return shows(profileNow, now => now.following === req.following);
    }

    if (req.op === 'withdraw') {
      if (state.relation !== 'pending') return done(false);
      click(controls.pending);
      await confirm(['Withdraw']);
      return shows(profileNow, now => now.relation !== 'pending');
    }

    if (req.op === 'remove') {
      if (state.relation !== 'connected') return done(false);
      if (!controls.remove) throw new Error('LinkedIn shows no Remove connection option for ' + state.name);
      click(controls.remove);
      await confirm(['Remove', 'Remove connection']);
      return shows(profileNow, now => now.relation !== 'connected');
    }

    // connect
    if (state.relation !== 'none') {
      await closeMenu(top.more);
      if (state.relation === 'unavailable')
        return refuse('not_connectable', 'LinkedIn offers no Connect option for ' + state.name + '; they may only accept followers or invitations from people who know their email');
      return { ...state, changed: false };
    }
    const limited = dailyLimit();
    if (limited) {
      await closeMenu(top.more);
      return limited;
    }
    // Connect is a link to LinkedIn's invite route; clicking it reloads the tab,
    // so the connector opens the route itself and sends from there.
    const link = controls.invite.closest('a[href]');
    if (!link || !link.href.startsWith('https://www.linkedin.com/preload/custom-invite/'))
      throw new Error('LinkedIn Connect option has no invitation link');
    await closeMenu(top.more);
    return { ...state, changed: false, invite_url: link.href };
  })()`;
}

async function evaluate<T>(
  browser: ChromeActionDispatcher,
  tabId: number,
  request: LinkedInNetworkRequest
): Promise<T> {
  const result = await browser.dispatch<{ value?: T; exception?: unknown }>(
    "evaluate",
    {
      tab_id: tabId,
      expression: buildLinkedInNetworkExpression(request),
      allowed_origins: LINKEDIN_ALLOWED_ORIGINS,
    }
  );
  if (result.exception || !result.value)
    throw new Error(
      `LinkedIn ${request.op} failed: ${JSON.stringify(result.exception ?? "empty response")}`
    );
  return result.value;
}

async function navigate(
  browser: ChromeActionDispatcher,
  tabId: number,
  url: string
): Promise<void> {
  await browser.dispatch("navigate", {
    url,
    tab_id: tabId,
    wait_for_load: true,
    allowed_origins: LINKEDIN_ALLOWED_ORIGINS,
  });
}

/** Run page work in a scratch tab that is always closed. */
async function inScratchTab<T>(
  browser: ChromeActionDispatcher,
  url: string,
  work: (tabId: number) => Promise<T>
): Promise<T> {
  let tabId: number | undefined;
  try {
    const nav = await browser.dispatch<{ tab_id?: number }>("navigate", {
      url,
      new_tab: true,
      wait_for_load: true,
      allowed_origins: LINKEDIN_ALLOWED_ORIGINS,
    });
    tabId = nav.tab_id;
    if (typeof tabId !== "number")
      throw new Error("LinkedIn scratch tab was not created");
    return await work(tabId);
  } finally {
    if (typeof tabId === "number")
      await browser.dispatch("close_tab", {
        tab_id: tabId,
        allowed_origins: LINKEDIN_ALLOWED_ORIGINS,
      });
  }
}

class InputError extends Error {}

function savedAccount(ctx: ActionContext): string {
  const account = ctx.sessionState?.account_id;
  if (
    typeof account !== "string" ||
    !account.startsWith("urn:li:fs_miniProfile:")
  )
    throw new InputError(
      "LinkedIn actions require the connection's saved account; reconnect this source"
    );
  return account;
}

function profileTarget(input: Record<string, unknown>): {
  url: string;
  path: string;
} {
  const url =
    typeof input.profile_url === "string"
      ? canonicalProfileUrl(input.profile_url)
      : null;
  if (!url)
    throw new InputError(
      "profile_url must be a LinkedIn member profile URL (linkedin.com/in/<slug>)"
    );
  return { url, path: pathOf(url) };
}

function pathOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname).toLowerCase();
}

function optionalString(
  input: Record<string, unknown>,
  name: string,
  max: number
): string | null {
  const value = input[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InputError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max)
    throw new InputError(`${name} must be at most ${max} characters`);
  return trimmed || null;
}

function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Refusal).refused === "string"
  );
}

/** A write that is one page evaluation. */
function once(
  browser: ChromeActionDispatcher,
  request: Exclude<LinkedInNetworkRequest, { op: "read" | "list" }>
) {
  return (tabId: number) => evaluate<PageResult>(browser, tabId, request);
}

/**
 * One write against a member or company: act once, then reload and re-read the
 * persisted state. A retry after an uncertain result finds the state already
 * reached and changes nothing.
 */
async function writeAndVerify(
  browser: ChromeActionDispatcher,
  url: string,
  target: { op: string; kind: "profile" | "company"; path: string },
  act: (tabId: number) => Promise<PageResult>,
  reached: (state: LinkedInRelationship) => boolean
): Promise<ActionResult> {
  return inScratchTab(browser, url, async (tabId) => {
    const effect = await act(tabId);
    if (isRefusal(effect))
      return {
        success: false,
        error: effect.message,
        output: { code: effect.refused },
      };
    await navigate(browser, tabId, url);
    const persisted = await evaluate<LinkedInRelationship>(browser, tabId, {
      op: "read",
      kind: target.kind,
      path: target.path,
    });
    if (!reached(persisted))
      throw new Error(
        effect.uncertain ??
          `LinkedIn ${target.op} did not persist after reload for ${persisted.name}`
      );
    const { requests_sent_today } = effect;
    return {
      success: true,
      output: {
        url,
        name: persisted.name,
        ...(persisted.relation ? { relation: persisted.relation } : {}),
        ...(persisted.degree !== undefined ? { degree: persisted.degree } : {}),
        following: persisted.following,
        changed: effect.changed === true,
        verified: true,
        ...(requests_sent_today ? { requests_sent_today } : {}),
      },
    };
  });
}

async function guarded(
  run: () => Promise<ActionResult>
): Promise<ActionResult> {
  try {
    return await run();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function sendLinkedInConnectionRequest(
  ctx: ActionContext,
  now: Date = new Date()
): Promise<ActionResult> {
  return guarded(async () => {
    const target = profileTarget(ctx.input);
    const note = optionalString(ctx.input, "note", MAX_NOTE_CHARS);
    const email = optionalString(ctx.input, "email", MAX_EMAIL_CHARS);
    if (email && (!email.includes("@") || email.includes(" ")))
      throw new InputError("email must be an email address");
    const budget = {
      account: savedAccount(ctx),
      daily_limit: DAILY_CONNECTION_REQUEST_LIMIT,
      day: now.toISOString().slice(0, 10),
    };
    const browser = requireBrowser(ctx);
    const profile = { kind: "profile" as const, path: target.path };
    return writeAndVerify(
      browser,
      target.url,
      { op: "connect", ...profile },
      async (tabId) => {
        const found = await evaluate<PageResult>(browser, tabId, {
          op: "connect",
          ...profile,
          ...budget,
        });
        if (isRefusal(found) || !found.invite_url) return found;
        const invite = new URL(found.invite_url);
        if (
          invite.origin !== "https://www.linkedin.com" ||
          invite.pathname !== "/preload/custom-invite/"
        )
          throw new Error("LinkedIn offered an unexpected invitation link");
        await navigate(browser, tabId, invite.href);
        try {
          return await evaluate<PageResult>(browser, tabId, {
            op: "invite",
            ...profile,
            ...budget,
            name: found.name,
            note,
            email,
          });
        } catch (error) {
          // Sending can move the tab off the invite route before the page
          // reports back; the reload decides whether the invitation exists.
          return {
            name: found.name,
            following: found.following,
            changed: true,
            uncertain: error instanceof Error ? error.message : String(error),
          };
        }
      },
      (state) => state.relation === "pending" || state.relation === "connected"
    );
  });
}

export function withdrawLinkedInConnectionRequest(
  ctx: ActionContext
): Promise<ActionResult> {
  return guarded(async () => {
    const target = profileTarget(ctx.input);
    const browser = requireBrowser(ctx);
    return writeAndVerify(
      browser,
      target.url,
      { op: "withdraw", kind: "profile", path: target.path },
      once(browser, {
        op: "withdraw",
        kind: "profile",
        path: target.path,
        account: savedAccount(ctx),
      }),
      (state) => state.relation !== "pending"
    );
  });
}

export function removeLinkedInConnection(
  ctx: ActionContext
): Promise<ActionResult> {
  return guarded(async () => {
    const target = profileTarget(ctx.input);
    const browser = requireBrowser(ctx);
    return writeAndVerify(
      browser,
      target.url,
      { op: "remove", kind: "profile", path: target.path },
      once(browser, {
        op: "remove",
        kind: "profile",
        path: target.path,
        account: savedAccount(ctx),
      }),
      (state) => state.relation !== "connected"
    );
  });
}

export function setLinkedInFollow(ctx: ActionContext): Promise<ActionResult> {
  return guarded(async () => {
    const following = ctx.input.following;
    if (typeof following !== "boolean")
      throw new InputError("following must be a boolean");
    const raw = ctx.input.target_url;
    const profile = typeof raw === "string" ? canonicalProfileUrl(raw) : null;
    const company =
      profile || typeof raw !== "string" ? null : canonicalCompanyUrl(raw);
    const url = profile ?? company;
    if (!url)
      throw new InputError(
        "target_url must be a LinkedIn member profile (linkedin.com/in/<slug>) or company page (linkedin.com/company/<slug>) URL"
      );
    const request = {
      op: "follow" as const,
      kind: profile ? ("profile" as const) : ("company" as const),
      path: pathOf(url),
      account: savedAccount(ctx),
      following,
    };
    const browser = requireBrowser(ctx);
    return writeAndVerify(
      browser,
      url,
      request,
      once(browser, request),
      (state) => state.following === following
    );
  });
}

export function listLinkedInSentInvitations(
  ctx: ActionContext
): Promise<ActionResult> {
  return guarded(async () => {
    const raw = ctx.input.limit;
    if (
      raw !== undefined &&
      (typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < 1 ||
        raw > MAX_LISTED_INVITATIONS)
    )
      throw new InputError(
        `limit must be an integer from 1 to ${MAX_LISTED_INVITATIONS}`
      );
    const limit = (raw as number | undefined) ?? DEFAULT_LISTED_INVITATIONS;
    const browser = requireBrowser(ctx);
    const output = await inScratchTab(browser, SENT_INVITATIONS_URL, (tabId) =>
      evaluate<Record<string, unknown>>(browser, tabId, { op: "list", limit })
    );
    return { success: true, output };
  });
}
