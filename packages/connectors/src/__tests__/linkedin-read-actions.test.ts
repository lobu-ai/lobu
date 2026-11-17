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
  // Pages swap the DOM globals, so parallel dispatches (read_profile loads
  // its detail pages together) run one at a time here.
  let queue: Promise<unknown> = Promise.resolve();
  const result = await new LinkedInConnector().execute({
    actionKey,
    input,
    browser: {
      dispatch: (_action: string, payload: Record<string, unknown>) => {
        const run = queue.then(() => loadPage(payload));
        queue = run.catch(() => undefined);
        return run;
      },
    },
  });
  return { result, visited };

  async function loadPage(payload: Record<string, unknown>) {
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
  }
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
          <p><a href="https://www.linkedin.com/in/fixture-alpha?miniProfileUrn=a">Fixture Alpha<span role="img" aria-label="Verified"></span></a> • 2nd</p>
          <div>Staff Engineer at Example Labs</div>
          <div>Sample City</div>
        </div>
        <div componentkey="SearchResultssnippet_a">Current: Staff Engineer at Example Labs</div>
        <p><span><a href="https://www.linkedin.com/in/mutual-one/?trk=x">Mutual One</a></span> and <span><a href="https://www.linkedin.com/search/results/people/?connectionOf=fixture">3 other mutual connections</a></span></p>
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
        verified: true,
        current_position: "Staff Engineer at Example Labs",
        past_position: null,
        snippet: null,
        mutual_connections: {
          count: 4,
          people: [
            {
              name: "Mutual One",
              profile_url: "https://www.linkedin.com/in/mutual-one/",
            },
          ],
          search_url:
            "https://www.linkedin.com/search/results/people/?connectionOf=fixture",
        },
      },
      {
        name: "Fixture Beta",
        headline: "Fixture Researcher",
        location: "Sample Town",
        profile_url: "https://www.linkedin.com/in/fixture-b%C3%A9ta/",
        degree: "3rd",
        verified: false,
        current_position: null,
        past_position: null,
        snippet: "Skills: fixtures",
        mutual_connections: null,
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
  const topCard = (degree: string) => `
    <main>
      <section>
        <h2>Fixture Alpha</h2>
        <div><p>She/Her</p><span></span></div>
        <div><p>· ${degree}</p><span></span></div>
        <div style="display:none"><p>· 3rd</p></div>
        <p>Principal Fixture Engineer</p>
        <p>Example Labs</p>
        <p>Sample City, Sample Region</p>
        <p>·</p>
        <p><a href="${profileUrl}overlay/contact-info/">Contact info</a></p>
        <p>500+</p>
        <p>connections</p>
        <p><a href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ffixture.example%2F&amp;urlhash=x">Visit my website</a></p>
        <p><a href="https://www.linkedin.com/search/results/people/?connectionOf=fixture"><strong>Mutual One</strong> and <strong>Mutual Two</strong> are mutual connections</a></p>
      </section>
      <section>
        <h2>About</h2>
        <p>About</p>
        <p>A synthetic summary that is longer than its section label.</p>
      </section>
      <section><h2>Activity</h2><p>1,474 followers</p></section>
    </main>`;
  const pages: Record<string, string> = {
    "/in/fixture-alpha/details/experience/": `
      <main>
        <div componentkey="entity-collection-item-1">
          <a href="https://www.linkedin.com/company/example-labs/?trk=x">
            <p>Principal Engineer</p>
            <p>Example Labs · Full-time</p>
            <p>Jan 2022 - Present · 4 yrs</p>
            <p>Sample City · Hybrid</p>
          </a>
          <div><p><span>Leads the fixture platform.</span></p></div>
          <p>Skills: Testing · Fixtures</p>
        </div>
        <div componentkey="entity-collection-item-2">
          <a href="https://www.linkedin.com/company/sample-group/">
            <p>Sample Group</p>
            <p>Full-time · 6 yrs</p>
            <p>Sample Town</p>
          </a>
          <ul>
            <li><p>Senior Engineer</p><p>Mar 2019 - Dec 2021 · 2 yrs 10 mos</p><p><span>Built fixtures.</span></p></li>
            <li><p>Engineer</p><p>2016 - 2019 · 3 yrs</p><p>Remote</p></li>
          </ul>
        </div>
      </main>`,
    "/in/fixture-alpha/details/education/": `
      <main><div componentkey="ProfileEducationDetailsSection">
        <div componentkey="edu-1">
          <a href="https://www.linkedin.com/school/sample-university/"><p>Sample University</p><p>Master of Science, Fixture Engineering</p><p>Sep 2021 – Jun 2022</p></a>
          <p>Grade: Distinction</p>
          <p>Activities and societies: Fixture Club</p>
          <div><p><span>Thesis on synthetic fixtures.</span></p></div>
        </div>
        <div componentkey="edu-2"><p>Example School</p><p>2000 – 2013</p></div>
      </div></main>`,
    "/in/fixture-alpha/details/skills/": `
      <main>
        <div componentkey="com.linkedin.sdui.profile.skill(1)"><p>Testing</p><p>Endorsed by Mutual One</p><p>12 endorsements</p></div>
        <div componentkey="com.linkedin.sdui.profile.skill(2)"><p>Fixtures</p></div>
        <div componentkey="com.linkedin.sdui.profile.skill(3)"><hr></div>
      </main>`,
    "/in/fixture-alpha/overlay/contact-info/": `
      <dialog open><div componentkey="ProfileContactInfoDetailSection">
        <div componentkey="contact-website"><p>Website</p><p><a href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ffixture.example%2F&amp;urlhash=x">fixture.example</a> (Personal)</p></div>
        <div componentkey="contact-email"><p>Email</p><p><a href="mailto:alpha@fixture.example">alpha@fixture.example</a></p></div>
        <div componentkey="contact-phone"><p>Phone</p><p>+1 555 0100 (Mobile)</p></div>
        <div componentkey="contact-birthday"><p>Birthday</p><p>January 1</p></div>
        <div componentkey="contact-connected"><p>Connected</p><p>Mar 3, 2024</p></div>
      </div></dialog>`,
  };
  const pageFor = (degree: string) => (url: URL) => ({
    html:
      url.pathname === "/in/fixture-alpha/"
        ? topCard(degree)
        : (pages[url.pathname] ?? "<main></main>"),
  });

  test("reads the top card, contact info, positions, education and skills", async () => {
    const { result, visited } = await runAction(
      "read_profile",
      { profile_url: "linkedin.com/in/fixture-alpha?trk=search" },
      pageFor("1st")
    );
    expect(result.success).toBe(true);
    expect(visited).toEqual([
      profileUrl,
      `${profileUrl}details/experience/`,
      `${profileUrl}details/education/`,
      `${profileUrl}details/skills/`,
      `${profileUrl}overlay/contact-info/`,
    ]);
    expect(result.output).toEqual({
      profile_url: profileUrl,
      name: "Fixture Alpha",
      pronouns: "She/Her",
      headline: "Principal Fixture Engineer",
      location: "Sample City, Sample Region",
      degree: "1st",
      followers: 1474,
      connections: "500+",
      mutual_connections: {
        count: 2,
        people: [
          { name: "Mutual One", profile_url: null },
          { name: "Mutual Two", profile_url: null },
        ],
        search_url:
          "https://www.linkedin.com/search/results/people/?connectionOf=fixture",
      },
      website: "https://fixture.example/",
      about: "A synthetic summary that is longer than its section label.",
      contact_info: {
        email: "alpha@fixture.example",
        phone: "+1 555 0100 (Mobile)",
        websites: [{ url: "https://fixture.example/", type: "Personal" }],
        birthday: "January 1",
        connected_since: "Mar 3, 2024",
        address: null,
      },
      current_positions: [
        {
          title: "Principal Engineer",
          company: "Example Labs",
          employment_type: "Full-time",
          dates: "Jan 2022 - Present",
          duration: "4 yrs",
          is_current: true,
          location: "Sample City",
          workplace_type: "Hybrid",
          description: "Leads the fixture platform.",
          skills: ["Testing", "Fixtures"],
          company_url: "https://www.linkedin.com/company/example-labs/",
        },
      ],
      past_positions: [
        {
          title: "Senior Engineer",
          company: "Sample Group",
          employment_type: "Full-time",
          dates: "Mar 2019 - Dec 2021",
          duration: "2 yrs 10 mos",
          is_current: false,
          location: "Sample Town",
          workplace_type: null,
          description: "Built fixtures.",
          skills: [],
          company_url: "https://www.linkedin.com/company/sample-group/",
        },
        {
          title: "Engineer",
          company: "Sample Group",
          employment_type: "Full-time",
          dates: "2016 - 2019",
          duration: "3 yrs",
          is_current: false,
          location: null,
          workplace_type: "Remote",
          description: null,
          skills: [],
          company_url: "https://www.linkedin.com/company/sample-group/",
        },
      ],
      education: [
        {
          school: "Sample University",
          degree: "Master of Science",
          field_of_study: "Fixture Engineering",
          dates: "Sep 2021 – Jun 2022",
          grade: "Distinction",
          activities: "Fixture Club",
          description: "Thesis on synthetic fixtures.",
          school_url: "https://www.linkedin.com/school/sample-university/",
        },
        {
          school: "Example School",
          degree: null,
          field_of_study: null,
          dates: "2000 – 2013",
          grade: null,
          activities: null,
          description: null,
          school_url: null,
        },
      ],
      skills: [
        { name: "Testing", endorsements: 12 },
        { name: "Fixtures", endorsements: 0 },
      ],
    });
  });

  test("never opens contact info beyond 1st-degree connections", async () => {
    const { result, visited } = await runAction(
      "read_profile",
      { profile_url: profileUrl },
      pageFor("2nd")
    );
    expect(result.success).toBe(true);
    expect(result.output.degree).toBe("2nd");
    expect(result.output.contact_info).toBeNull();
    expect(visited).not.toContain(`${profileUrl}overlay/contact-info/`);
  });
});

describe("search_companies", () => {
  test("parses names, facts, summary, network and follow state; never a summary as location", async () => {
    const { result } = await runAction(
      "search_companies",
      { keywords: "fixtures", page: 3 },
      () => ({
        html: `
          <main>
            <div role="listitem"><div>
              <div>
                <p><a href="https://www.linkedin.com/company/example-labs/">Example Labs</a><span role="img" aria-label="Verified organization"></span></p>
                <div><p>Software Development</p></div>
                <div><p>Sample City</p></div>
              </div>
              <button aria-label="Following, click to unfollow Example Labs">Following</button>
              <div><p>Example Labs builds fixtures.</p>
                <div><p><span><a href="https://www.linkedin.com/search/results/people/?origin=SHARED_CONNECTIONS_IN_COMPANY_CANNED_SEARCH&amp;currentCompany=1">Fixture Person &amp; 3 other connections work here</a> · 74,153 followers</span></p></div>
              </div>
            </div></div>
            <div role="listitem"><div>
              <div>
                <p><a href="https://www.linkedin.com/showcase/sample-showcase/?trk=x">Sample Showcase</a></p>
                <div><p>Research</p></div>
                <div><p>Sample Town</p></div>
              </div>
              <button aria-label="Follow Sample Showcase">Follow</button>
              <div><p>1.2K followers</p></div>
            </div></div>
            <div role="listitem"><div>
              <div>
                <p><a href="https://www.linkedin.com/company/no-location/">No Location Co</a></p>
                <div><p>Research Services</p></div>
              </div>
              <div><p>No Location Co is a research company.</p>
                <div><p><span><a href="https://www.linkedin.com/company/no-location/?showInNetworkFollowers=true">Fixture Person follows this page</a> · 5,577,706 followers</span></p></div>
              </div>
            </div></div>
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
        summary: "Example Labs builds fixtures.",
        followers: 74153,
        verified: true,
        following: true,
        connections_working_here: {
          count: 4,
          search_url:
            "https://www.linkedin.com/search/results/people/?origin=SHARED_CONNECTIONS_IN_COMPANY_CANNED_SEARCH&currentCompany=1",
        },
        connections_following: null,
        company_url: "https://www.linkedin.com/company/example-labs/",
      },
      {
        name: "Sample Showcase",
        industry: "Research",
        location: "Sample Town",
        summary: null,
        followers: 1200,
        verified: false,
        following: false,
        connections_working_here: null,
        connections_following: null,
        company_url: "https://www.linkedin.com/showcase/sample-showcase/",
      },
      {
        name: "No Location Co",
        industry: "Research Services",
        location: null,
        summary: "No Location Co is a research company.",
        followers: 5577706,
        verified: false,
        following: false,
        connections_working_here: null,
        connections_following: {
          count: 1,
          search_url:
            "https://www.linkedin.com/company/no-location/?showInNetworkFollowers=true",
        },
        company_url: "https://www.linkedin.com/company/no-location/",
      },
    ]);
  });
});

describe("read_company", () => {
  test("reads the top card and the About tab's labelled facts", async () => {
    const { result, visited } = await runAction(
      "read_company",
      { company_url: "https://www.linkedin.com/company/example-labs/posts/" },
      () => ({
        html: `
          <main>
            <div componentkey="pages.topCard.4242">
              <div>
                <div><h2>Example Labs</h2><a href="https://www.linkedin.com/company/example-labs/about/"></a></div>
                <p>Synthetic fixtures for every test.</p>
                <div><p>Software Development</p><p>·</p><p>Sample City</p><p>·</p><p>30M followers</p><p>·</p><p><a href="https://www.linkedin.com/search/results/people/?currentCompany=%5B%224242%22%5D">11-50 employees</a></p></div>
              </div>
              <div><p>Ranked on LinkedIn Top Companies</p></div>
              <p><span><a href="https://www.linkedin.com/search/results/people/?network=%5B%22F%22%5D&amp;currentCompany=%5B%224242%22%5D">Fixture Person &amp; 2 other connections work here</a></span></p>
              <a href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fexample.com%2F&amp;urlhash=x">Visit website</a>
              <button aria-label="Following, click to unfollow Example Labs">Following</button>
            </div>
            <section>
              <h2>Overview</h2>
              <p>Example Labs builds synthetic fixtures for tests.</p>
              <p>A second overview paragraph.</p>
              <div><p>Website</p></div><a href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fexample.com%2F"><p>https://example.com/</p></a>
              <div><p>Verified page</p><p>April 7, 2026</p></div>
              <div><p>Industry</p><p>Software Development</p></div>
              <div><p>Company size</p><p>11-50 employees</p><p><a href="https://www.linkedin.com/search/results/people/?currentCompany=%5B%224242%22%5D">42 associated members</a></p></div>
              <div><p>Headquarters</p><p>Sample City</p></div>
              <div><p>Type</p><p>Privately Held</p></div>
              <div><p>Founded</p><p>2020</p></div>
              <div><p>Specialties</p><p>Fixtures, Testing</p></div>
            </section>
          </main>`,
      })
    );
    expect(result.success).toBe(true);
    expect(visited).toEqual([
      "https://www.linkedin.com/company/example-labs/about/",
    ]);
    expect(result.output).toEqual({
      company_url: "https://www.linkedin.com/company/example-labs/",
      company_id: "4242",
      name: "Example Labs",
      tagline: "Synthetic fixtures for every test.",
      about:
        "Example Labs builds synthetic fixtures for tests.\n\nA second overview paragraph.",
      website: "https://example.com/",
      industry: "Software Development",
      company_size: "11-50 employees",
      employees_on_linkedin: 42,
      headquarters: "Sample City",
      founded: "2020",
      type: "Privately Held",
      specialties: ["Fixtures", "Testing"],
      phone: null,
      followers: 30000000,
      verified: true,
      verified_since: "April 7, 2026",
      highlights: ["Ranked on LinkedIn Top Companies"],
      following: true,
      connections_working_here: {
        count: 3,
        search_url:
          "https://www.linkedin.com/search/results/people/?network=%5B%22F%22%5D&currentCompany=%5B%224242%22%5D",
      },
    });
  });
});

describe("search_posts", () => {
  const card = (
    index: number,
    extra = "",
    body = `Synthetic post body number ${index} about fixtures`
  ) => `
    <div componentkey="expandedfixture_${index}FeedType_FLAGSHIP_SEARCH">
      <h2>Feed post</h2>
      <button aria-label="Open control menu for post by Fixture Author ${index}"></button>
      <a href="https://www.linkedin.com/in/fixture-author-${index}/" aria-label="View Fixture Author ${index}${index === 2 ? "’" : "’s"} profile"><div aria-label="Fixture Author ${index} ${index === 1 ? "Verified" : "Premium"} Profile 3rd+"><span aria-hidden="true">Fixture Author ${index}</span></div></a>
      <p>Fixture Author ${index}</p>
      <p>• 3rd+</p>
      <p>Synthetic headline</p>
      <p>${index}h • Edited</p>
      <p componentkey="body-${index}">${body} … more</p>
      <div id="urn:li:activity:74000000000000000${String(index).padStart(2, "0")}"></div>
      ${extra}
    </div>`;

  test("returns post identity, author, body, entities, media and counts per page", async () => {
    const cards = Array.from({ length: 12 }, (_, i) =>
      i === 0
        ? card(
            1,
            '<img src="https://media.licdn.com/dms/image/v2/A/feedshare-shrink_480/0/1?e=1" alt="Fixture chart"><img src="https://media.licdn.com/dms/image/v2/B/profile-framedphoto-shrink_100_100/0/1?e=1" alt="Open to work"><button aria-label="Reaction button state: no reaction">1,234</button><button aria-label="Comment">56</button><button aria-label="Repost">7</button>',
            'Synthetic post body number 1 about <a aria-label="View company: Example Labs" href="https://www.linkedin.com/company/example-labs/?trk=x">Example Labs</a> #fixtures <a href="https://evillinkedin.com/in/lookalike/">Lookalike</a> <a href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ffixture.example%2Fpost&amp;urlhash=x">https://fixture.example/post</a>'
          )
        : card(
            i + 1,
            i === 1
              ? '<div aria-label="Video Player"></div><img src="https://media.licdn.com/dms/image/v2/C/videocover-high/0/2?e=1"><button aria-label="Reaction button state: no reaction">​</button>'
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
    expect(top).toEqual({
      post_url: expect.stringContaining("urn:li:activity:7400000000000000001"),
      posted_at: "2025-11-28T02:38:05.351Z",
      posted_time: "1h",
      edited: true,
      author: {
        name: "Fixture Author 1",
        headline: "Synthetic headline",
        profile_url: expect.stringContaining("/in/fixture-author-1"),
        company_url: null,
        degree: "3rd",
        verified: true,
        premium: false,
      },
      body: "Synthetic post body number 1 about Example Labs #fixtures Lookalike https://fixture.example/post",
      hashtags: ["#fixtures"],
      mentions: [
        {
          name: "Example Labs",
          url: "https://www.linkedin.com/company/example-labs/",
        },
      ],
      links: ["https://fixture.example/post"],
      // The "open to work" framed profile photo is the author, not media.
      media: [
        {
          kind: "image",
          url: "https://media.licdn.com/dms/image/v2/A/feedshare-shrink_480/0/1?e=1",
          alt_text: "Fixture chart",
        },
      ],
      reactions: 1234,
      comments: 56,
      reposts: 7,
    });
    // Some cards label the author link "View <Name>’ profile".
    expect(second).toMatchObject({
      author: {
        profile_url: expect.stringContaining("/in/fixture-author-2"),
        verified: false,
        premium: true,
      },
      media: [
        {
          kind: "video",
          thumbnail_url:
            "https://media.licdn.com/dms/image/v2/C/videocover-high/0/2?e=1",
        },
      ],
      reactions: 0,
      comments: 0,
      reposts: 0,
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
