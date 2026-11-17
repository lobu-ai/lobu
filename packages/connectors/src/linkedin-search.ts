/**
 * Read-only LinkedIn lookups: people search, profile read, company search and
 * company read. Each is one content-script scrape of the page LinkedIn itself
 * renders in the paired Chrome, so nothing is clicked and nothing is stored.
 * Selectors follow the current SDUI markup (obfuscated classes, `componentkey`
 * attributes, `role="listitem"` result rows); row text is parsed here.
 */

import {
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  type ExtensionScrapeConfig,
  extensionDomScrape,
  requireBrowser,
} from "@lobu/connector-sdk";
import {
  LINKEDIN_ALLOWED_ORIGINS,
  LINKEDIN_LOGGED_OUT_ERROR,
  LINKEDIN_LOGGED_OUT_WHEN,
} from "./linkedin-browser-script.js";

type Row = Record<string, unknown>;

const MAX_TEXT_INPUT = 200;
const MAX_PAGE = 10;
const MAX_POSITIONS = 15;
const MAX_EDUCATION = 10;
const MAX_ABOUT_CHARS = 4000;

/** LinkedIn's people-search connection-degree facet values. */
const NETWORK_FACETS = { "1st": "F", "2nd": "S", "3rd": "O" } as const;

class InputError extends Error {}

function optionalText(input: Row, name: string): string | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new InputError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_INPUT)
    throw new InputError(
      `${name} must be at most ${MAX_TEXT_INPUT} characters`
    );
  return trimmed || undefined;
}

function requiredText(input: Row, name: string): string {
  const value = optionalText(input, name);
  if (!value) throw new InputError(`${name} is required`);
  return value;
}

/** Search pages are 1-based; one call reads one page. */
export function readSearchPage(input: Row): number {
  const value = input.page ?? 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PAGE
  ) {
    throw new InputError(`page must be an integer from 1 to ${MAX_PAGE}`);
  }
  return value;
}

function readNetwork(input: Row): Array<keyof typeof NETWORK_FACETS> {
  const value = input.network;
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => !Object.hasOwn(NETWORK_FACETS, String(item)))
  ) {
    throw new InputError('network must be an array of "1st", "2nd" or "3rd"');
  }
  return [...new Set(value as Array<keyof typeof NETWORK_FACETS>)];
}

function linkedInUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new InputError(`${name} must be a LinkedIn URL`);
  }
  const host = url.hostname.toLowerCase();
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (host !== "linkedin.com" && !host.endsWith(".linkedin.com"))
  ) {
    throw new InputError(`${name} must be a LinkedIn URL`);
  }
  return url;
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `https://www.linkedin.com/in/<slug>/` for a member profile URL, else null. */
function canonicalProfileUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = linkedInUrl(raw, "profile_url");
  } catch {
    return null;
  }
  const slug = url.pathname.match(/^\/in\/([^/]+)/i)?.[1];
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(decodedSegment(slug))}/`;
}

/** `https://www.linkedin.com/company/<slug-or-id>/` for a company URL, else null. */
function canonicalCompanyUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = linkedInUrl(raw, "company_url");
  } catch {
    return null;
  }
  const slug = url.pathname.match(/^\/(?:company|showcase|school)\/([^/]+)/i);
  if (!slug?.[1]) return null;
  const kind = url.pathname.split("/")[1]?.toLowerCase() ?? "company";
  return `https://www.linkedin.com/${kind}/${encodeURIComponent(decodedSegment(slug[1]))}/`;
}

const DEGREE_RE = /^[·•]?\s*(1st|2nd|3rd)\b/i;

function degreeOf(text: string | undefined): string | null {
  const match = text?.match(/[·•]\s*(1st|2nd|3rd)\b/i) ?? null;
  return match ? match[1].toLowerCase() : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function lineTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => cleanText((part as Row | null)?.t))
    .filter((line) => line.length > 0);
}

function nonEmpty(value: string | undefined | null): string | null {
  return value ? value : null;
}

/** LinkedIn's "30M followers" / "1,234 followers" → 30000000 / 1234. */
function parseFollowerCount(text: string): number | null {
  const match = text.match(/([\d.,]+)\s*([KMB])?\+?\s+followers?\b/i);
  if (!match?.[1]) return null;
  const unit = match[2]?.toUpperCase();
  const base = unit
    ? Number.parseFloat(match[1].replace(/,/g, ""))
    : Number.parseInt(match[1].replace(/[.,]/g, ""), 10);
  if (!Number.isFinite(base)) return null;
  const scale =
    unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : 1;
  return Math.round(base * scale);
}

async function scrape(
  dispatcher: ChromeActionDispatcher,
  url: string,
  config: ExtensionScrapeConfig
): Promise<{ rows: Row[]; loggedIn: boolean; landedUrl?: string }> {
  const result = await extensionDomScrape<Row>({
    dispatcher,
    url,
    config: { loggedOutWhen: LINKEDIN_LOGGED_OUT_WHEN, ...config },
    parseRows: (rows) => rows,
    allowedOrigins: LINKEDIN_ALLOWED_ORIGINS,
    persistent: false,
  });
  return {
    rows: result.items,
    loggedIn: result.loggedIn,
    landedUrl: result.landedUrl,
  };
}

type Run = (dispatcher: ChromeActionDispatcher) => Promise<Row | null>;

/** Validate every input first, then dispatch; a null run result means the
 * paired Chrome is signed out of LinkedIn. */
async function runAction(
  ctx: ActionContext,
  prepare: (input: Row) => Run
): Promise<ActionResult> {
  let run: Run;
  try {
    run = prepare(ctx.input);
  } catch (error) {
    if (error instanceof InputError)
      return { success: false, error: error.message };
    throw error;
  }
  const output = await run(requireBrowser(ctx));
  if (!output) return { success: false, error: LINKEDIN_LOGGED_OUT_ERROR };
  return { success: true, output };
}

// ── search_people ──────────────────────────────────────────────

/** Public jobs typeahead: the only location lookup that returns geo ids as JSON. */
function geoTypeaheadUrl(query: string): string {
  const params = new URLSearchParams({
    origin: "jserp",
    typeaheadType: "GEO",
    geoTypes: "POPULATED_PLACE,ADMIN_DIVISION_2,MARKET_AREA,COUNTRY_REGION",
    query,
  });
  return `https://www.linkedin.com/jobs-guest/api/typeaheadHits?${params}`;
}

/** First geo hit from the typeahead body. Chrome's JSON viewer can prefix
 * the raw text with its own "Raw/Parsed" toggle label, so parse from `[`. */
function parseGeoTypeahead(
  text: string | undefined
): { geo_id: string; display_name: string } | null {
  if (!text) return null;
  const start = text.indexOf("[");
  if (start < 0) return null;
  let hits: unknown;
  try {
    hits = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(hits)) return null;
  for (const hit of hits) {
    const id = String((hit as Row | null)?.id ?? "");
    const name = cleanText((hit as Row | null)?.displayName);
    if (/^\d+$/.test(id)) return { geo_id: id, display_name: name };
  }
  return null;
}

const PEOPLE_SEARCH_CONFIG = {
  scroll: { max: 1, stall: 1, waitMs: 2000 },
  // The first result sits inside its own SearchResults_FirstResult wrapper,
  // so match list items anywhere under <main> rather than direct children.
  rowSelector: 'main [role="listitem"]',
  requireFields: ["profile_url"],
  id: { source: "field", field: "profile_url" },
  fields: {
    profile_url: { selector: 'a[href*="/in/"]', take: "attr", attr: "href" },
    name: { selector: 'p > a[href*="/in/"]', take: "text" },
    name_line: { selector: 'p:has(> a[href*="/in/"])', take: "text" },
    headline: { selector: 'p:has(> a[href*="/in/"]) + div', take: "text" },
    location: {
      selector: 'p:has(> a[href*="/in/"]) + div + div',
      take: "text",
    },
    snippet: {
      selector: '[componentkey^="SearchResultssnippet_"]',
      take: "text",
    },
  },
};

function parsePeopleRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const people: Row[] = [];
  for (const row of rows) {
    const profileUrl = canonicalProfileUrl(cleanText(row.profile_url));
    if (!profileUrl || seen.has(profileUrl)) continue;
    seen.add(profileUrl);
    const nameLine = cleanText(row.name_line);
    const name =
      cleanText(row.name) || nameLine.replace(/\s*[·•].*$/, "").trim();
    const snippet = cleanText(row.snippet);
    const current = snippet.match(/^Current:\s*(.+)$/i)?.[1];
    people.push({
      name: nonEmpty(name),
      headline: nonEmpty(cleanText(row.headline)),
      location: nonEmpty(cleanText(row.location)),
      profile_url: profileUrl,
      degree: degreeOf(nameLine),
      ...(current ? { current_position: current } : snippet ? { snippet } : {}),
    });
  }
  return people;
}

export async function searchLinkedInPeople(
  ctx: ActionContext
): Promise<ActionResult> {
  return runAction(ctx, (input) => {
    const searchKeywords = requiredText(input, "keywords");
    const title = optionalText(input, "title");
    const company = optionalText(input, "company");
    const location = optionalText(input, "location");
    const network = readNetwork(input);
    const page = readSearchPage(input);
    return async (dispatcher) => {
      let keywords = searchKeywords;

      let locationFilter: Row | undefined;
      let geoId: string | undefined;
      if (location) {
        const { rows } = await scrape(dispatcher, geoTypeaheadUrl(location), {
          scroll: { max: 0, stall: 0, waitMs: 300 },
          rowSelector: "body",
          fields: { json: { selector: "pre", take: "text" } },
        });
        const hit = parseGeoTypeahead(cleanText(rows[0]?.json));
        if (hit) {
          geoId = hit.geo_id;
          locationFilter = { query: location, applied: "geo_filter", ...hit };
        } else {
          keywords = `${keywords} ${location}`;
          locationFilter = { query: location, applied: "keywords" };
        }
      }

      const params = new URLSearchParams({
        keywords,
        origin: "FACETED_SEARCH",
      });
      if (title) params.set("title", title);
      if (company) params.set("company", company);
      if (network.length)
        params.set(
          "network",
          JSON.stringify(network.map((degree) => NETWORK_FACETS[degree]))
        );
      if (geoId) params.set("geoUrn", JSON.stringify([geoId]));
      if (page > 1) params.set("page", String(page));
      const url = `https://www.linkedin.com/search/results/people/?${params}`;

      const { rows, loggedIn } = await scrape(
        dispatcher,
        url,
        PEOPLE_SEARCH_CONFIG
      );
      if (!loggedIn) return null;
      const people = parsePeopleRows(rows);
      return {
        page,
        search_url: url,
        ...(locationFilter ? { location_filter: locationFilter } : {}),
        count: people.length,
        people,
      };
    };
  });
}

// ── read_profile ───────────────────────────────────────────────

// Scrape payloads can reach the extension with their keys re-ordered, so
// every config names its merge key instead of relying on the first field.
const PROFILE_CONFIG = {
  // The page scrolls inside <main>; the top card and About render first.
  scroll: { max: 2, stall: 1, waitMs: 2000, deep: true },
  rowSelector: "main section",
  id: { source: "field", field: "text" },
  fields: {
    text: { take: "text" },
    heading: { selector: "h2", take: "text" },
    lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
    // The top card renders a hidden alternate degree badge as the only child
    // of a display:none wrapper; the visible badge has siblings.
    visible_lines: {
      selector: "p:not(:only-child)",
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
  },
};

// The main profile only renders Experience and Education when their lazy
// anchors scroll into a visible viewport, so read the details pages instead.
const EDUCATION_CONFIG = {
  scroll: { max: 2, stall: 1, waitMs: 2500, deep: true },
  rowSelector: 'main [componentkey*="EducationDetailsSection"] [componentkey]',
  requireFields: ["lines"],
  id: { source: "field", field: "text" },
  fields: {
    text: { take: "text" },
    lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
  },
};

const EXPERIENCE_CONFIG = {
  scroll: { max: 2, stall: 1, waitMs: 2500, deep: true },
  id: { source: "field", field: "text" },
  // Single-role entries are keyed collection items with no role list; a
  // company with several roles renders each role as an <li> under its header.
  rowSelector: [
    'main [componentkey^="entity-collection-item"]:not(:has(li))',
    'main [componentkey^="entity-collection-item"] li',
  ].join(", "),
  fields: {
    text: { take: "text" },
    lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
    company_url: {
      selector: 'a[href*="/company/"], a[href*="/school/"]',
      take: "attr",
      attr: "href",
    },
    group_company: {
      closestSelector: '[componentkey^="entity-collection-item"]',
      firstLine: true,
    },
  },
};

const DATE_RANGE_RE =
  /^(?:[A-Z][a-z]{2,8}\.? )?\d{4}\s*[-–]\s*(?:(?:[A-Z][a-z]{2,8}\.? )?\d{4}|Present)\b/;
const YEAR_RANGE_RE =
  /^(?:[A-Z][a-z]{2,8}\.? )?\d{4}(?:\s*[-–]\s*(?:(?:[A-Z][a-z]{2,8}\.? )?\d{4}|Present))?$/;

/** One experience row → {title, company, employment_type, dates, duration}. */
function parseExperienceRow(row: Row): Row | null {
  const lines = lineTexts(row.lines);
  const title = lines[0];
  if (!title) return null;
  const dateIndex = lines.findIndex((line) => DATE_RANGE_RE.test(line));
  const group = cleanText(row.group_company);
  let company: string | undefined;
  let employmentType: string | undefined;
  if (group) {
    // Grouped roles: the company is the header of the enclosing entry.
    company = group;
  } else if (dateIndex !== 1 && lines[1]) {
    const [name, type] = lines[1].split(/\s+·\s+/);
    company = name;
    employmentType = type;
  }
  const [dates, duration] =
    dateIndex >= 0 ? lines[dateIndex].split(/\s+·\s+/) : [];
  return {
    title,
    company: nonEmpty(company ?? null),
    ...(employmentType ? { employment_type: employmentType } : {}),
    dates: nonEmpty(dates ?? null),
    ...(duration ? { duration } : {}),
    is_current: /present/i.test(dates ?? ""),
    company_url: canonicalCompanyUrl(cleanText(row.company_url)),
  };
}

function parseEducationRow(row: Row): Row | null {
  const lines = lineTexts(row.lines);
  const school = lines[0];
  if (!school) return null;
  const dateIndex = lines.findIndex((line) => YEAR_RANGE_RE.test(line));
  const degree =
    lines[1] && dateIndex !== 1 && !/:\s*$/.test(lines[1])
      ? lines[1]
      : undefined;
  return {
    school,
    degree: nonEmpty(degree ?? null),
    dates: dateIndex >= 0 ? lines[dateIndex] : null,
  };
}

/** Top card + About from the main profile page's `section` rows. */
function parseProfileSections(rows: Row[]): Row {
  const top = rows.find((row) => cleanText(row.heading)) ?? rows[0];
  const name = cleanText(top?.heading);
  const lines = lineTexts(top?.lines);
  const degreeLine = lineTexts(top?.visible_lines).find((line) =>
    DEGREE_RE.test(line.replace(/^[·•]\s*/, ""))
  );
  // Drop the degree badges and the optional pronoun line ("She/Her") that
  // LinkedIn renders between the name and the headline.
  const content = lines.filter(
    (line) =>
      !/^[·•]\s*(1st|2nd|3rd\+?|You)$/i.test(line) &&
      !/^[A-Za-z]+\/[A-Za-z]+$/.test(line)
  );
  // The location is the line before the "· Contact info" separator.
  const separator = content.findIndex((line) => line === "·");
  const about = rows.find(
    (row) => cleanText(row.heading).toLowerCase() === "about"
  );
  const aboutText = lineTexts(about?.lines).reduce(
    (longest, line) => (line.length > longest.length ? line : longest),
    ""
  );
  return {
    name: nonEmpty(name),
    headline: nonEmpty(content[0] ?? null),
    location: separator > 0 ? content[separator - 1] : null,
    degree: degreeOf(degreeLine),
    about: nonEmpty(aboutText.slice(0, MAX_ABOUT_CHARS)),
  };
}

export async function readLinkedInProfile(
  ctx: ActionContext
): Promise<ActionResult> {
  return runAction(ctx, (input) => {
    const profileUrl = canonicalProfileUrl(requiredText(input, "profile_url"));
    if (!profileUrl)
      throw new InputError(
        "profile_url must be a LinkedIn member profile URL (linkedin.com/in/<slug>)"
      );
    return async (dispatcher) => {
      const main = await scrape(dispatcher, profileUrl, PROFILE_CONFIG);
      if (!main.loggedIn) return null;
      const landed = canonicalProfileUrl(main.landedUrl) ?? profileUrl;
      const experience = await scrape(
        dispatcher,
        `${landed}details/experience/`,
        EXPERIENCE_CONFIG
      );
      if (!experience.loggedIn) return null;
      const positions = experience.rows
        .map(parseExperienceRow)
        .filter((row): row is Row => row !== null);
      const schools = await scrape(
        dispatcher,
        `${landed}details/education/`,
        EDUCATION_CONFIG
      );
      if (!schools.loggedIn) return null;
      const education = schools.rows
        .map(parseEducationRow)
        .filter((row): row is Row => row !== null);
      return {
        profile_url: landed,
        ...parseProfileSections(main.rows),
        current_positions: positions
          .filter((row) => row.is_current)
          .slice(0, MAX_POSITIONS),
        past_positions: positions
          .filter((row) => !row.is_current)
          .slice(0, MAX_POSITIONS),
        education: education.slice(0, MAX_EDUCATION),
      };
    };
  });
}

// ── search_companies ───────────────────────────────────────────

// A card's header is the name <p> (holding the company link) followed by one
// sibling <div><p> per fact: industry, then location when the company lists one.
// The summary and follower line live in a separate subtree, so reading facts by
// position over every <p> would take the summary as a missing location.
const COMPANY_NAME = 'p:has(> a[href*="/company/"]), p:has(> a[href*="/showcase/"])';
const COMPANY_SEARCH_CONFIG = {
  scroll: { max: 1, stall: 1, waitMs: 2500 },
  rowSelector: 'main [role="listitem"]',
  requireFields: ["company_url"],
  id: { source: "field", field: "company_url" },
  fields: {
    company_url: {
      selector: 'a[href*="/company/"], a[href*="/showcase/"]',
      take: "attr",
      attr: "href",
    },
    name: { selector: COMPANY_NAME },
    facts: {
      selector: 'p:has(> a[href*="/company/"]) ~ div > p, p:has(> a[href*="/showcase/"]) ~ div > p',
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
  },
};

function parseCompanyRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const companies: Row[] = [];
  for (const row of rows) {
    const companyUrl = canonicalCompanyUrl(cleanText(row.company_url));
    if (!companyUrl || seen.has(companyUrl)) continue;
    seen.add(companyUrl);
    const facts = lineTexts(row.facts);
    const followersLine = lineTexts(row.lines).find((line) =>
      /\bfollowers?$/i.test(line)
    );
    companies.push({
      name: nonEmpty(cleanText(row.name)),
      industry: nonEmpty(facts[0] ?? null),
      location: nonEmpty(facts[1] ?? null),
      followers: followersLine ? parseFollowerCount(followersLine) : null,
      company_url: companyUrl,
    });
  }
  return companies;
}

export async function searchLinkedInCompanies(
  ctx: ActionContext
): Promise<ActionResult> {
  return runAction(ctx, (input) => {
    const keywords = requiredText(input, "keywords");
    const page = readSearchPage(input);
    return async (dispatcher) => {
      const params = new URLSearchParams({ keywords });
      if (page > 1) params.set("page", String(page));
      const url = `https://www.linkedin.com/search/results/companies/?${params}`;
      const { rows, loggedIn } = await scrape(
        dispatcher,
        url,
        COMPANY_SEARCH_CONFIG
      );
      if (!loggedIn) return null;
      const companies = parseCompanyRows(rows);
      return { page, search_url: url, count: companies.length, companies };
    };
  });
}

// ── read_company ───────────────────────────────────────────────

const COMPANY_ABOUT_CONFIG = {
  scroll: { max: 1, stall: 1, waitMs: 2500 },
  rowSelector: "main section",
  id: { source: "field", field: "text" },
  fields: {
    text: { take: "text" },
    heading: { selector: "h1, h2", take: "text" },
    lines: {
      selector: "h2, h3, p, dt, dd",
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
  },
};

const COMPANY_FACTS = {
  website: "website",
  industry: "industry",
  "company size": "company_size",
  headquarters: "headquarters",
  founded: "founded",
  type: "type",
  specialties: "specialties",
} as const;

/** The About tab's first section: name, overview, then labelled facts. */
function parseCompanyAbout(rows: Row[]): Row {
  const top = rows.find((row) => cleanText(row.heading)) ?? rows[0];
  const lines = lineTexts(top?.lines);
  const facts: Record<string, string | null> = Object.fromEntries(
    Object.values(COMPANY_FACTS).map((key) => [key, null])
  );
  lines.forEach((line, index) => {
    const key = COMPANY_FACTS[line.toLowerCase() as keyof typeof COMPANY_FACTS];
    const value = lines[index + 1];
    if (key && value && facts[key] === null) facts[key] = value;
  });
  const overview = lines.findIndex((line) => line === "Overview");
  const followersLine = lines.find((line) => /\bfollowers?$/i.test(line));
  return {
    name: nonEmpty(cleanText(top?.heading)),
    about:
      overview >= 0
        ? nonEmpty((lines[overview + 1] ?? "").slice(0, MAX_ABOUT_CHARS))
        : null,
    ...facts,
    followers: followersLine ? parseFollowerCount(followersLine) : null,
  };
}

export async function readLinkedInCompany(
  ctx: ActionContext
): Promise<ActionResult> {
  return runAction(ctx, (input) => {
    const companyUrl = canonicalCompanyUrl(requiredText(input, "company_url"));
    if (!companyUrl)
      throw new InputError(
        "company_url must be a LinkedIn company page URL (linkedin.com/company/<slug>)"
      );
    return async (dispatcher) => {
      const { rows, loggedIn, landedUrl } = await scrape(
        dispatcher,
        `${companyUrl}about/`,
        COMPANY_ABOUT_CONFIG
      );
      if (!loggedIn) return null;
      return {
        company_url: canonicalCompanyUrl(landedUrl) ?? companyUrl,
        ...parseCompanyAbout(rows),
      };
    };
  });
}

export { InputError as LinkedInInputError, requiredText, runAction };
