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
import type ShopifyOrdersConnector from "./shopify-orders.connector.ts";

const phoenixRolloutTrackerSkill = defineSkill({
  name: "phoenix-rollout-tracker",
  content:
    "Check project blockers, milestone progress, and generate the weekly risk summary for leadership.\n",
});

const delivery = defineAgent({
  id: "delivery",
  skills: [phoenixRolloutTrackerSkill],
  name: "delivery",
  description:
    "Help delivery teams keep milestones, blockers, owners, and artifacts aligned",
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

const blocker = defineEntityType({
  key: "blocker",
  name: "Blocker",
  description: "A dependency or issue that is blocking project progress",
  properties: {
    blocker_description: field("Blocker", { optional: true }),
    owned_by: field("Owner", { optional: true }),
    impact: field("Impact", { optional: true }),
    status: field("Status", { optional: true }),
  },
});

const document = defineEntityType({
  key: "document",
  name: "Document",
  description: "A project artifact, review, or reference document",
  properties: {
    document_name: field("Document", { optional: true }),
    document_type: field("Type", { optional: true }),
    linked_project: field("Project", { optional: true }),
    last_updated: field("Updated", { optional: true }),
  },
});

const milestone = defineEntityType({
  key: "milestone",
  name: "Milestone",
  description: "A key deliverable or phase gate within a project",
  properties: {
    milestone_name: field("Milestone", { optional: true }),
    lifecycle_state: field("State", { optional: true }),
    target_date: field("Target Date", { optional: true }),
    parent_project: field("Project", { optional: true }),
  },
});

const stakeholder = defineEntityType({
  key: "stakeholder",
  name: "Stakeholder",
  description: "A person who owns or is responsible for part of a project",
  properties: {
    name: field("Name", { optional: true }),
    role: field("Role", { optional: true }),
    owns: field("Owns", { optional: true }),
    contact: field("Contact", { column: false, optional: true }),
  },
});

const blockedBy = defineRelationshipType({
  key: "blocked-by",
  name: "Blocked By",
  description:
    "Tie blockers directly to the project and milestone they threaten.",
});

const documentedIn = defineRelationshipType({
  key: "documented-in",
  name: "Documented In",
  description:
    "Preserve the source documents and reviews behind key project state.",
});

const ownedBy = defineRelationshipType({
  key: "owned-by",
  name: "Owned By",
  description: "Keep project ownership queryable across updates and artifacts.",
});

const phoenixRolloutTracker = defineAutomation({
  agent: delivery,
  slug: "phoenix-rollout-tracker",
  name: "Phoenix rollout tracker",
  triggers: [every("0 9 * * 1")],
  tags: ["delivery", "weekly", "rollout"],
  minCooldownSeconds: 3600,
  skills: ["phoenix-rollout-tracker"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof ShopifyOrdersConnector>(
      "./shopify-orders.connector.ts"
    ),
  ],
  org: "delivery",
  orgName: "Delivery",
  orgDescription:
    "Help delivery teams keep milestones, blockers, owners, and artifacts aligned",
  agents: [delivery],
  entities: [blocker, document, milestone, stakeholder],
  relationships: [blockedBy, documentedIn, ownedBy],
  automations: [phoenixRolloutTracker],
});
