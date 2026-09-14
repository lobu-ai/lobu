import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineSkill,
  defineEntityType,
  defineRelationshipType,
  defineAutomation,
  every,
  secret,
  field,
} from "@lobu/cli/config";
import type DiscoursePostsConnector from "./discourse-posts.connector.ts";

const opportunityMatcherSkill = defineSkill({
  name: "opportunity-matcher",
  content:
    'Monitor connected profiles, newsletters, websites, and member updates for new launches, posts, hiring signals, funding news, and project changes. Return each strong match in `signals` as a standard observation event draft: `content` explains the match and `metadata` contains `{ kind: "community_match", member_a, member_b, confidence }`. Return an empty array when there is no specific match.\n',
});

const agentCommunity = defineAgent({
  id: "agent-community",
  skills: [opportunityMatcherSkill],
  name: "agent-community",
  description:
    "Discover aligned members, explain why they should meet, and draft warm introductions",
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

const match = defineEntityType({
  key: "match",
  name: "Match",
  description:
    "A suggested introduction between two members with reasons and confidence",
  properties: {
    member_a: field("Member A", { optional: true }),
    member_b: field("Member B", { optional: true }),
    reason: field("Reason", { optional: true }),
    status: field("Status", { optional: true }),
  },
});

const post = defineEntityType({
  key: "post",
  name: "Post",
  description:
    "A blog post, newsletter, or public writing by a community member",
  properties: {
    title: field("Title", { optional: true }),
    source: field("Source", { optional: true }),
    author: field("Author", { optional: true }),
    topics: field("Topics", { optional: true }),
  },
});

const topic = defineEntityType({
  key: "topic",
  name: "Topic",
  description:
    "A durable interest or subject area used for member matching and discovery",
  properties: {
    topic_name: field("Topic", { optional: true }),
    evidence: field("Evidence", { optional: true }),
    member_count: field("Members", { optional: true }),
    relevance: field("Relevance", { column: false, optional: true }),
  },
});

const interestedIn = defineRelationshipType({
  key: "interested-in",
  name: "Interested In",
  description:
    "Store durable interests and goals that can be reused across matching and introductions.",
});

const introducedTo = defineRelationshipType({
  key: "introduced-to",
  name: "Introduced To",
  description:
    "Track completed introductions so the system avoids duplicate outreach and preserves relationship history.",
});

const matchesWith = defineRelationshipType({
  key: "matches-with",
  name: "Matches With",
  description:
    "Represent suggested introductions with reasons and confidence so outreach history is auditable.",
});

const writesAbout = defineRelationshipType({
  key: "writes-about",
  name: "Writes About",
  description:
    "Capture blog posts, newsletters, and public writing so matching includes current thinking, not just static bios.",
});

const opportunityMatcher = defineAutomation({
  agent: agentCommunity,
  slug: "opportunity-matcher",
  name: "Opportunity matcher",
  triggers: [every("0 */12 * * *")],
  tags: ["community", "matching"],
  minCooldownSeconds: 300,
  outputs: { signals: { event: "observation" } },
  skills: ["opportunity-matcher"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof DiscoursePostsConnector>(
      "./discourse-posts.connector.ts"
    ),
  ],
  org: "agent-community",
  orgName: "Agent Community",
  orgDescription:
    "Discover aligned members, explain why they should meet, and draft warm introductions",
  agents: [agentCommunity],
  entities: [match, post, topic],
  relationships: [interestedIn, introducedTo, matchesWith, writesAbout],
  automations: [opportunityMatcher],
});
