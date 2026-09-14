import {
  connectorFromFile,
  defineAgent,
  defineAutomation,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineSkill,
  every,
  secret,
  field,
  Type,
} from "@lobu/cli/config";
import type ExaNewsFeedConnector from "./exa-news-feed.connector.ts";

const founderActivityTrackerSkill = defineSkill({
  name: "founder-activity-tracker",
  content:
    'Track high-signal public activity from people connected to organizations through `founded_by`. Return notable findings in `signals` as observation event drafts. Put the readable finding in `content`; put `{ kind: "founder_activity", person, activity_type, importance: "high" }` in `metadata`, and use `parent_event_id` when a source post supports the finding. Return an empty array when there is no notable activity.\n',
});

const opportunityMatcherSkill = defineSkill({
  name: "opportunity-matcher",
  content:
    "Monitor public activity from founders and organizations, identify specific collaboration or introduction opportunities, explain the overlap, and recommend a concrete next action. Only return high-signal matches grounded in current source events.\n",
});

const marketIntelligence = defineAgent({
  id: "vc-tracking",
  skills: [founderActivityTrackerSkill, opportunityMatcherSkill],
  name: "vc-tracking",
  description:
    "Track organizations, people, products, funding events, and market signals",
  dir: ".",
  providers: [
    {
      id: "claude",
      model: "claude-sonnet-5",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
  network: {
    allowed: [
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "registry.npmjs.org",
      ".npmjs.org",
    ],
  },
});

// The database slug remains `company` for compatibility. Publicly this is the
// canonical Organization type: operating companies, investment firms,
// accelerators, venture funds, nonprofits, and other institutions.
const organization = defineEntityType({
  key: "company",
  name: "Organization",
  description:
    "Canonical public identity for an organization. Roles are represented by organization_type and relationships, not separate entity types.",
  properties: {
    organization_type: field("Organization Type", {
      enum: [
        "operating_company",
        "investment_firm",
        "accelerator",
        "venture_fund",
        "nonprofit",
        "government",
        "other",
      ],
      optional: true,
    }),
    domain: field("Domain", {
      description: "Normalized public domain",
      "x-identity-namespace": {
        namespace: "hosted_domain",
        normalize: "lowercase",
      },
      optional: true,
    }),
    link: Type.Optional(Type.Unsafe({ type: "string", format: "uri" })),
    one_liner: Type.Optional(Type.Unsafe({ type: "string" })),
    description: Type.Optional(Type.Unsafe({ type: "string" })),
    categories: Type.Optional(
      Type.Unsafe({ type: "array", items: { type: "string" } })
    ),
    location: Type.Optional(Type.Unsafe({ type: "string" })),
    stage: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: [
          "idea",
          "pre-seed",
          "seed",
          "series-a",
          "series-b",
          "series-c",
          "growth",
          "public",
        ],
      })
    ),
    operating_status: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["active", "acquired", "inactive", "closed"],
      })
    ),
    stage_focus: Type.Optional(
      Type.Unsafe({ type: "array", items: { type: "string" } })
    ),
    sector_focus: Type.Optional(
      Type.Unsafe({ type: "array", items: { type: "string" } })
    ),
    portfolio_url: Type.Optional(
      Type.Unsafe({ type: "string", format: "uri" })
    ),
    canonical_path: Type.Optional(Type.Unsafe({ type: "string" })),
    indexability: Type.Optional(
      Type.Unsafe({ type: "string", enum: ["noindex", "index"] })
    ),
  },
});

const person = defineEntityType({
  key: "person",
  name: "Person",
  description:
    "Canonical public identity for a real-world person. Founder, employee, executive, and investor are relationship roles.",
  properties: {
    full_name: Type.Optional(Type.Unsafe({ type: "string" })),
    headline: Type.Optional(Type.Unsafe({ type: "string" })),
    role: Type.Optional(Type.Unsafe({ type: "string" })),
    specialties: Type.Optional(
      Type.Unsafe({ type: "array", items: { type: "string" } })
    ),
    background: Type.Optional(Type.Unsafe({ type: "string" })),
    linkedin_url: Type.Optional(Type.Unsafe({ type: "string", format: "uri" })),
    twitter_handle: Type.Optional(Type.Unsafe({ type: "string" })),
    canonical_path: Type.Optional(Type.Unsafe({ type: "string" })),
    indexability: Type.Optional(
      Type.Unsafe({ type: "string", enum: ["noindex", "index"] })
    ),
  },
});

const product = defineEntityType({
  key: "product",
  name: "Product",
  description:
    "Distinct product or platform. Pricing plans and commercial offers remain sourced events, not product entities.",
  properties: {
    product_type: Type.Optional(Type.Unsafe({ type: "string" })),
    tagline: Type.Optional(Type.Unsafe({ type: "string" })),
    description: Type.Optional(Type.Unsafe({ type: "string" })),
    link: Type.Optional(Type.Unsafe({ type: "string", format: "uri" })),
    categories: Type.Optional(
      Type.Unsafe({ type: "array", items: { type: "string" } })
    ),
    key_features: Type.Optional(
      Type.Unsafe({ type: "array", items: { type: "string" } })
    ),
    availability: Type.Optional(Type.Unsafe({ type: "string" })),
    canonical_path: Type.Optional(Type.Unsafe({ type: "string" })),
    indexability: Type.Optional(
      Type.Unsafe({ type: "string", enum: ["noindex", "index"] })
    ),
  },
});

const fundingRound = defineEntityType({
  key: "fund-round",
  name: "Funding Round",
  description:
    "Non-indexed materialized projection of an append-only financing event. Participant and lead roles are represented through participated_in relationships.",
  properties: {
    round_type: field("Round Type", {
      enum: [
        "preseed",
        "seed",
        "series_a",
        "series_b",
        "series_c",
        "series_d",
        "growth",
        "ipo",
      ],
      optional: true,
    }),
    amount_usd: Type.Optional(field(Type.Number(), "Amount (USD)")),
    currency: Type.Optional(Type.Unsafe({ type: "string" })),
    announced_at: Type.Optional(
      Type.Unsafe({ type: "string", format: "date-time" })
    ),
    status: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["announced", "closed", "cancelled", "rumoured"],
      })
    ),
    source_urls: Type.Optional(
      Type.Unsafe({
        type: "array",
        items: { type: "string", format: "uri" },
      })
    ),
    projection_kind: Type.Optional(
      Type.Unsafe({ type: "string", enum: ["financing_event"] })
    ),
    projection_status: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["materialized", "superseded", "disputed"],
      })
    ),
    indexability: Type.Optional(
      Type.Unsafe({ type: "string", enum: ["noindex", "index"] })
    ),
  },
});

const jobPosting = defineEntityType({
  key: "job-posting",
  name: "Job Posting",
  description: "Public job posting associated with an organization",
  properties: {
    title: field("Title", { optional: true }),
    company_id: Type.Optional(
      field(
        Type.Integer({
          description: "FK to Market organization",
          "x-link-entity-type": "company",
        }),
        "Organization"
      )
    ),
    posted_by_person_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to canonical public person",
        "x-link-entity-type": "person",
      })
    ),
    posted_by_member_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to authenticated workspace member",
        "x-link-entity-type": "$member",
      })
    ),
    city_id: Type.Optional(
      field(
        Type.Integer({
          description: "FK to local Market city",
          "x-link-entity-type": "city",
        }),
        "City"
      )
    ),
    description: Type.Optional(Type.Unsafe({ type: "string" })),
    status: Type.Optional(
      Type.Unsafe({ type: "string", enum: ["open", "filled", "closed"] })
    ),
    posted_at: Type.Optional(
      Type.Unsafe({ type: "string", format: "date-time" })
    ),
    expires_at: Type.Optional(
      Type.Unsafe({ type: "string", format: "date-time" })
    ),
  },
});

const industry = defineEntityType({
  key: "industry",
  name: "Industry",
  description: "Local reference taxonomy for organizations and products",
  properties: {
    parent_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to parent Market industry",
        "x-link-entity-type": "industry",
      })
    ),
    taxonomy_source: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["NAICS", "BICS", "custom"],
      })
    ),
    code: Type.Optional(Type.Unsafe({ type: "string" })),
    description: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const country = defineEntityType({
  key: "country",
  name: "Country",
  description: "Local reference identity for a sovereign country",
  properties: {
    iso2: Type.Optional(
      Type.Unsafe({ type: "string", minLength: 2, maxLength: 2 })
    ),
    iso3: Type.Optional(
      Type.Unsafe({ type: "string", minLength: 3, maxLength: 3 })
    ),
    currency: Type.Optional(Type.Unsafe({ type: "string" })),
    official_name: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const region = defineEntityType({
  key: "region",
  name: "Region",
  description: "Local reference identity for an administrative region",
  properties: {
    country_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to local Market country",
        "x-link-entity-type": "country",
      })
    ),
    iso_3166_2: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const city = defineEntityType({
  key: "city",
  name: "City",
  description: "Local reference identity for a city, town, or metro area",
  properties: {
    country_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to local Market country",
        "x-link-entity-type": "country",
      })
    ),
    region_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to local Market region",
        "x-link-entity-type": "region",
      })
    ),
    timezone: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const technology = defineEntityType({
  key: "technology",
  name: "Technology",
  description:
    "Local reference identity for a technology, framework, library, or platform",
  properties: {
    category: Type.Optional(Type.Unsafe({ type: "string" })),
    homepage_url: Type.Optional(Type.Unsafe({ type: "string", format: "uri" })),
    open_source: Type.Optional(Type.Unsafe({ type: "boolean" })),
  },
});

const university = defineEntityType({
  key: "university",
  name: "University",
  description: "Local reference identity for a higher-education institution",
  properties: {
    country_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to local Market country",
        "x-link-entity-type": "country",
      })
    ),
    city_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "FK to local Market city",
        "x-link-entity-type": "city",
      })
    ),
    homepage_url: Type.Optional(Type.Unsafe({ type: "string", format: "uri" })),
  },
});

const foundedBy = defineRelationshipType({
  key: "founded_by",
  name: "Founded By",
  description: "An organization was founded by a public person",
  rules: [{ source: "company", target: "person" }],
});

const productOf = defineRelationshipType({
  key: "product_of",
  name: "Product Of",
  description: "A product is made or operated by an organization",
  rules: [{ source: "product", target: "company" }],
});

const roundOf = defineRelationshipType({
  key: "round_of",
  name: "Round Of",
  description:
    "A materialized funding-round projection belongs to an organization",
  rules: [{ source: "fund-round", target: "company" }],
});

const participatedIn = defineRelationshipType({
  key: "participated_in",
  name: "Participated In",
  description:
    "An organization participated in a funding round; metadata.lead identifies a lead or co-lead",
  rules: [{ source: "company", target: "fund-round" }],
});

const partnerAt = defineRelationshipType({
  key: "partner_at",
  name: "Partner At",
  description:
    "A public person is an investment professional at an organization",
  rules: [{ source: "person", target: "company" }],
});

const worksAt = defineRelationshipType({
  key: "works_at",
  name: "Works At",
  description: "A public person currently works at an organization",
  rules: [{ source: "person", target: "company" }],
});

const previouslyAt = defineRelationshipType({
  key: "previously_at",
  name: "Previously At",
  description: "A public person previously worked at an organization",
  rules: [{ source: "person", target: "company" }],
});

const educatedAt = defineRelationshipType({
  key: "educated_at",
  name: "Educated At",
  description: "A public person studied at a university",
  rules: [{ source: "person", target: "university" }],
});

const inIndustry = defineRelationshipType({
  key: "in_industry",
  name: "In Industry",
  description: "An organization or product is classified in an industry",
  rules: [
    { source: "company", target: "industry" },
    { source: "product", target: "industry" },
  ],
});

const focusesOn = defineRelationshipType({
  key: "focuses_on",
  name: "Focuses On",
  description:
    "A public person or organization has a documented focus on an industry",
  rules: [
    { source: "person", target: "industry" },
    { source: "company", target: "industry" },
  ],
});

const headquarteredIn = defineRelationshipType({
  key: "headquartered_in",
  name: "Headquartered In",
  description: "An organization is headquartered in a city",
  rules: [{ source: "company", target: "city" }],
});

const operatesIn = defineRelationshipType({
  key: "operates_in",
  name: "Operates In",
  description: "An organization operates in a country or region",
  rules: [
    { source: "company", target: "country" },
    { source: "company", target: "region" },
  ],
});

const usesTechnology = defineRelationshipType({
  key: "uses_technology",
  name: "Uses Technology",
  description: "An organization or product publicly uses a technology",
  rules: [
    { source: "company", target: "technology" },
    { source: "product", target: "technology" },
  ],
});

const investedIn = defineRelationshipType({
  key: "invested_in",
  name: "Invested In",
  description:
    "A public person or organization invested in another organization",
  rules: [
    { source: "person", target: "company" },
    { source: "company", target: "company" },
  ],
});

const acquiredBy = defineRelationshipType({
  key: "acquired_by",
  name: "Acquired By",
  description: "An organization was acquired by another organization",
  rules: [{ source: "company", target: "company" }],
});

const subsidiaryOf = defineRelationshipType({
  key: "subsidiary_of",
  name: "Subsidiary Of",
  description: "An organization is a subsidiary of another organization",
  rules: [{ source: "company", target: "company" }],
});

const brandOf = defineRelationshipType({
  key: "brand_of",
  name: "Brand Of",
  description: "A brand or organization belongs to a parent organization",
  rules: [{ source: "company", target: "company" }],
});

const integratesWith = defineRelationshipType({
  key: "integrates_with",
  name: "Integrates With",
  description: "A product or organization publicly supports an integration",
});

const competitorOf = defineRelationshipType({
  key: "competitor_of",
  name: "Competitor Of",
  description:
    "Two organizations or products compete in a defined market category",
});

const founderActivityTracker = defineAutomation({
  agent: marketIntelligence,
  slug: "founder-activity-tracker",
  name: "Founder Activity Tracker",
  triggers: [every("0 10 * * *")],
  tags: ["market", "people", "daily"],
  minCooldownSeconds: 600,
  outputs: { signals: { event: "observation" } },
  skills: ["founder-activity-tracker"],
  sources: {
    founder_posts:
      "SELECT id, title, payload_text, author_name, source_url, occurred_at, score, origin_type, connector_key FROM events WHERE connector_key = 'x' AND origin_type IN ('tweet', 'reply') ORDER BY occurred_at DESC LIMIT 300\n",
  },
  reactionsGuidance:
    "Flag meaningful hiring, fundraising, product, strategy, or market-positioning changes for review.\n",
});

const opportunityMatcher = defineAutomation({
  agent: marketIntelligence,
  slug: "opportunity-matcher",
  name: "Opportunity Matcher",
  triggers: [every("0 */12 * * *")],
  tags: ["market", "matching"],
  minCooldownSeconds: 600,
  skills: ["opportunity-matcher"],
  sources: {
    content:
      "SELECT id, title, payload_text, author_name, source_url, occurred_at, score, origin_type, connector_key FROM events WHERE entity_ids && ARRAY(SELECT id FROM entities WHERE entity_type = 'person') ORDER BY occurred_at DESC LIMIT 300\n",
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof ExaNewsFeedConnector>(
      "./exa-news-feed.connector.ts"
    ),
  ],
  org: "market",
  orgName: "Market",
  orgDescription:
    "Public market graph for organizations, people, products, financing events, and sourced signals",
  agents: [marketIntelligence],
  entities: [
    organization,
    person,
    product,
    fundingRound,
    jobPosting,
    industry,
    country,
    region,
    city,
    technology,
    university,
  ],
  relationships: [
    foundedBy,
    productOf,
    roundOf,
    participatedIn,
    partnerAt,
    worksAt,
    previouslyAt,
    educatedAt,
    inIndustry,
    focusesOn,
    headquarteredIn,
    operatesIn,
    usesTechnology,
    investedIn,
    acquiredBy,
    subsidiaryOf,
    brandOf,
    integratesWith,
    competitorOf,
  ],
  automations: [founderActivityTracker, opportunityMatcher],
});
