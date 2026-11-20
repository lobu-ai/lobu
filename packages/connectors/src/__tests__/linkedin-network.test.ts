import { beforeAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);
let LinkedIn: any;
let network: typeof import("../linkedin-network");
beforeAll(async () => {
  LinkedIn = (await import("../linkedin")).default;
  network = await import("../linkedin-network");
});

const ACCOUNT = "urn:li:fs_miniProfile:ACoSYNTHETIC0001";
const PROFILE = "https://www.linkedin.com/in/ada-example/";
const COMPANY = "https://www.linkedin.com/company/example-co/";
const INVITE =
  "https://www.linkedin.com/preload/custom-invite/?vanityName=ada-example";
const SLOW = 30_000;

type Relation = "none" | "pending" | "connected" | "unavailable";
interface Member {
  relation: Relation;
  following: boolean;
  invitation?: { note: string | null; email: string | null };
}

/**
 * A simulated LinkedIn: `world` is what LinkedIn has stored, the rendered page
 * is what the tab shows. With `persist: false` the page shows a change that
 * LinkedIn never stores, so only the reload can catch it.
 */
function linkedIn(
  member: Partial<Member> = {},
  options: {
    emailRequired?: boolean;
    persist?: boolean;
    signedIn?: string;
    company?: { following: boolean };
    sentTotal?: number;
    /** Accounts without an overflow menu see the relationship control in the header itself. */
    header?: "menu" | "buttons" | "unrecognized";
  } = {}
) {
  const world = {
    member: { relation: "none", following: false, ...member } as Member,
    company: { following: false, ...options.company },
    invitationsSent: 0,
    foreignClicks: [] as string[],
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.linkedin.com/feed/",
    runScripts: "outside-only",
  });
  const win = dom.window;
  const doc = win.document;
  win.HTMLElement.prototype.getClientRects = function (this: Element) {
    return (this.isConnected && !this.closest("[hidden]") ? [{ width: 1 }] : []) as any;
  };
  win.scrollTo = () => {};
  // Web Locks: one queue per browser, shared by every tab.
  let tail: Promise<unknown> = Promise.resolve();
  let lockWaiters = 0;
  const holdLock = () => {
    let release!: () => void;
    const prior = tail;
    tail = prior.then(() => new Promise<void>((resolve) => (release = resolve)));
    return () => release();
  };
  Object.defineProperty(win.navigator, "locks", {
    value: {
      request: async (_name: string, work: () => Promise<unknown>) => {
        const prior = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => (release = resolve));
        lockWaiters++;
        await prior;
        lockWaiters--;
        try {
          return await work();
        } finally {
          release();
        }
      },
    },
  });
  doc.cookie = 'JSESSIONID="ajax:0000000000000000001"; path=/';
  (win as any).fetch = async (url: string) =>
    url === "/voyager/api/me"
      ? {
          ok: true,
          status: 200,
          json: async () => ({
            miniProfile: { entityUrn: options.signedIn ?? ACCOUNT },
          }),
        }
      : { ok: false, status: 404, json: async () => ({}) };

  let page: Member = { ...world.member };
  let companyPage = { ...world.company };
  const store = (change: Partial<Member>) => {
    Object.assign(page, change);
    if (options.persist !== false) Object.assign(world.member, change);
  };
  const html = (markup: string) => {
    const template = doc.createElement("template");
    template.innerHTML = markup.trim();
    return template.content.firstElementChild as HTMLElement;
  };
  const on = (root: ParentNode, selector: string, handler: () => void) => {
    for (const el of root.querySelectorAll<HTMLElement>(selector))
      el.onclick = handler;
  };
  const foreign = (root: ParentNode) => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-foreign]"))
      el.onclick = () => world.foreignClicks.push(el.getAttribute("aria-label") ?? el.textContent ?? "");
  };
  const confirmDialog = (action: string, then: () => void) => {
    const dialog = html(`<dialog open>
<p>${action}?</p>
<button aria-label="Dismiss">x</button>
<button>Cancel</button>
<button>${action}</button>
</dialog>`);
    doc.body.append(dialog);
    const [dismiss, cancel, ok] = dialog.querySelectorAll("button");
    dismiss.onclick = cancel.onclick = () => dialog.remove();
    ok.onclick = () => {
      dialog.remove();
      then();
    };
  };

  const profileTop = () => {
    const top = doc.getElementById("top")!;
    doc.querySelector('[role="menu"]')?.remove();
    if (options.header === "unrecognized") {
      top.innerHTML = `
<h2>Ada Example</h2>
<button>Get in touch</button>
<button>Ada Example's links</button>
<a href="#" aria-label="Share Ada Example's profile"></a>`;
      return;
    }
    if (options.header === "buttons") {
      const action =
        page.relation === "none"
          ? `<a href="${INVITE}" aria-label="Invite Ada Example to connect">Connect</a>`
          : page.relation === "pending"
            ? '<button aria-label="Pending, click to withdraw invitation sent to Ada Example">Pending</button>'
            : "";
      top.innerHTML = `
<h2>Ada Example</h2>
<span>· ${page.relation === "connected" ? "1st" : "2nd"}</span>
${action}
<button>Message</button>`;
      on(top, "a", () => world.foreignClicks.push("Connect header link"));
      on(top, '[aria-label^="Pending"]', () =>
        confirmDialog("Withdraw", () => {
          store({ relation: "none", invitation: undefined });
          profileTop();
        })
      );
      return;
    }
    top.innerHTML = `
<h2>Ada Example</h2>
<span>· ${page.relation === "connected" ? "1st" : "2nd"}</span>
<button aria-label="${page.following ? "Following, click to unfollow Ada Example" : "Follow Ada Example"}">${page.following ? "Following" : "Follow"}</button>
<button aria-expanded="false">More</button>`;
    on(top, '[aria-label="Follow Ada Example"]', () => {
      store({ following: true });
      profileTop();
    });
    on(top, '[aria-label^="Following, click to unfollow"]', () =>
      confirmDialog("Unfollow", () => {
        store({ following: false });
        profileTop();
      })
    );
    const more = top.querySelector<HTMLElement>("[aria-expanded]")!;
    more.onclick = () => {
      const open = doc.querySelector('[role="menu"]');
      if (open) {
        open.remove();
        more.setAttribute("aria-expanded", "false");
        return;
      }
      const item =
        page.relation === "none"
          ? `<a role="menuitem" href="${INVITE}"><div aria-label="Invite Ada Example to connect">Connect</div></a>`
          : page.relation === "pending"
            ? '<div role="menuitem" aria-label="Pending, click to withdraw invitation sent to Ada Example">Pending</div>'
            : page.relation === "connected"
              ? '<div role="menuitem" aria-label="Remove connection">Remove connection</div>'
              : "";
      const menu = html(`<div role="menu"><div role="menuitem">Save to PDF</div>${item}</div>`);
      doc.body.append(menu);
      more.setAttribute("aria-expanded", "true");
      // The Connect item navigates the whole tab; the connector must open the
      // invite route itself instead of clicking it.
      on(menu, "a", () => world.foreignClicks.push("Connect menu link"));
      on(menu, '[aria-label^="Pending"]', () => {
        profileTop();
        confirmDialog("Withdraw", () => {
          store({ relation: "none", invitation: undefined });
          profileTop();
        });
      });
      on(menu, '[aria-label="Remove connection"]', () => {
        profileTop();
        confirmDialog("Remove", () => {
          store({ relation: "none" });
          profileTop();
        });
      });
    };
  };

  const render = (url: string) => {
    dom.reconfigure({ url });
    page = { ...world.member };
    companyPage = { ...world.company };
    // LinkedIn serves member and company paths case-insensitively.
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname === "/in/ada-example/") {
      doc.title = "(3) Ada Example | LinkedIn";
      doc.body.innerHTML = `<main>
<section id="top"></section>
<aside><section>
<h2>Other Person</h2>
<button data-foreign aria-label="Follow Other Person">Follow</button>
<button data-foreign>More</button>
</section></aside>
</main>`;
      profileTop();
    } else if (pathname === "/company/example-co/") {
      doc.title = "Example Co | LinkedIn";
      const companyTop = () => {
        const top = doc.getElementById("company")!;
        top.innerHTML = `<h1>Example Co</h1>
<button aria-label="${companyPage.following ? "Following, click to unfollow Example Co" : "Follow Example Co"}">Follow</button>`;
        on(top, '[aria-label="Follow Example Co"]', () => {
          companyPage.following = true;
          if (options.persist !== false) world.company.following = true;
          companyTop();
        });
        on(top, '[aria-label^="Following"]', () =>
          confirmDialog("Unfollow", () => {
            companyPage.following = false;
            if (options.persist !== false) world.company.following = false;
            companyTop();
          })
        );
      };
      doc.body.innerHTML = `<main>
<section id="company"></section>
<aside><h2>Pages people also viewed</h2>
<div><span>Other Co</span><button data-foreign aria-label="Follow Other Co">Follow</button></div>
</aside>
</main>`;
      companyTop();
    } else if (pathname === "/preload/custom-invite/") {
      doc.title = "LinkedIn";
      doc.body.innerHTML = `<div role="dialog" aria-labelledby="send-invite-modal">
<h2 id="send-invite-modal">Add a note to your invitation?</h2>
${options.emailRequired ? '<label>Email <input name="email" type="email"></label>' : ""}
<button aria-label="Dismiss">x</button>
<button>Add a note</button>
<button>Send without a note</button>
</div>`;
      const dialog = doc.querySelector<HTMLElement>('[role="dialog"]')!;
      const email = dialog.querySelector<HTMLInputElement>('input[name="email"]');
      const gate = () => {
        for (const button of dialog.querySelectorAll("button"))
          if (button.textContent?.startsWith("Send"))
            button.disabled = !!email && !email.value;
      };
      email?.addEventListener("input", gate);
      gate();
      const send = () => {
        world.invitationsSent++;
        const note = dialog.querySelector("textarea");
        store({
          relation: "pending",
          invitation: { note: note?.value ?? null, email: email?.value ?? null },
        });
        dialog.remove();
      };
      const [dismiss, addNote, sendBare] = dialog.querySelectorAll("button");
      dismiss.onclick = () => dialog.remove();
      sendBare.onclick = send;
      addNote.onclick = () => {
        addNote.remove();
        sendBare.remove();
        dialog.append(html('<textarea name="message"></textarea>'), html("<button>Send invitation</button>"));
        dialog.querySelector<HTMLElement>("button:last-of-type")!.onclick = send;
        gate();
      };
    } else if (pathname === "/mynetwork/invitation-manager/sent/") {
      doc.title = "Sent invitations | LinkedIn";
      const rows = [
        ["ada-example", "Ada Example", "Engineer at Example Co", "2 days ago"],
        ["bo-sample", "Bo Sample", "Founder", "1 week ago"],
      ];
      doc.body.innerHTML = `<main>
<nav><a href="https://www.linkedin.com/mynetwork/invitation-manager/sent/">People ${options.sentTotal ?? 2}</a></nav>
<ul>${rows
        .map(
          ([slug, name, headline, when]) => `<li>
<a href="https://www.linkedin.com/in/${slug}/">${name}</a>
<p>${headline}</p>
<span>Sent ${when}</span>
<a href="#" aria-label="Withdraw invitation sent to ${name}">Withdraw</a>
</li>`
        )
        .join("")}</ul>
</main>`;
    } else {
      throw new Error(`unexpected navigation to ${url}`);
    }
    foreign(doc);
  };

  const calls: Array<{ key: string; input: any }> = [];
  let tabs = 0;
  const browser = {
    dispatch: async (key: string, input: any) => {
      calls.push({ key, input });
      if (key === "navigate") {
        render(input.url);
        return { tab_id: input.new_tab ? ++tabs : input.tab_id };
      }
      if (key === "evaluate") {
        try {
          return { value: await win.eval(input.expression) };
        } catch (error) {
          return { exception: error instanceof Error ? error.message : String(error) };
        }
      }
      if (key === "close_tab") return {};
      throw new Error(`unexpected browser action ${key}`);
    },
  };
  const ctx = (actionKey: string, input: Record<string, unknown>) => ({
    actionKey,
    input,
    sessionState: { account_id: ACCOUNT },
    browser,
    run: { id: 1 },
  });
  const run = (actionKey: string, input: Record<string, unknown>) =>
    new LinkedIn().execute(ctx(actionKey, input));
  const tabsClosed = () =>
    calls.filter((call) => call.key === "close_tab").length ===
    calls.filter((call) => call.key === "navigate" && call.input.new_tab).length;
  return { world, win, calls, ctx, run, tabsClosed, holdLock, lockWaiters: () => lockWaiters };
}

test(
  "sends a connection request with a note from the invite route, once",
  async () => {
    const li = linkedIn();
    const sent = await li.run("send_connection_request", {
      profile_url: "https://linkedin.com/in/ada-example?trk=search",
      note: "  Hi Ada, enjoyed your talk.  ",
    });
    expect(sent).toMatchObject({
      success: true,
      output: {
        url: PROFILE,
        name: "Ada Example",
        relation: "pending",
        changed: true,
        verified: true,
        requests_sent_today: 1,
      },
    });
    expect(li.world.member.invitation).toEqual({
      note: "Hi Ada, enjoyed your talk.",
      email: null,
    });
    expect(li.calls.filter((c) => c.key === "navigate").map((c) => c.input.url)).toEqual([
      PROFILE,
      INVITE,
      PROFILE,
    ]);

    const retry = await li.run("send_connection_request", { profile_url: PROFILE });
    expect(retry).toMatchObject({
      success: true,
      output: { relation: "pending", changed: false, verified: true },
    });
    expect(li.world.invitationsSent).toBe(1);
    expect(li.world.foreignClicks).toEqual([]);
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "refuses when LinkedIn asks for the member's email, then sends with it",
  async () => {
    const li = linkedIn({}, { emailRequired: true });
    const refused = await li.run("send_connection_request", { profile_url: PROFILE });
    expect(refused).toMatchObject({
      success: false,
      output: { code: "email_required" },
    });
    expect(li.world.invitationsSent).toBe(0);
    expect(li.world.member.relation).toBe("none");

    const sent = await li.run("send_connection_request", {
      profile_url: PROFILE,
      email: "ada@example.com",
    });
    expect(sent).toMatchObject({ success: true, output: { relation: "pending" } });
    expect(li.world.member.invitation).toEqual({ note: null, email: "ada@example.com" });
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "stops at the daily cap and refuses members LinkedIn offers no Connect for",
  async () => {
    const li = linkedIn();
    const day = new Date("2030-01-02T09:00:00Z");
    li.win.localStorage.setItem(
      `lobu.linkedin.connection_requests.${ACCOUNT}.2030-01-02`,
      String(network.DAILY_CONNECTION_REQUEST_LIMIT)
    );
    const capped = await network.sendLinkedInConnectionRequest(
      li.ctx("send_connection_request", { profile_url: PROFILE }) as any,
      day
    );
    expect(capped).toMatchObject({ success: false, output: { code: "daily_limit_reached" } });
    expect(li.world.invitationsSent).toBe(0);
    // The next UTC day has a fresh allowance.
    const nextDay = await network.sendLinkedInConnectionRequest(
      li.ctx("send_connection_request", { profile_url: PROFILE }) as any,
      new Date("2030-01-03T09:00:00Z")
    );
    expect(nextDay).toMatchObject({ success: true, output: { requests_sent_today: 1 } });

    // Another tab spends the last request while this send waits for the lock.
    const racing = linkedIn();
    const counter = `lobu.linkedin.connection_requests.${ACCOUNT}.2030-01-02`;
    racing.win.localStorage.setItem(counter, String(network.DAILY_CONNECTION_REQUEST_LIMIT - 1));
    const release = racing.holdLock();
    const pending = network.sendLinkedInConnectionRequest(
      racing.ctx("send_connection_request", { profile_url: PROFILE }) as any,
      day
    );
    while (!racing.lockWaiters()) await new Promise((resolve) => setTimeout(resolve, 20));
    racing.win.localStorage.setItem(counter, String(network.DAILY_CONNECTION_REQUEST_LIMIT));
    release();
    expect(await pending).toMatchObject({ success: false, output: { code: "daily_limit_reached" } });
    expect(racing.world.invitationsSent).toBe(0);
    expect(racing.tabsClosed()).toBe(true);

    const closed = linkedIn({ relation: "unavailable" });
    const refused = await closed.run("send_connection_request", { profile_url: PROFILE });
    expect(refused).toMatchObject({ success: false, output: { code: "not_connectable" } });
    expect(closed.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "follows and unfollows a member and a company without touching other controls",
  async () => {
    const li = linkedIn();
    for (const following of [true, false, false]) {
      const result = await li.run("set_follow", { target_url: PROFILE, following });
      expect(result).toMatchObject({
        success: true,
        output: { name: "Ada Example", following, relation: "none", degree: "2nd", verified: true },
      });
      expect(li.world.member.following).toBe(following);
    }
    for (const following of [true, false]) {
      const result = await li.run("set_follow", {
        target_url: "https://www.linkedin.com/company/example-co/posts/",
        following,
      });
      expect(result).toMatchObject({
        success: true,
        output: { url: COMPANY, name: "Example Co", following, changed: true, verified: true },
      });
      expect(li.world.company.following).toBe(following);
    }
    expect(li.world.foreignClicks).toEqual([]);
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "withdraws a pending request and removes a connection after confirming",
  async () => {
    const pending = linkedIn({ relation: "pending" });
    const withdrawn = await pending.run("withdraw_connection_request", { profile_url: PROFILE });
    expect(withdrawn).toMatchObject({
      success: true,
      output: { relation: "none", changed: true, verified: true },
    });
    expect(pending.world.member.relation).toBe("none");

    const connected = linkedIn({ relation: "connected" });
    const removed = await connected.run("remove_connection", { profile_url: PROFILE });
    expect(removed).toMatchObject({
      success: true,
      output: { relation: "none", changed: true, verified: true },
    });
    // Nothing to remove twice.
    const again = await connected.run("remove_connection", { profile_url: PROFILE });
    expect(again).toMatchObject({ success: true, output: { changed: false } });
    expect(connected.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "connects and withdraws from a header that shows Connect and Message but no More menu",
  async () => {
    const li = linkedIn({}, { header: "buttons" });
    const sent = await li.run("send_connection_request", { profile_url: PROFILE });
    expect(sent).toMatchObject({
      success: true,
      output: { name: "Ada Example", relation: "pending", changed: true, verified: true },
    });
    expect(li.world.invitationsSent).toBe(1);

    const withdrawn = await li.run("withdraw_connection_request", { profile_url: PROFILE });
    expect(withdrawn).toMatchObject({
      success: true,
      output: { relation: "none", changed: true, verified: true },
    });
    expect(li.world.member.relation).toBe("none");

    // Removing needs the overflow menu; without one the connector says so.
    const connected = linkedIn({ relation: "connected" }, { header: "buttons" });
    const removed = await connected.run("remove_connection", { profile_url: PROFILE });
    expect(removed.success).toBe(false);
    expect(removed.error).toContain("no Remove connection option");
    expect(li.world.foreignClicks).toEqual([]);
    expect(li.tabsClosed()).toBe(true);
    expect(connected.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "names the controls of an unrecognized header without naming the member",
  async () => {
    const li = linkedIn({}, { header: "unrecognized" });
    const result = await li.run("send_connection_request", { profile_url: PROFILE });
    expect(result.success).toBe(false);
    expect(result.error).toContain("profile header was not found; the page shows: Get in touch");
    expect(result.error).not.toContain("Ada");
    expect(li.world.invitationsSent).toBe(0);
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "fails when the page shows a change LinkedIn did not store, and still closes its tab",
  async () => {
    const li = linkedIn({}, { persist: false });
    const result = await li.run("set_follow", { target_url: PROFILE, following: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("did not persist");
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "refuses to act as a different signed-in account",
  async () => {
    const li = linkedIn(
      {},
      { signedIn: "urn:li:fs_miniProfile:ACoSOMEONEELSE", company: { following: true } }
    );
    for (const [action, input] of [
      ["set_follow", { target_url: PROFILE, following: true }],
      ["send_connection_request", { profile_url: PROFILE }],
      // Already in the requested state: still not reported for another account.
      ["set_follow", { target_url: COMPANY, following: true }],
      ["list_sent_invitations", {}],
    ] as const) {
      const result = await li.run(action, input);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not the connected account");
    }
    expect(li.world.member).toEqual({ relation: "none", following: false });
    expect(li.world.invitationsSent).toBe(0);
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test(
  "lists sent invitations up to the limit",
  async () => {
    const li = linkedIn();
    const listed = await li.run("list_sent_invitations", { limit: 1 });
    expect(listed).toEqual({
      success: true,
      output: {
        invitations: [
          {
            name: "Ada Example",
            headline: "Engineer at Example Co",
            profile_url: PROFILE,
            sent: "Sent 2 days ago",
          },
        ],
        total: 2,
        truncated: true,
      },
    });
    const all = await li.run("list_sent_invitations", { limit: 2 });
    expect(all.output).toMatchObject({ total: 2, truncated: false });
    // Loading stops at the limit; LinkedIn's count shows more exist.
    const more = await linkedIn({}, { sentTotal: 3 }).run("list_sent_invitations", { limit: 2 });
    expect(more.output).toMatchObject({ total: 3, truncated: true });
    expect(more.output.invitations).toHaveLength(2);
    expect(li.tabsClosed()).toBe(true);
  },
  SLOW
);

test("rejects invalid input before touching the browser", async () => {
  const li = linkedIn();
  for (const [action, input, error] of [
    ["send_connection_request", { profile_url: COMPANY }, "profile_url must be"],
    ["send_connection_request", { profile_url: PROFILE, email: "not an email" }, "email must be"],
    ["send_connection_request", { profile_url: PROFILE, note: "x".repeat(301) }, "at most 300"],
    ["set_follow", { target_url: "https://www.linkedin.com/feed/", following: true }, "target_url must be"],
    ["set_follow", { target_url: PROFILE, following: "yes" }, "following must be a boolean"],
    ["list_sent_invitations", { limit: 0 }, "limit must be"],
  ] as const) {
    const result = await li.run(action, input);
    expect(result.success).toBe(false);
    expect(result.error).toContain(error);
  }
  expect(li.calls).toEqual([]);
});
