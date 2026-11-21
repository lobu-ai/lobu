/** One DOM page, without content clipping. The example build packages this for
 * Chrome evaluate after focusing the owned scratch tab.
 * Pagination remains outside the snapshot so each page has its own receipt. */
export function readSocialTimelinePage(options: {
  platform: "x" | "linkedin";
  account_path: string;
  page_path: string;
  company_name?: string;
}) {
  const root = globalThis as any;
  const doc = root.document;
  const loc = root.location;
  const identity =
    options.platform === "x"
      ? doc
          .querySelector('[data-testid="AppTabBar_Profile_Link"]')
          ?.getAttribute("href")
      : doc.title;
  // Each check names itself, so a refusal says which one failed and what to
  // do. The reasons are fixed words: the message is grouped into issues and
  // read by agents, so it never quotes the account, company or URL.
  const checks: Array<[boolean, string, string]> =
    options.platform === "x"
      ? [
          [
            loc.origin === "https://x.com",
            "wrong_site",
            "open x.com in the scratch tab",
          ],
          [
            loc.pathname === options.page_path,
            "wrong_page",
            "navigate the scratch tab to the bound page",
          ],
          [
            String(identity).toLowerCase() ===
              options.account_path.toLowerCase(),
            "wrong_account",
            "sign in to the bound X account in this browser",
          ],
          [
            [...doc.querySelectorAll('[role="tab"]')].some(
              (t: any) =>
                t.innerText.trim() === "Following" &&
                t.getAttribute("aria-selected") === "true"
            ),
            "following_tab_not_selected",
            "select the Following tab",
          ],
        ]
      : [
          [
            loc.origin === "https://www.linkedin.com",
            "wrong_site",
            "open www.linkedin.com in the scratch tab",
          ],
          [
            loc.pathname === options.page_path,
            "wrong_page",
            "navigate the scratch tab to the bound company admin feed",
          ],
          [
            Boolean(options.company_name),
            "company_name_missing",
            "pass company_name from the binding",
          ],
          [
            String(identity).includes(
              `${options.company_name}: Company Page Admin`
            ),
            "not_company_admin_view",
            "open the company page admin view with an admin account",
          ],
          [
            doc.body.innerText.includes(`Comment as ${options.company_name}`),
            "not_acting_as_company",
            "switch the comment identity to the company page",
          ],
        ];
  checks.push([
    doc.visibilityState === "visible",
    "tab_not_visible",
    "call focus_tab on the scratch tab, then read again",
  ]);
  const failed = checks.find(([ok]) => !ok);
  if (failed)
    throw new Error(
      `Timeline page could not be verified: ${failed[1]}; ${failed[2]}`
    );
  const cards = [
    ...doc.querySelectorAll(
      options.platform === "x"
        ? 'article[data-testid="tweet"]'
        : '[data-urn^="urn:li:activity:"]'
    ),
  ];
  const posts = new Map();
  let skipped = 0;
  for (const card of cards as any[]) {
    const x = options.platform === "x";
    const body = card.querySelector(
      x
        ? '[data-testid="tweetText"]'
        : ".update-components-text, .feed-shared-inline-show-more-text"
    );
    // LinkedIn cards also contain comment times and embedded repost headers.
    // Keep the visible age only when a single post header owns it; never
    // manufacture an absolute timestamp from an activity ID or a comment.
    const time = x ? card.querySelector("time") : null;
    const ageHeaders = x
      ? []
      : [...card.querySelectorAll(".update-components-actor__sub-description")];
    const url = x
      ? time?.closest("a")?.href?.split("?")[0]
      : `https://www.linkedin.com/feed/update/${card.getAttribute("data-urn")}`;
    if (
      !url ||
      !(
        x
          ? /^https:\/\/x\.com\/\w+\/status\/\d+$/
          : /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:\d+$/
      ).test(url)
    ) {
      skipped++;
      continue;
    }
    const author = card.querySelector(
      x
        ? '[data-testid="User-Name"]'
        : ".update-components-actor__meta-link, .update-components-actor__name, .feed-shared-actor__name"
    );
    const expansion = (x ? card : body)?.querySelector(
      x
        ? '[data-testid="tweet-text-show-more-link"]'
        : ".feed-shared-inline-show-more-text__see-more-less-toggle"
    );
    const expanded =
      !expansion || !/show more|see more|…\s*more/i.test(expansion.innerText);
    posts.set(url, {
      source_url: url,
      origin_id: x ? url.split("/").at(-1) : card.getAttribute("data-urn"),
      text: body?.innerText ?? "",
      author: author?.innerText ?? "",
      author_url:
        (author?.closest("a") ?? author?.querySelector("a"))?.href?.split(
          "?"
        )[0] ?? null,
      mentioned_profiles: [...(body?.querySelectorAll("a[href]") ?? [])].map(
        (a: any) => a.href.split("?")[0]
      ),
      occurred_at: time?.dateTime || null,
      ...(!x && {
        relative_age:
          ageHeaders.length === 1 ? ageHeaders[0].innerText.trim() : null,
      }),
      truncated: !body || !expanded,
      media_unread: Boolean(
        card.querySelector(
          x
            ? '[data-testid="tweetPhoto"], video'
            : ".update-components-image, video, .update-components-document"
        )
      ),
    });
  }
  return {
    platform: options.platform,
    identity_verified: true,
    account: identity,
    visibility: doc.visibilityState,
    page_url: loc.href,
    observed_at: new Date().toISOString(),
    skipped,
    posts: [...posts.values()],
  };
}
