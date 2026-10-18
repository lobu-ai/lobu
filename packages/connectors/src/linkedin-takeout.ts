/**
 * LinkedIn Data Export (takeout) readers.
 *
 * The ten CSV-backed LinkedIn feeds live here as PURE row-to-event transforms.
 * Every filesystem touch is funnelled through one injected {@link
 * TakeoutCsvReader}, so this module imports no `node:fs` and no `node:path` and
 * stays isolate-eligible.
 *
 * WHY THE INJECTION: `linkedin.ts` declares live browser feeds and
 * these takeout feeds on ONE connector key, because a person met in the live
 * home feed and a person in the CSV export must collapse onto the same
 * `linkedin_slug`/`email` identity. But the connector bundle runs in a V8
 * isolate — the only execution lane — and `assertIsolateEligible` rejects the
 * whole bundle when a single Node builtin `require` survives esbuild. So while
 * the connector imported these readers' filesystem access transitively, the
 * LIVE feeds could not load either: a fresh home_feed sync failed with
 * "requires Node builtins [fs, path]" before the browser was ever dispatched
 * (Lobu#3392).
 *
 * Passing the reader in rather than importing it inverts that dependency. The
 * parsing logic stays here, single-sourced and directly testable against real
 * files (hand a reader that hits a temp dir); only the capability is supplied
 * from outside, by whichever caller actually has filesystem access.
 *
 * NOTE this does not by itself make takeout ingest run. Nothing supplies a
 * reader on the platform's own path, so a takeout feed throws and names the
 * missing capability instead of silently returning zero events, which a
 * scheduler would record as a clean empty sync. Unlike the single-purpose
 * takeout connectors, LinkedIn cannot declare `requiredCapability: "os.files"`
 * to route around this: its live feeds need the Chrome extension, and one
 * connector declares one capability. The feed declarations, keys and checkpoint
 * cursors are carried over unchanged, ready for the day a filesystem-capable
 * lane can serve them.
 */

import type { EventEnvelope } from "@lobu/connector-sdk";
import { normalizeLinkedInSlug } from "./linkedin-identity.js";
import { stableId, stripHtml } from "./takeout-utils.js";

/**
 * Reads one CSV inside the export, by POSIX-style relative path, and returns
 * its parsed rows. A file that does not exist yields `[]` — a LinkedIn export
 * omits sections the member never used, and a missing section is not an error.
 */
export type TakeoutCsvReader = (
  relativePath: string
) => Record<string, string>[];

export function readMessages(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("messages.csv").flatMap((row) => {
    const occurredAt = parseLinkedInDate(row.DATE);
    const content = row.CONTENT?.trim();
    if (!occurredAt || !content) return [];
    return [
      {
        origin_id: stableId("li_message", [
          row["CONVERSATION ID"],
          row.DATE,
          row.FROM,
          row.TO,
          content,
        ]),
        origin_type: "message",
        occurred_at: occurredAt,
        payload_text: content,
        author_name: row.FROM,
        source_url: row["SENDER PROFILE URL"],
        title: row["CONVERSATION TITLE"] || row.SUBJECT,
        metadata: {
          platform: "linkedin",
          conversation_id: row["CONVERSATION ID"],
          conversation_title: row["CONVERSATION TITLE"],
          from: row.FROM,
          sender_profile_url: row["SENDER PROFILE URL"],
          sender_linkedin_slug:
            normalizeLinkedInSlug(row["SENDER PROFILE URL"]) ?? undefined,
          to: row.TO,
          recipient_profile_urls: row["RECIPIENT PROFILE URLS"],
          subject: row.SUBJECT,
          folder: row.FOLDER,
          attachments: row.ATTACHMENTS,
        },
      },
    ];
  });
}

export function readConnections(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Connections.csv").flatMap((row) => {
    const fullName = [row["First Name"], row["Last Name"]]
      .filter(Boolean)
      .join(" ")
      .trim();
    const occurredAt = parseLinkedInDate(row["Connected On"]);
    if (!fullName || !occurredAt) return [];
    return [
      {
        origin_id: stableId("li_connection", [
          row.URL,
          fullName,
          row["Connected On"],
        ]),
        origin_type: "connection",
        occurred_at: occurredAt,
        payload_text: `Connected with ${fullName}${row.Company ? ` at ${row.Company}` : ""}`,
        author_name: fullName,
        source_url: row.URL,
        metadata: {
          platform: "linkedin",
          first_name: row["First Name"],
          last_name: row["Last Name"],
          email: row["Email Address"],
          company: row.Company,
          position: row.Position,
          linkedin_url: row.URL,
          // Canonicalize at the source as well as through the server's shared
          // LinkedIn identity normalizer so CSV and live URLs match.
          linkedin_slug: normalizeLinkedInSlug(row.URL) ?? undefined,
        },
      },
    ];
  });
}

export function readInvitations(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Invitations.csv").flatMap((row) => {
    const occurredAt = parseLinkedInDate(
      row["Sent At"] || row["Received At"] || row.Date
    );
    const name =
      row.To ||
      row.From ||
      row.Name ||
      row["Invitee Name"] ||
      row["Inviter Name"];
    if (!occurredAt || !name) return [];
    return [
      {
        origin_id: stableId("li_invitation", [
          name,
          row["Sent At"],
          row["Received At"],
          row.Message,
        ]),
        origin_type: "invitation",
        occurred_at: occurredAt,
        payload_text: row.Message || `LinkedIn invitation: ${name}`,
        author_name: row.From,
        metadata: {
          platform: "linkedin",
          from: row.From,
          to: row.To,
          name,
          sent_at: row["Sent At"],
          received_at: row["Received At"],
          message: row.Message,
          invitation_type: row["Invitation Type"],
        },
      },
    ];
  });
}

export function readJobs(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Jobs/Online Job Postings.csv").flatMap((row) => {
    const occurredAt =
      parseLinkedInDate(
        row["Create Date"] || row["List Date"] || row["Close Date"]
      ) ?? snapshotDate();
    const title = row.Title || row["Job Title"] || row.Position;
    const company = row["Company Name"] || row.Company;
    const sourceUrl = row["Company Apply Url"] || row.URL;
    if (!title) return [];
    return [
      {
        origin_id: stableId("li_job", [
          title,
          company,
          row["Create Date"],
          sourceUrl,
        ]),
        origin_type: "job_posting",
        occurred_at: occurredAt,
        payload_text: [
          title,
          company,
          row["Location Description"],
          stripHtml(row["Job Description"] ?? ""),
        ]
          .filter(Boolean)
          .join("\n"),
        title,
        source_url: sourceUrl,
        metadata: {
          platform: "linkedin",
          title,
          company,
          employment_status: row["Employment Status"],
          location: row["Location Description"],
          job_functions: row["Job Functions"],
          industries: row["Company Industries"],
          seniority: row["Seniority Level"],
          required_skills: row["Required Skills"],
          education_levels: row["Education Levels"],
          onsite_apply: row["Onsite Apply"],
          contact_email: row["Contact Email"],
          base_salary: row["Base Salary"],
          additional_compensation: row["Additional Compensation"],
          job_state: row["Job State"],
          create_date: row["Create Date"],
          list_date: row["List Date"],
          close_date: row["Close Date"],
          expiration_date: row["Expiration Date"],
          url: sourceUrl,
        },
      },
    ];
  });
}

export function readProfile(readCsv: TakeoutCsvReader): EventEnvelope[] {
  const profile = readCsv("Profile.csv")[0];
  const profileEvents: EventEnvelope[] = profile
    ? [
        {
          origin_id: stableId("li_profile", [
            profile["First Name"],
            profile["Last Name"],
            profile.Headline,
            profile["Geo Location"],
          ]),
          origin_type: "profile",
          occurred_at: snapshotDate(),
          payload_text: [
            [profile["First Name"], profile["Last Name"]]
              .filter(Boolean)
              .join(" "),
            profile.Headline,
            profile.Summary,
            profile.Industry,
            profile["Geo Location"],
          ]
            .filter(Boolean)
            .join("\n"),
          title: profile.Headline,
          metadata: {
            platform: "linkedin",
            first_name: profile["First Name"],
            last_name: profile["Last Name"],
            headline: profile.Headline,
            summary: profile.Summary,
            industry: profile.Industry,
            location: profile["Geo Location"],
            websites: profile.Websites,
            twitter_handles: profile["Twitter Handles"],
          },
        },
      ]
    : [];

  const positions = readCsv("Positions.csv").flatMap((row) => {
    const title = row.Title;
    const company = row["Company Name"];
    if (!title && !company) return [];
    return [
      {
        origin_id: stableId("li_position", [
          company,
          title,
          row["Started On"],
          row["Finished On"],
        ]),
        origin_type: "position",
        occurred_at: parseLinkedInDate(row["Started On"]) ?? snapshotDate(),
        payload_text: [title, company, row.Location, row.Description]
          .filter(Boolean)
          .join("\n"),
        title: [title, company].filter(Boolean).join(" at "),
        metadata: {
          platform: "linkedin",
          company,
          title,
          description: row.Description,
          location: row.Location,
          started_on: row["Started On"],
          finished_on: row["Finished On"],
        },
      },
    ];
  });

  const education = readCsv("Education.csv").flatMap((row) => {
    const school = row["School Name"];
    if (!school) return [];
    return [
      {
        origin_id: stableId("li_education", [
          school,
          row["Degree Name"],
          row["Start Date"],
          row["End Date"],
        ]),
        origin_type: "education",
        occurred_at: parseLinkedInDate(row["Start Date"]) ?? snapshotDate(),
        payload_text: [school, row["Degree Name"], row.Activities, row.Notes]
          .filter(Boolean)
          .join("\n"),
        title: [row["Degree Name"], school].filter(Boolean).join(" - "),
        metadata: {
          platform: "linkedin",
          school,
          degree: row["Degree Name"],
          start_date: row["Start Date"],
          end_date: row["End Date"],
          activities: row.Activities,
          notes: row.Notes,
        },
      },
    ];
  });

  const skills = readCsv("Skills.csv").flatMap((row) => {
    if (!row.Name) return [];
    return [
      {
        origin_id: stableId("li_skill", [row.Name]),
        origin_type: "skill",
        occurred_at: snapshotDate(),
        payload_text: row.Name,
        title: row.Name,
        metadata: { platform: "linkedin", skill: row.Name },
      },
    ];
  });

  return [...profileEvents, ...positions, ...education, ...skills];
}

export function readCompanyFollows(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Company Follows.csv").flatMap((row) => {
    const organization = row.Organization;
    const occurredAt = parseLinkedInDate(row["Followed On"]);
    if (!organization || !occurredAt) return [];
    return [
      {
        origin_id: stableId("li_company_follow", [
          organization,
          row["Followed On"],
        ]),
        origin_type: "company_follow",
        occurred_at: occurredAt,
        payload_text: `Followed ${organization}`,
        title: organization,
        metadata: {
          platform: "linkedin",
          organization,
          followed_on: row["Followed On"],
        },
      },
    ];
  });
}

export function readLearning(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Learning.csv").flatMap((row) => {
    const title = row["Content Title"];
    if (!title) return [];
    const occurredAt =
      parseLinkedInDate(row["Content Completed At (if completed)"]) ??
      parseLinkedInDate(row["Content Last Watched Date (if viewed)"]) ??
      snapshotDate();
    return [
      {
        origin_id: stableId("li_learning", [
          title,
          row["Content Last Watched Date (if viewed)"],
          row["Content Completed At (if completed)"],
        ]),
        origin_type: "learning",
        occurred_at: occurredAt,
        payload_text: [
          title,
          row["Content Description"],
          row["Notes taken on videos (if taken)"],
        ]
          .filter(Boolean)
          .join("\n"),
        title,
        metadata: {
          platform: "linkedin",
          content_type: row["Content Type"],
          last_watched_at: row["Content Last Watched Date (if viewed)"],
          completed_at: row["Content Completed At (if completed)"],
          saved: row["Content Saved"],
        },
      },
    ];
  });
}

export function readEvents(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Events.csv").flatMap((row) => {
    const name = row["Event Name"];
    if (!name) return [];
    return [
      {
        origin_id: stableId("li_event", [name, row["Event Time"]]),
        origin_type: "event",
        occurred_at:
          parseLinkedInDateStart(row["Event Time"]) ?? snapshotDate(),
        payload_text: [name, row.Status, row["External Url"]]
          .filter(Boolean)
          .join("\n"),
        title: name,
        source_url: row["External Url"],
        metadata: {
          platform: "linkedin",
          event_time: row["Event Time"],
          status: row.Status,
          external_url: row["External Url"],
        },
      },
    ];
  });
}

export function readEndorsements(readCsv: TakeoutCsvReader): EventEnvelope[] {
  const given = readCsv("Endorsement_Given_Info.csv").flatMap((row) =>
    endorsementEvent({
      row,
      direction: "given",
      person: [row["Endorsee First Name"], row["Endorsee Last Name"]]
        .filter(Boolean)
        .join(" "),
      url: row["Endorsee Public Url"],
    })
  );
  const received = readCsv("Endorsement_Received_Info.csv").flatMap((row) =>
    endorsementEvent({
      row,
      direction: "received",
      person: [row["Endorser First Name"], row["Endorser Last Name"]]
        .filter(Boolean)
        .join(" "),
      url: row["Endorser Public Url"],
    })
  );
  const recommendations = readCsv("Recommendations_Given.csv").flatMap(
    (row) => {
      const person = [row["First Name"], row["Last Name"]]
        .filter(Boolean)
        .join(" ");
      const occurredAt = parseLinkedInDate(row["Creation Date"]);
      if (!person || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_recommendation_given", [
            person,
            row.Company,
            row["Creation Date"],
            row.Text,
          ]),
          origin_type: "recommendation_given",
          occurred_at: occurredAt,
          payload_text: row.Text,
          author_name: person,
          title: `Recommendation for ${person}`,
          metadata: {
            platform: "linkedin",
            person,
            company: row.Company,
            job_title: row["Job Title"],
            status: row.Status,
            creation_date: row["Creation Date"],
          },
        },
      ];
    }
  );
  return [...given, ...received, ...recommendations];
}

function endorsementEvent(params: {
  row: Record<string, string>;
  direction: "given" | "received";
  person: string;
  url?: string;
}): EventEnvelope[] {
  const occurredAt = parseLinkedInDate(params.row["Endorsement Date"]);
  if (!params.person || !occurredAt) return [];
  return [
    {
      origin_id: stableId(`li_endorsement_${params.direction}`, [
        params.person,
        params.row["Skill Name"],
        params.row["Endorsement Date"],
      ]),
      origin_type: `endorsement_${params.direction}`,
      occurred_at: occurredAt,
      payload_text: `${params.direction} endorsement: ${params.row["Skill Name"]} - ${params.person}`,
      author_name: params.person,
      source_url: params.url?.startsWith("http")
        ? params.url
        : params.url
          ? `https://${params.url}`
          : undefined,
      metadata: {
        platform: "linkedin",
        direction: params.direction,
        person: params.person,
        skill: params.row["Skill Name"],
        status: params.row["Endorsement Status"],
        endorsement_date: params.row["Endorsement Date"],
      },
    },
  ];
}

export function readRichMedia(readCsv: TakeoutCsvReader): EventEnvelope[] {
  return readCsv("Rich_Media.csv").flatMap((row) => {
    const occurredAt = parseLinkedInMediaDate(row["Date/Time"]);
    if (!row["Media Link"]) return [];
    return [
      {
        origin_id: stableId("li_rich_media", [
          row["Date/Time"],
          row["Media Link"],
        ]),
        origin_type: "media",
        occurred_at: occurredAt ?? snapshotDate(),
        payload_text: [row["Date/Time"], row["Media Description"]]
          .filter(Boolean)
          .join("\n"),
        title: row["Media Description"],
        source_url: row["Media Link"],
        metadata: {
          platform: "linkedin",
          date_time: row["Date/Time"],
          media_description: row["Media Description"],
          media_link: row["Media Link"],
        },
      },
    ];
  });
}

// ── Date parsing ───────────────────────────────────────────────

function parseLinkedInDate(input?: string): Date | undefined {
  if (!input || input === "N/A") return undefined;
  const normalized = input.endsWith(" UTC")
    ? input.replace(" UTC", "Z")
    : input;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLinkedInDateStart(input?: string): Date | undefined {
  return parseLinkedInDate(input?.split(" - ")[0]);
}

function parseLinkedInMediaDate(input?: string): Date | undefined {
  if (!input) return undefined;
  const match = input.match(
    /on ([A-Z][a-z]+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [AP]M)/
  );
  return parseLinkedInDate(match ? `${match[1]} ${match[2]}` : input);
}

/**
 * Fallback timestamp for takeout rows that carry no usable date. Deliberately
 * NOT `new Date()`: a wall-clock value would move every run, so the composite
 * watermark would re-emit the same row forever.
 */
function snapshotDate(): Date {
  return new Date("1970-01-02T00:00:00.000Z");
}
