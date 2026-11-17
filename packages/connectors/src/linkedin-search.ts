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
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_SKILLS = 50;

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

/** LinkedIn's "… more" expander text, rendered inside clamped paragraphs. */
function stripMore(text: string): string {
  return text.replace(/\s*…\s*(?:see\s+)?more$/i, "").trim();
}

// innerHTML escapes only these in text; `&quot;` appears in attributes alone.
const HTML_TEXT_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/**
 * The first paragraph with a line break. The scraper's `text` read collapses
 * every newline to a space; its `html` read keeps the `<br>`s.
 */
const MULTILINE_HTML = { selector: "p:has(br)", take: "html" } as const;

/**
 * `text` with the line breaks of `html` restored. The html only supplies the
 * formatting: when it is a different element (its text differs), `text` is
 * returned unchanged.
 */
export function withLineBreaks(text: string, html: unknown): string {
  if (typeof html !== "string" || !text) return text;
  // Drop tags until none remain, so one tag split by another cannot reassemble.
  // A tag skips a ">" inside a double-quoted attribute value.
  let plain = html.replace(/<br\s*\/?>/gi, "\n");
  for (let previous = ""; plain !== previous; ) {
    previous = plain;
    plain = plain.replace(/<(?:[^>"]|"[^"]*")*>/g, "");
  }
  const multiline = stripMore(
    plain
      .replace(
        /&(amp|lt|gt|nbsp);/g,
        (_entity, name: string) => HTML_TEXT_ENTITIES[name]
      )
      .split("\n")
      .map(cleanText)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
  return cleanText(multiline) === cleanText(text) ? multiline : text;
}

/** Outbound links render as `linkedin.com/safety/go/?url=<target>`. */
export function decodeLinkedInRedirect(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, "https://www.linkedin.com");
  } catch {
    return null;
  }
  if (url.pathname.startsWith("/safety/go")) {
    const target = url.searchParams.get("url");
    return target && /^https?:\/\//i.test(target) ? target : null;
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.href
    : null;
}

function linkList(value: unknown): Array<{ href: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => ({
      href: cleanText((part as Row | null)?.h),
      text: cleanText((part as Row | null)?.t),
    }))
    .filter((link) => link.href.length > 0);
}

function parseCount(text: string): number {
  return Number.parseInt(text.replace(/[,.]/g, ""), 10);
}

/**
 * "A, B & 5 other mutual connections" / "A is a mutual connection" /
 * "Filiz & 12 other connections work here": the named people plus "N other".
 */
function countNamedConnections(text: string, named: number): number {
  const others = text.match(/(\d[\d,]*)\s+others?\b/i)?.[1];
  return named + (others ? parseCount(others) : 0);
}

const WORKPLACE_TYPES = new Set(["hybrid", "remote", "on-site"]);

/** "London, UK · Hybrid" → location + workplace type; "Remote" alone too. */
function splitWorkplace(line: string | undefined): {
  location: string | null;
  workplace_type: string | null;
} {
  if (!line) return { location: null, workplace_type: null };
  const parts = line.split(/\s+·\s+/);
  const last = parts.at(-1) ?? "";
  if (WORKPLACE_TYPES.has(last.toLowerCase())) {
    return {
      location: nonEmpty(parts.slice(0, -1).join(" · ")),
      workplace_type: last,
    };
  }
  return { location: line, workplace_type: null };
}

const DURATION_RE = /^\d+\s+(?:yrs?|mos?)\b/i;

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
    verified: {
      selector: 'p > a[href*="/in/"] [role="img"][aria-label]',
      take: "attr",
      attr: "aria-label",
    },
    headline: { selector: 'p:has(> a[href*="/in/"]) + div', take: "text" },
    location: {
      selector: 'p:has(> a[href*="/in/"]) + div + div',
      take: "text",
    },
    snippet: {
      selector: '[componentkey^="SearchResultssnippet_"]',
      take: "text",
    },
    // The shared-connections line links each named mutual connection and,
    // past two, a canned search for the rest.
    mutual_line: {
      selector:
        'p:has(> span > a[href*="/in/"]), p:has(> span > a[href*="connectionOf"])',
      take: "text",
    },
    mutual_people: {
      selector: 'p > span > a[href*="/in/"]',
      take: "objectAll",
      parts: { h: { take: "attr", attr: "href" }, t: { take: "text" } },
    },
    mutual_search: {
      selector: 'a[href*="connectionOf"]',
      take: "attr",
      attr: "href",
    },
  },
};

function mutualConnections(
  line: string,
  people: Array<{ name: string; profile_url: string | null }>,
  searchUrl: string
): Row | null {
  if (!/\bmutual connections?\b/i.test(line)) return null;
  return {
    count: countNamedConnections(line, people.length),
    people,
    search_url: searchUrl ? decodeLinkedInRedirect(searchUrl) : null,
  };
}

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
    const [, label, value] = snippet.match(/^(Current|Past):\s*(.+)$/i) ?? [];
    const mutual = mutualConnections(
      cleanText(row.mutual_line),
      linkList(row.mutual_people).map((link) => ({
        name: link.text,
        profile_url: canonicalProfileUrl(link.href),
      })),
      cleanText(row.mutual_search)
    );
    people.push({
      name: nonEmpty(name),
      headline: nonEmpty(cleanText(row.headline)),
      location: nonEmpty(cleanText(row.location)),
      profile_url: profileUrl,
      degree: degreeOf(nameLine),
      verified: cleanText(row.verified).toLowerCase() === "verified",
      current_position:
        label?.toLowerCase() === "current" ? nonEmpty(value) : null,
      past_position: label?.toLowerCase() === "past" ? nonEmpty(value) : null,
      snippet: label ? null : nonEmpty(snippet),
      mutual_connections: mutual,
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
    links: {
      selector: "a[href]",
      take: "objectAll",
      parts: { h: { take: "attr", attr: "href" }, t: { take: "text" } },
    },
    mutual_names: {
      selector: 'a[href*="connectionOf"] strong',
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    multiline_html: MULTILINE_HTML,
  },
};

// The main profile only renders Experience and Education when their lazy
// anchors scroll into a visible viewport, so read the details pages instead.
const DETAIL_LINES = {
  lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
  // Long descriptions are the only paragraphs that wrap their text in a span.
  spans: {
    selector: "p > span",
    take: "objectAll",
    parts: { t: { take: "text" } },
  },
  org_url: {
    selector: 'a[href*="/company/"], a[href*="/school/"]',
    take: "attr",
    attr: "href",
  },
  multiline_html: MULTILINE_HTML,
} as const;

const EDUCATION_CONFIG = {
  scroll: { max: 2, stall: 1, waitMs: 2500, deep: true },
  rowSelector: 'main [componentkey*="EducationDetailsSection"] [componentkey]',
  requireFields: ["lines"],
  id: { source: "field", field: "text" },
  fields: { text: { take: "text" }, ...DETAIL_LINES },
};

const EXPERIENCE_CONFIG = {
  scroll: { max: 2, stall: 1, waitMs: 2500, deep: true },
  id: { source: "field", field: "text" },
  // A company with several roles renders one header entry with each role as
  // an <li>; single-role entries have no list. Rows arrive in document order,
  // so each role list follows its company header.
  rowSelector: [
    'main [componentkey^="entity-collection-item"]',
    'main [componentkey^="entity-collection-item"] li',
  ].join(", "),
  fields: {
    text: { take: "text" },
    ...DETAIL_LINES,
    // Paragraphs inside role items; on a header row they are its roles' lines.
    role_lines: {
      selector: "li p",
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    group_company: {
      closestSelector: '[componentkey^="entity-collection-item"]',
      firstLine: true,
    },
  },
};

const SKILLS_CONFIG = {
  scroll: { max: 3, stall: 1, waitMs: 2500, deep: true },
  // The escaped "(" is the same selector to Chrome; JSDOM needs the escape.
  rowSelector: 'main [componentkey^="com.linkedin.sdui.profile.skill\\("]',
  requireFields: ["name"],
  id: { source: "field", field: "name" },
  fields: {
    name: { selector: "p", take: "text" },
    lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
  },
};

// Only rendered for 1st-degree connections and the viewer's own profile;
// anyone else's overlay URL redirects back to the profile.
const CONTACT_CONFIG = {
  scroll: { max: 0, stall: 0, waitMs: 2000 },
  rowSelector: '[componentkey*="ContactInfoDetailSection"] [componentkey]',
  requireFields: ["label"],
  id: { source: "field", field: "text" },
  fields: {
    text: { take: "text" },
    label: { selector: "p", take: "text" },
    lines: { selector: "p", take: "objectAll", parts: { t: { take: "text" } } },
    links: {
      selector: "a[href]",
      take: "objectAll",
      parts: { h: { take: "attr", attr: "href" }, t: { take: "text" } },
    },
  },
};

const DATE_RANGE_RE =
  /^(?:[A-Z][a-z]{2,8}\.? )?\d{4}\s*[-–]\s*(?:(?:[A-Z][a-z]{2,8}\.? )?\d{4}|Present)\b/;
const YEAR_RANGE_RE =
  /^(?:[A-Z][a-z]{2,8}\.? )?\d{4}(?:\s*[-–]\s*(?:(?:[A-Z][a-z]{2,8}\.? )?\d{4}|Present))?$/;

/** The joined long-text spans, minus the role's "Present" badge. */
function descriptionOf(row: Row): string | null {
  const text = lineTexts(row.spans)
    .filter((line) => line !== "Present")
    .map(stripMore)
    .join(" ")
    .trim();
  return nonEmpty(
    withLineBreaks(text, row.multiline_html).slice(0, MAX_DESCRIPTION_CHARS)
  );
}

type GroupHeader = {
  company: string;
  employment_type: string | null;
  location: string | null;
  workplace_type: string | null;
  company_url: string | null;
};

/** A multi-role company header: name, "Full-time · 6 yrs", location. */
function parseGroupHeader(row: Row): GroupHeader | null {
  const lines = lineTexts(row.lines);
  const header = lines.slice(0, lines.length - lineTexts(row.role_lines).length);
  if (!header[0]) return null;
  const facts = (header[1] ?? "").split(/\s+·\s+/).filter(Boolean);
  const type = facts.find((fact) => !DURATION_RE.test(fact));
  return {
    company: header[0],
    employment_type: type ?? null,
    ...splitWorkplace(header[2]),
    company_url: canonicalCompanyUrl(cleanText(row.org_url)),
  };
}

/** One role: title, company, dates, location, description. */
function parseExperienceRow(
  row: Row,
  group: GroupHeader | undefined
): Row | null {
  const lines = lineTexts(row.lines);
  const title = lines[0];
  if (!title) return null;
  const description = descriptionOf(row);
  const dateIndex = lines.findIndex((line) => DATE_RANGE_RE.test(line));
  let company = group?.company ?? null;
  let employmentType = group?.employment_type ?? null;
  if (!group && dateIndex !== 1 && lines[1]) {
    const [name, type] = lines[1].split(/\s+·\s+/);
    company = nonEmpty(name);
    employmentType = nonEmpty(type);
  }
  const [dates, duration] =
    dateIndex >= 0 ? lines[dateIndex].split(/\s+·\s+/) : [];
  // The location, when listed, is the first plain line after the dates.
  const spans = new Set(lineTexts(row.spans));
  const locationLine =
    dateIndex >= 0
      ? lines
          .slice(dateIndex + 1)
          .find(
            (line) =>
              line !== "Present" && !spans.has(line) && !/^Skills:/i.test(line)
          )
      : undefined;
  const skillsLine = lines.find((line) => /^Skills:/i.test(line));
  const place = locationLine
    ? splitWorkplace(locationLine)
    : {
        location: group?.location ?? null,
        workplace_type: group?.workplace_type ?? null,
      };
  return {
    title,
    company,
    employment_type: employmentType,
    dates: nonEmpty(dates ?? null),
    duration: nonEmpty(duration ?? null),
    is_current: /present/i.test(dates ?? ""),
    ...place,
    description,
    skills: skillsLine
      ? skillsLine
          .replace(/^Skills:\s*/i, "")
          .split(/\s+·\s+/)
          .filter(Boolean)
      : [],
    company_url:
      canonicalCompanyUrl(cleanText(row.org_url)) ?? group?.company_url ?? null,
  };
}

function parseExperienceRows(rows: Row[]): Row[] {
  const groups = new Map<string, GroupHeader>();
  const positions: Row[] = [];
  for (const row of rows) {
    const groupName = cleanText(row.group_company);
    if (!groupName && lineTexts(row.role_lines).length > 0) {
      const header = parseGroupHeader(row);
      if (header) groups.set(header.company, header);
      continue;
    }
    const position = parseExperienceRow(
      row,
      groupName
        ? (groups.get(groupName) ?? {
            company: groupName,
            employment_type: null,
            location: null,
            workplace_type: null,
            company_url: null,
          })
        : undefined
    );
    if (position) positions.push(position);
  }
  return positions;
}

function parseEducationRow(row: Row): Row | null {
  const lines = lineTexts(row.lines);
  const school = lines[0];
  if (!school) return null;
  const spans = new Set(lineTexts(row.spans));
  const dateIndex = lines.findIndex((line) => YEAR_RANGE_RE.test(line));
  const labelled = (label: string) =>
    nonEmpty(
      lines
        .find((line) => line.startsWith(`${label}:`))
        ?.slice(label.length + 1)
        .trim() ?? null
    );
  const degreeLine =
    lines[1] &&
    dateIndex !== 1 &&
    !spans.has(lines[1]) &&
    !/^[A-Z][a-z ]+:/.test(lines[1])
      ? lines[1]
      : undefined;
  // LinkedIn joins the degree and the field of study with a comma.
  const comma = degreeLine?.indexOf(", ") ?? -1;
  return {
    school,
    degree: nonEmpty(comma > 0 ? degreeLine?.slice(0, comma) : degreeLine),
    field_of_study: comma > 0 ? nonEmpty(degreeLine?.slice(comma + 2)) : null,
    dates: dateIndex >= 0 ? lines[dateIndex] : null,
    grade: labelled("Grade"),
    activities: labelled("Activities and societies"),
    description: descriptionOf(row),
    school_url: canonicalCompanyUrl(cleanText(row.org_url)),
  };
}

function parseSkills(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const skills: Row[] = [];
  for (const row of rows) {
    const name = cleanText(row.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const endorsements = lineTexts(row.lines)
      .map((line) => line.match(/^(\d[\d,]*)\s+endorsements?$/i)?.[1])
      .find(Boolean);
    skills.push({
      name,
      endorsements: endorsements ? parseCount(endorsements) : 0,
    });
  }
  return skills.slice(0, MAX_SKILLS);
}

/** Contact overlay entries: a label paragraph followed by its value(s). */
function parseContactInfo(rows: Row[]): Row {
  const info: Row = {
    email: null,
    phone: null,
    websites: [],
    birthday: null,
    connected_since: null,
    address: null,
  };
  for (const row of rows) {
    const label = cleanText(row.label).toLowerCase();
    const values = lineTexts(row.lines).slice(1);
    const links = linkList(row.links);
    if (label === "website" || label === "websites") {
      info.websites = links.flatMap((link) => {
        const url = decodeLinkedInRedirect(link.href);
        if (!url) return [];
        const kind = values
          .find((value) => value.includes(link.text))
          ?.slice(link.text.length)
          .match(/^\s*\(([^)]+)\)/)?.[1];
        return [{ url, type: kind ?? null }];
      });
    } else if (label === "email") {
      const mail = links.find((link) => link.href.startsWith("mailto:"));
      info.email = mail ? mail.href.slice("mailto:".length) : nonEmpty(values[0]);
    } else if (label === "phone") {
      info.phone = nonEmpty(values.join(", "));
    } else if (label === "birthday") {
      info.birthday = nonEmpty(values[0]);
    } else if (label === "connected") {
      info.connected_since = nonEmpty(values[0]);
    } else if (label === "address") {
      info.address = nonEmpty(values.join(", "));
    }
  }
  return info;
}

/** Top card + About from the main profile page's `section` rows. */
function parseProfileSections(rows: Row[]): Row {
  const top = rows.find((row) => cleanText(row.heading)) ?? rows[0];
  const name = cleanText(top?.heading);
  const lines = lineTexts(top?.lines);
  const degreeLine = lineTexts(top?.visible_lines).find((line) =>
    DEGREE_RE.test(line.replace(/^[·•]\s*/, ""))
  );
  const pronouns = lines.find((line) => /^[A-Za-z]+\/[A-Za-z]+$/.test(line));
  // Drop the degree badges and the optional pronoun line ("She/Her") that
  // LinkedIn renders between the name and the headline.
  const content = lines.filter(
    (line) => !/^[·•]\s*(1st|2nd|3rd\+?|You)$/i.test(line) && line !== pronouns
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
  // "500+" / "connections" render as two paragraphs.
  const connectionsIndex = lines.findIndex((line) =>
    /^connections?$/i.test(line)
  );
  const connections =
    connectionsIndex > 0 && /^[\d,]+\+?$/.test(lines[connectionsIndex - 1])
      ? lines[connectionsIndex - 1]
      : null;
  // Creators show followers on the top card, everyone else in Activity.
  const followersLine = rows
    .flatMap((row) => lineTexts(row.lines))
    .find((line) => /^[\d,.]+[KMB]?\+?\s+followers?$/i.test(line));
  const links = linkList(top?.links);
  const mutualLink = links.find((link) => link.href.includes("connectionOf"));
  const mutualNames = lineTexts(top?.mutual_names).flatMap((names) =>
    names.split(/,\s*|\s+and\s+/).filter(Boolean)
  );
  const website = links
    .filter((link) => new URL(link.href, "https://www.linkedin.com").pathname.startsWith("/safety/go"))
    .map((link) => decodeLinkedInRedirect(link.href))
    .find(Boolean);
  return {
    name: nonEmpty(name),
    pronouns: nonEmpty(pronouns),
    headline: nonEmpty(content[0] ?? null),
    location: separator > 0 ? content[separator - 1] : null,
    degree: degreeOf(degreeLine),
    followers: followersLine ? parseFollowerCount(followersLine) : null,
    connections,
    mutual_connections: mutualLink
      ? {
          count: countNamedConnections(mutualLink.text, mutualNames.length),
          people: mutualNames.map((mutual) => ({
            name: mutual,
            profile_url: null,
          })),
          search_url: decodeLinkedInRedirect(mutualLink.href),
        }
      : null,
    website: website ?? null,
    about: nonEmpty(
      withLineBreaks(stripMore(aboutText), about?.multiline_html).slice(
        0,
        MAX_ABOUT_CHARS
      )
    ),
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
      const top = parseProfileSections(main.rows);
      // A missing degree badge means the viewer's own profile.
      const readContact = top.degree === "1st" || top.degree === null;
      const [experience, schools, skills, contact] = await Promise.all([
        scrape(dispatcher, `${landed}details/experience/`, EXPERIENCE_CONFIG),
        scrape(dispatcher, `${landed}details/education/`, EDUCATION_CONFIG),
        scrape(dispatcher, `${landed}details/skills/`, SKILLS_CONFIG),
        readContact
          ? scrape(dispatcher, `${landed}overlay/contact-info/`, CONTACT_CONFIG)
          : null,
      ]);
      if (
        !experience.loggedIn ||
        !schools.loggedIn ||
        !skills.loggedIn ||
        contact?.loggedIn === false
      )
        return null;
      const positions = parseExperienceRows(experience.rows);
      const education = schools.rows
        .map(parseEducationRow)
        .filter((row): row is Row => row !== null);
      return {
        profile_url: landed,
        ...top,
        contact_info: contact?.rows.length
          ? parseContactInfo(contact.rows)
          : null,
        current_positions: positions
          .filter((row) => row.is_current)
          .slice(0, MAX_POSITIONS),
        past_positions: positions
          .filter((row) => !row.is_current)
          .slice(0, MAX_POSITIONS),
        education: education.slice(0, MAX_EDUCATION),
        skills: parseSkills(skills.rows),
      };
    };
  });
}

// ── search_companies ───────────────────────────────────────────

/**
 * "Uzay & 1 other connection work here" / "Shivam Kumar follows this page":
 * the viewer's connections at (or following) a company.
 */
function networkConnections(
  link: { href: string; text: string } | undefined
): Row | null {
  if (!link?.text) return null;
  const names = link.text
    .replace(/\s+(?:works?|follows?)\b.*$/i, "")
    .split(/\s+&\s+\d/)[0];
  return {
    count: countNamedConnections(
      link.text,
      names.split(/,\s*|\s+and\s+/).filter(Boolean).length
    ),
    search_url: decodeLinkedInRedirect(link.href),
  };
}

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
    verified: {
      selector: '[role="img"][aria-label="Verified organization"]',
      take: "attr",
      attr: "aria-label",
    },
    facts: {
      selector: 'p:has(> a[href*="/company/"]) ~ div > p, p:has(> a[href*="/showcase/"]) ~ div > p',
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    // Paragraphs without links: the facts and the company summary.
    plain_lines: {
      selector: "p:not(:has(a))",
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    network: {
      selector:
        'a[href*="SHARED_CONNECTIONS"], a[href*="showInNetworkFollowers"]',
      take: "objectAll",
      parts: { h: { take: "attr", attr: "href" }, t: { take: "text" } },
    },
    follow_state: {
      selector: 'button[aria-label^="Follow"]',
      take: "attr",
      attr: "aria-label",
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
    const summary = lineTexts(row.plain_lines).find(
      (line) => !facts.includes(line) && !/\bfollowers?$/i.test(line)
    );
    const network = linkList(row.network)[0];
    const connections = networkConnections(network);
    const working = /\bwork(?:s)? here\b/i.test(network?.text ?? "");
    companies.push({
      name: nonEmpty(cleanText(row.name)),
      industry: nonEmpty(facts[0] ?? null),
      location: nonEmpty(facts[1] ?? null),
      summary: nonEmpty(stripMore(summary ?? "").replace(/\.\.\.$/, "…")),
      followers: followersLine ? parseFollowerCount(followersLine) : null,
      verified: cleanText(row.verified) !== "",
      following: /^Following\b/i.test(cleanText(row.follow_state)),
      connections_working_here: working ? connections : null,
      connections_following: working ? null : connections,
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

const TOP_CARD = '[componentkey^="pages.topCard."]';

// One row: the whole page. The top card carries the tagline, the follower and
// employee counts and the viewer's network; the About tab's Overview section
// lists the description followed by labelled facts.
const COMPANY_ABOUT_CONFIG = {
  scroll: { max: 1, stall: 1, waitMs: 2500 },
  rowSelector: "main",
  requireFields: ["name"],
  id: { source: "field", field: "name" },
  fields: {
    name: { selector: `${TOP_CARD} h2, h1`, take: "text" },
    top_card: { selector: TOP_CARD, take: "attr", attr: "componentkey" },
    tagline: { selector: `${TOP_CARD} div:has(> h2) + p`, take: "text" },
    top_facts: {
      selector: `${TOP_CARD} div:has(> h2) ~ div > p`,
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    top_lines: {
      selector: `${TOP_CARD} p`,
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    network: {
      selector: `${TOP_CARD} a[href*="network="]`,
      take: "objectAll",
      parts: { h: { take: "attr", attr: "href" }, t: { take: "text" } },
    },
    follow_state: {
      selector: `${TOP_CARD} button[aria-label^="Follow"]`,
      take: "attr",
      attr: "aria-label",
    },
    top_website: {
      selector: `${TOP_CARD} a[href*="/safety/go"]`,
      take: "attr",
      attr: "href",
    },
    lines: {
      selector: "h2, h3, p, dt, dd",
      take: "objectAll",
      parts: { t: { take: "text" } },
    },
    multiline_html: MULTILINE_HTML,
  },
};

const COMPANY_FACTS = {
  website: "website",
  "verified page": "verified_since",
  industry: "industry",
  "company size": "company_size",
  headquarters: "headquarters",
  founded: "founded",
  type: "type",
  specialties: "specialties",
  phone: "phone",
} as const;

function companyFactKey(line: string) {
  return COMPANY_FACTS[line.toLowerCase() as keyof typeof COMPANY_FACTS];
}

/** The top card, then the Overview section's description and labelled facts. */
function parseCompanyAbout(row: Row | undefined): Row {
  const lines = lineTexts(row?.lines);
  const facts: Record<string, string | null> = Object.fromEntries(
    Object.values(COMPANY_FACTS).map((key) => [key, null])
  );
  const overview = lines.indexOf("Overview");
  const body = overview >= 0 ? lines.slice(overview + 1) : [];
  body.forEach((line, index) => {
    const key = companyFactKey(line);
    const value = body[index + 1];
    if (key && value && facts[key] === null) facts[key] = value;
  });
  // The description runs until the highlights or the first labelled fact.
  const firstFact = body.findIndex((line) => companyFactKey(line));
  const highlightsStart = body.findIndex((line) =>
    line.startsWith("Highlights from ")
  );
  const aboutEnd = [highlightsStart, firstFact].filter((i) => i >= 0);
  const about = body
    .slice(0, aboutEnd.length ? Math.min(...aboutEnd) : 1)
    .map((paragraph) => withLineBreaks(paragraph, row?.multiline_html))
    .join("\n\n")
    .slice(0, MAX_ABOUT_CHARS);
  const highlights =
    highlightsStart >= 0
      ? body.slice(
          highlightsStart + 1,
          firstFact > highlightsStart ? firstFact : undefined
        )
      : [];
  const sizeIndex = body.findIndex(
    (line) => companyFactKey(line) === "company_size"
  );
  const membersLine =
    sizeIndex >= 0
      ? body
          .slice(sizeIndex + 2, sizeIndex + 4)
          .find((line) => /associated members?$/i.test(line))
      : undefined;
  const topFacts = lineTexts(row?.top_facts).filter((line) => line !== "·");
  const followersLine = topFacts.find((line) => /\bfollowers?$/i.test(line));
  const employeesLine = topFacts.find((line) => /\bemployees?$/i.test(line));
  const topLocation = topFacts.find(
    (line, index) =>
      index > 0 && line !== followersLine && line !== employeesLine
  );
  const companyId = cleanText(row?.top_card).match(/topCard\.(\d+)/)?.[1];
  const topWebsite = decodeLinkedInRedirect(cleanText(row?.top_website));
  return {
    company_id: companyId ?? null,
    name: nonEmpty(cleanText(row?.name)),
    tagline: nonEmpty(cleanText(row?.tagline)),
    about: nonEmpty(about),
    website: facts.website ?? (cleanText(row?.top_website) ? topWebsite : null),
    industry: facts.industry ?? nonEmpty(topFacts[0] ?? null),
    company_size: facts.company_size,
    employees_on_linkedin: membersLine ? parseCount(membersLine) : null,
    headquarters: facts.headquarters ?? nonEmpty(topLocation ?? null),
    founded: facts.founded,
    type: facts.type,
    specialties: facts.specialties
      ? facts.specialties.split(/,\s*/).filter(Boolean)
      : [],
    phone: facts.phone,
    followers: followersLine ? parseFollowerCount(followersLine) : null,
    verified: facts.verified_since !== null,
    verified_since: facts.verified_since,
    highlights:
      highlights.length > 0
        ? highlights
        : lineTexts(row?.top_lines).filter((line) =>
            line.startsWith("Ranked on LinkedIn")
          ),
    following: /^Following\b/i.test(cleanText(row?.follow_state)),
    connections_working_here: networkConnections(linkList(row?.network)[0]),
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
        ...parseCompanyAbout(rows[0]),
      };
    };
  });
}

export { InputError as LinkedInInputError, requiredText, runAction };
