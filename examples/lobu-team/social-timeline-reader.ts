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
  const identityVerified =
    options.platform === "x"
      ? loc.origin === "https://x.com" &&
        loc.pathname === options.page_path &&
        String(identity).toLowerCase() === options.account_path.toLowerCase() &&
        [...doc.querySelectorAll('[role="tab"]')].some(
          (t: any) =>
            t.innerText.trim() === "Following" &&
            t.getAttribute("aria-selected") === "true"
        )
      : loc.origin === "https://www.linkedin.com" &&
        loc.pathname === options.page_path &&
        Boolean(options.company_name) &&
        String(identity).includes(
          `${options.company_name}: Company Page Admin`
        ) &&
        doc.body.innerText.includes(`Comment as ${options.company_name}`);
  if (!identityVerified || doc.visibilityState !== "visible")
    throw new Error(
      "Timeline identity or visible scratch tab could not be verified"
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
    const time = card.querySelector("time");
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
