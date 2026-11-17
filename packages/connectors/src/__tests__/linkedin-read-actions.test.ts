import { beforeAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let LinkedInConnector: any;
let genericScrape: (
  config: Record<string, unknown>
) => Promise<Record<string, unknown>>;

beforeAll(async () => {
  LinkedInConnector = (await import("../linkedin")).default;
  genericScrape = (await import("../../../owletto/apps/chrome/tools.js"))
    .genericScrape;
});

/** A synthetic page served for one navigation; `url` simulates a redirect. */
type Page = { html: string; url?: string };

/**
 * Run an action against synthetic LinkedIn pages. Every navigation builds a
 * JSDOM at the requested (or redirected) URL and runs the real extension
 * `genericScrape` with the connector's own scrape config, so selectors and
 * parsing are exercised together.
 */
async function runAction(
  actionKey: string,
  input: Record<string, unknown>,
  pageFor: (url: URL) => Page = () => ({ html: "<main></main>" })
) {
  const visited: string[] = [];
  const result = await new LinkedInConnector().execute({
    actionKey,
    input,
    browser: {
      dispatch: async (_action: string, payload: Record<string, unknown>) => {
        const requested = String(payload.url);
        visited.push(requested);
        const page = pageFor(new URL(requested));
        const dom = new JSDOM(`<!doctype html><body>${page.html}</body>`, {
          url: page.url ?? requested,
        });
        Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
          configurable: true,
          get() {
            return this.textContent ?? "";
          },
        });
        dom.window.scrollTo = () => undefined;
        dom.window.document.documentElement.scrollTo = () => undefined;
        const globals = {
          document: dom.window.document,
          window: dom.window,
          location: dom.window.location,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        };
        const saved = Object.keys(globals).map(
          (key) =>
            [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
        );
        try {
          for (const [key, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, key, {
              configurable: true,
              writable: true,
              value,
            });
          }
          const config = payload.scrape_config as Record<string, unknown>;
          return {
            tab_id: 1,
            cs_scrape: true,
            result: await genericScrape({
              ...config,
              scroll: { max: 0, stall: 0, waitMs: 0 },
            }),
          };
        } finally {
          dom.window.close();
          for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete (globalThis as Record<string, unknown>)[key];
          }
        }
      },
    },
  });
  return { result, visited };
}

const AUTH_WALL: Page = {
  html: "<main><p>Sign in</p></main>",
  url: "https://www.linkedin.com/authwall?trk=fixture",
};

describe("LinkedIn read actions: input validation", () => {
  test.each([
    ["search_people", {}],
    ["search_people", { keywords: "   " }],
    ["search_people", { keywords: "engineer", page: 11 }],
    ["search_people", { keywords: "engineer", page: 1.5 }],
    ["search_people", { keywords: "engineer", network: ["4th"] }],
    ["search_people", { keywords: "x".repeat(201) }],
    ["read_profile", { profile_url: "https://example.com/in/fixture-alpha" }],
    [
      "read_profile",
      { profile_url: "https://www.linkedin.com/company/example-labs/" },
    ],
    ["search_companies", { keywords: "fixtures", page: 0 }],
    [
      "read_company",
      { company_url: "https://www.linkedin.com/in/fixture-alpha/" },
    ],
    ["search_posts", { keywords: "fixtures", sort: "newest" }],
  ])("%s rejects %j without opening a page", async (actionKey, input) => {
    const { result, visited } = await runAction(actionKey, input);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(visited).toEqual([]);
  });

  test.each([
    ["search_people", { keywords: "engineer" }],
    [
      "read_profile",
      { profile_url: "https://www.linkedin.com/in/fixture-alpha" },
    ],
    ["search_companies", { keywords: "fixtures" }],
    [
      "read_company",
      { company_url: "https://www.linkedin.com/company/example-labs" },
    ],
    ["search_posts", { keywords: "fixtures" }],
  ])("%s reports a signed-out browser", async (actionKey, input) => {
    const { result } = await runAction(actionKey, input, () => AUTH_WALL);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Not logged into LinkedIn/);
  });
});

describe("search_people", () => {
  const resultsPage = `
    <main><div role="list">
      <div role="listitem">
        <a href="https://www.linkedin.com/in/fixture-alpha?miniProfileUrn=a"></a>
        <div>
          <p><a href="https://www.linkedin.com/in/fixture-alpha?miniProfileUrn=a">Fixture Alpha</a> • 2nd</p>
          <div>Staff Engineer at Example Labs</div>
          <div>Sample City</div>
        </div>
        <div componentkey="SearchResultssnippet_a">Current: Staff Engineer at Example Labs</div>
      </div>
      <div role="listitem">
        <div>
          <p><a href="https://www.linkedin.com/in/fixture-b%C3%A9ta/">Fixture Beta</a> • 3rd+</p>
          <div>Fixture Researcher</div>
          <div>Sample Town</div>
        </div>
        <div componentkey="SearchResultssnippet_b">Skills: fixtures</div>
      </div>
      <div role="listitem"><p>Promoted search hint without a profile</p></div>
    </div></main>`;

  test("applies a resolved geo filter and parses result cards", async () => {
    const { result, visited } = await runAction(
      "search_people",
      {
        keywords: "engineer",
        location: "Sample City",
        network: ["2nd", "3rd"],
        page: 2,
      },
      (url) =>
        url.pathname.includes("typeaheadHits")
          ? {
              html: '<pre>[{"id":"1000001","displayName":"Sample City Area"}]</pre>',
            }
          : { html: resultsPage }
    );
    expect(result.success).toBe(true);
    const output = result.output;
    expect(output.location_filter).toEqual({
      query: "Sample City",
      applied: "geo_filter",
      geo_id: "1000001",
      display_name: "Sample City Area",
    });
    const searchUrl = new URL(output.search_url);
    expect(searchUrl.searchParams.get("keywords")).toBe("engineer");
    expect(searchUrl.searchParams.get("geoUrn")).toBe('["1000001"]');
    expect(searchUrl.searchParams.get("network")).toBe('["S","O"]');
    expect(searchUrl.searchParams.get("page")).toBe("2");
    expect(visited).toHaveLength(2);
    expect(output.people).toEqual([
      {
        name: "Fixture Alpha",
        headline: "Staff Engineer at Example Labs",
        location: "Sample City",
        profile_url: "https://www.linkedin.com/in/fixture-alpha/",
        degree: "2nd",
        current_position: "Staff Engineer at Example Labs",
      },
      {
        name: "Fixture Beta",
        headline: "Fixture Researcher",
        location: "Sample Town",
        profile_url: "https://www.linkedin.com/in/fixture-b%C3%A9ta/",
        degree: "3rd",
        snippet: "Skills: fixtures",
      },
    ]);
  });

  test("folds an unresolved location into the keywords", async () => {
    const { result } = await runAction(
      "search_people",
      { keywords: "engineer", location: "Nowhere Fixture" },
      (url) =>
        url.pathname.includes("typeaheadHits")
          ? { html: "<pre>[]</pre>" }
          : { html: resultsPage }
    );
    expect(result.success).toBe(true);
    expect(result.output.location_filter).toEqual({
      query: "Nowhere Fixture",
      applied: "keywords",
    });
    const searchUrl = new URL(result.output.search_url);
    expect(searchUrl.searchParams.get("keywords")).toBe(
      "engineer Nowhere Fixture"
    );
    expect(searchUrl.searchParams.has("geoUrn")).toBe(false);
  });
});

describe("read_profile", () => {
  const profileUrl = "https://www.linkedin.com/in/fixture-alpha/";
  const pages: Record<string, string> = {
    "/in/fixture-alpha/": `
      <main>
        <section>
          <h2>Fixture Alpha</h2>
          <div><p>She/Her</p><span></span></div>
          <div><p>· 1st</p><span></span></div>
          <div style="display:none"><p>· 2nd</p></div>
          <p>Principal Fixture Engineer</p>
          <p>Example Labs</p>
          <p>Sample City, Sample Region</p>
          <p>·</p>
          <p>Contact info</p>
        </section>
        <section>
          <h2>About</h2>
          <p>About</p>
          <p>A synthetic summary that is longer than its section label.</p>
        </section>
      </main>`,
    "/in/fixture-alpha/details/experience/": `
      <main>
        <div componentkey="entity-collection-item-1">
          <a href="https://www.linkedin.com/company/example-labs/?trk=x"></a>
          <p>Principal Engineer</p>
          <p>Example Labs · Full-time</p>
          <p>Jan 2022 - Present · 4 yrs</p>
          <p>Sample City</p>
        </div>
        <div componentkey="entity-collection-item-2">
<p>Sample Group</p>
          <p>6 yrs</p>
          <ul>
            <li><p>Senior Engineer</p><p>Mar 2019 - Dec 2021 · 2 yrs 10 mos</p></li>
            <li><p>Engineer</p><p>2016 - 2019 · 3 yrs</p></li>
          </ul>
        </div>
      </main>`,
    "/in/fixture-alpha/details/education/": `
      <main><div componentkey="ProfileEducationDetailsSection">
        <div componentkey="edu-1">
          <p>Sample University</p><p>Master of Fixtures</p><p>Sep 2021 – Jun 2022</p>
        </div>
        <div componentkey="edu-2"><p>Example School</p><p>2000 – 2013</p></div>
      </div></main>`,
  };

  test("reads the top card, positions and education", async () => {
    const { result, visited } = await runAction(
      "read_profile",
      { profile_url: "linkedin.com/in/fixture-alpha?trk=search" },
      (url) => ({ html: pages[url.pathname] ?? "<main></main>" })
    );
    expect(result.success).toBe(true);
    expect(visited).toEqual([
      profileUrl,
      `${profileUrl}details/experience/`,
      `${profileUrl}details/education/`,
    ]);
    expect(result.output).toEqual({
      profile_url: profileUrl,
      name: "Fixture Alpha",
      headline: "Principal Fixture Engineer",
      location: "Sample City, Sample Region",
      degree: "1st",
      about: "A synthetic summary that is longer than its section label.",
      current_positions: [
        {
          title: "Principal Engineer",
          company: "Example Labs",
          employment_type: "Full-time",
          dates: "Jan 2022 - Present",
          duration: "4 yrs",
          is_current: true,
          company_url: "https://www.linkedin.com/company/example-labs/",
        },
      ],
      past_positions: [
        {
          title: "Senior Engineer",
          company: "Sample Group",
          dates: "Mar 2019 - Dec 2021",
          duration: "2 yrs 10 mos",
          is_current: false,
          company_url: null,
        },
        {
          title: "Engineer",
          company: "Sample Group",
          dates: "2016 - 2019",
          duration: "3 yrs",
          is_current: false,
          company_url: null,
        },
      ],
      education: [
        {
          school: "Sample University",
          degree: "Master of Fixtures",
          dates: "Sep 2021 – Jun 2022",
        },
        { school: "Example School", degree: null, dates: "2000 – 2013" },
      ],
    });
  });
});

describe("search_companies", () => {
  test("parses names, facts and follower counts", async () => {
    const { result } = await runAction(
      "search_companies",
      { keywords: "fixtures", page: 3 },
      () => ({
        html: `
          <main>
            <div role="listitem">
              <a href="https://www.linkedin.com/company/example-labs/"></a>
              <p>Example Labs</p><p>Software Development</p><p>Sample City</p>
              <p>Fixture Person &amp; 3 other connections follow this page · 74,153 followers</p>
            </div>
            <div role="listitem">
              <a href="https://www.linkedin.com/showcase/sample-showcase/?trk=x"></a>
              <p>Sample Showcase</p><p>Research</p><p>Sample Town</p><p>1.2K followers</p>
            </div>
            <div role="listitem"><p>Ad without a company link</p></div>
          </main>`,
      })
    );
    expect(result.success).toBe(true);
    expect(new URL(result.output.search_url).searchParams.get("page")).toBe(
      "3"
    );
    expect(result.output.companies).toEqual([
      {
        name: "Example Labs",
        industry: "Software Development",
        location: "Sample City",
        followers: 74153,
        company_url: "https://www.linkedin.com/company/example-labs/",
      },
      {
        name: "Sample Showcase",
        industry: "Research",
        location: "Sample Town",
        followers: 1200,
        company_url: "https://www.linkedin.com/showcase/sample-showcase/",
      },
    ]);
  });
});

describe("read_company", () => {
  test("reads labelled facts from the About tab", async () => {
    const { result, visited } = await runAction(
      "read_company",
      { company_url: "https://www.linkedin.com/company/example-labs/posts/" },
      () => ({
        html: `
          <main><section>
            <h1>Example Labs</h1>
            <p>Software Development · Sample City · 30M followers</p>
            <h2>Overview</h2>
            <p>Example Labs builds synthetic fixtures for tests.</p>
            <dl>
              <dt>Website</dt><dd>https://example.com</dd>
              <dt>Industry</dt><dd>Software Development</dd>
              <dt>Company size</dt><dd>11-50 employees</dd>
              <dt>Headquarters</dt><dd>Sample City</dd>
              <dt>Founded</dt><dd>2020</dd>
            </dl>
          </section></main>`,
      })
    );
    expect(result.success).toBe(true);
    expect(visited).toEqual([
      "https://www.linkedin.com/company/example-labs/about/",
    ]);
    expect(result.output).toEqual({
      company_url: "https://www.linkedin.com/company/example-labs/",
      name: "Example Labs",
      about: "Example Labs builds synthetic fixtures for tests.",
      website: "https://example.com",
      industry: "Software Development",
      company_size: "11-50 employees",
      headquarters: "Sample City",
      founded: "2020",
      type: null,
      specialties: null,
      followers: 30000000,
    });
  });
});

describe("search_posts", () => {
  const card = (index: number, extra = "") => `
    <div componentkey="expandedfixture_${index}FeedType_FLAGSHIP_SEARCH">
      <button aria-label="Open control menu for post by Fixture Author ${index}"></button>
      <a href="https://www.linkedin.com/in/fixture-author-${index}/" aria-label="View Fixture Author ${index}${index === 2 ? "’" : "’s"} profile"><span aria-hidden="true">Fixture Author ${index}</span></a>
      <p>Fixture Author ${index} • 3rd+</p>
      <p>Synthetic headline</p>
      <p>${index}h • Edited</p>
      <p>Synthetic post body number ${index} about fixtures … more</p>
      <div id="urn:li:activity:74000000000000000${String(index).padStart(2, "0")}"></div>
      ${extra}
    </div>`;

  test("returns post identity, body, time and counts per page", async () => {
    const cards = Array.from({ length: 12 }, (_, i) =>
      card(
        i + 1,
        i === 0
          ? '<button aria-label="Reaction button state: no reaction">1,234</button><button aria-label="Comment">56</button>'
          : '<button aria-label="Reaction button state: no reaction">​</button>'
      )
    ).join("");
    const pageFor = () => ({ html: `<main>${cards}</main>` });

    const first = await runAction(
      "search_posts",
      { keywords: "fixtures", sort: "recent" },
      pageFor
    );
    expect(first.result.success).toBe(true);
    const searchUrl = new URL(first.result.output.search_url);
    expect(searchUrl.searchParams.get("sortBy")).toBe('["date_posted"]');
    expect(first.result.output.posts).toHaveLength(10);
    const [top, second] = first.result.output.posts;
    expect(top).toMatchObject({
      post_url: expect.stringContaining("urn:li:activity:7400000000000000001"),
      author: {
        name: "Fixture Author 1",
        profile_url: expect.stringContaining("/in/fixture-author-1"),
      },
      body: "Synthetic post body number 1 about fixtures",
      posted_time: "1h",
      reactions: 1234,
      comments: 56,
    });
    // Some cards label the author link "View <Name>’ profile".
    expect(second).toMatchObject({
      author: { profile_url: expect.stringContaining("/in/fixture-author-2") },
      reactions: 0,
      comments: 0,
    });

    const next = await runAction(
      "search_posts",
      { keywords: "fixtures", page: 2 },
      pageFor
    );
    expect(next.result.success).toBe(true);
    expect(
      next.result.output.posts.map((post: { body: string }) => post.body)
    ).toEqual([
      "Synthetic post body number 11 about fixtures",
      "Synthetic post body number 12 about fixtures",
    ]);
  });
});
