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
import type LinearCyclesConnector from "./linear-cycles.connector.ts";

const boardActionTrackerSkill = defineSkill({
  name: "board-action-tracker",
  content:
    "Track board action items: check task delivery status, blocker resolution progress, and approaching deadlines for the next board packet.\n",
});

const leadership = defineAgent({
  id: "leadership",
  skills: [boardActionTrackerSkill],
  name: "leadership",
  description:
    "Help leadership teams turn memos, decisions, and board materials into reusable operating context",
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

const decision = defineEntityType({
  key: "decision",
  name: "Decision",
  description:
    "A leadership decision extracted from a document with its approval status",
  properties: {
    subject: field("Subject", { optional: true }),
    status: field("Status", { optional: true }),
    source_document: field("Source", { optional: true }),
    decision_date: field("Date", { optional: true }),
  },
});

const document = defineEntityType({
  key: "document",
  name: "Document",
  description:
    "A source document such as a board memo, strategy brief, or executive report",
  properties: {
    document_name: field("Document", { optional: true }),
    document_type: field("Type", { optional: true }),
    date: field("Date", { optional: true }),
    decisions_count: field("Decisions", { optional: true }),
  },
});

const region = defineEntityType({
  key: "region",
  name: "Region",
  description:
    "A geographic region referenced in strategic decisions or expansion plans",
  properties: {
    region_name: field("Region", { optional: true }),
    decision_context: field("Context", { optional: true }),
    status: field("Status", { optional: true }),
    budget_approved: field("Budget", { column: false, optional: true }),
  },
});

const risk = defineEntityType({
  key: "risk",
  name: "Risk",
  description:
    "A blocker or dependency that is holding up a decision or initiative",
  properties: {
    blocker: field("Blocker", { optional: true }),
    affects: field("Affects", { optional: true }),
    state: field("State", { optional: true }),
    owner: field("Owner", { optional: true }),
  },
});

const task = defineEntityType({
  key: "task",
  name: "Task",
  description:
    "An assigned follow-up action extracted from a leadership document or meeting",
  properties: {
    action: field("Action", { optional: true }),
    owner: field("Owner", { optional: true }),
    deadline: field("Deadline", { optional: true }),
    source: field("Source", { optional: true }),
  },
});

const approved = defineRelationshipType({
  key: "approved",
  name: "Approved",
  description:
    "Keep approved decisions queryable without re-reading the whole source memo.",
});

const assigned = defineRelationshipType({
  key: "assigned",
  name: "Assigned",
  description:
    "Turn follow-up work into durable ownership instead of transient notes.",
});

const blockedBy = defineRelationshipType({
  key: "blocked-by",
  name: "Blocked By",
  description:
    "Attach blocked decisions to the dependency that is holding them up.",
});

const boardActionTracker = defineAutomation({
  agent: leadership,
  slug: "board-action-tracker",
  name: "Board action tracker",
  triggers: [every("0 8 * * *")],
  tags: ["leadership", "daily", "board"],
  agentKind: "notifier",
  skills: ["board-action-tracker"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof LinearCyclesConnector>(
      "./linear-cycles.connector.ts"
    ),
  ],
  org: "leadership",
  orgName: "Leadership",
  orgDescription:
    "Turn memos, decisions, and board materials into reusable operating context",
  agents: [leadership],
  entities: [decision, document, region, risk, task],
  relationships: [approved, assigned, blockedBy],
  automations: [boardActionTracker],
});
