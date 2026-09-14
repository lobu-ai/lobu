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
import type SalesforcePipelineConnector from "./salesforce-pipeline.connector.ts";

const accountHealthMonitorSkill = defineSkill({
  name: "account-health-monitor",
  content:
    'Poll CRM data for tracked accounts. Return only material risk escalations in `health_changes` as standard observation event drafts. Put the readable risk change and supporting signals in `content`; put `{ kind: "health_change", account, from, to }` in `metadata`. Return an empty array when risk did not increase.\n',
});

const sales = defineAgent({
  id: "sales",
  skills: [accountHealthMonitorSkill],
  name: "sales",
  description:
    "Help revenue teams track account health, rollout progress, and renewal signals",
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
  // Packages live on the agent, not on skills — `jq` backs the account-brief
  // skill's news filtering.
  nixPackages: ["jq"],
});

const organization = defineEntityType({
  key: "organization",
  name: "Organization",
  description:
    "A customer account or prospect being tracked by the revenue team",
  properties: {
    company_name: field("Company", { optional: true }),
    stage: field("Stage", { optional: true }),
    arr: field("ARR", { optional: true }),
    renewal_date: field("Renewal Date", { optional: true }),
  },
});

const product = defineEntityType({
  key: "product",
  name: "Product",
  description: "A product rollout or pilot being tracked at a customer account",
  properties: {
    product_name: field("Product", { optional: true }),
    pilot_status: field("Status", { optional: true }),
    owner_team: field("Owner", { optional: true }),
    account: field("Account", { optional: true }),
  },
});

const region = defineEntityType({
  key: "region",
  name: "Region",
  description: "A geographic region where an account is expanding or operating",
  properties: {
    region_name: field("Region", { optional: true }),
    expansion_status: field("Status", { optional: true }),
    parent_account: field("Account", { optional: true }),
    market_size: field("Market Size", { column: false, optional: true }),
  },
});

const renewalRisk = defineEntityType({
  key: "renewal-risk",
  name: "Renewal Risk",
  description:
    "A commercial signal or concern that affects an upcoming renewal or expansion",
  properties: {
    signal: field("Signal", { optional: true }),
    severity: field("Severity", { optional: true }),
    affects: field("Affects", { optional: true }),
    next_step: field("Next Step", { optional: true }),
  },
});

const team = defineEntityType({
  key: "team",
  name: "Team",
  description:
    "An internal team or customer function that owns a pilot or initiative",
  properties: {
    team_name: field("Team", { optional: true }),
    role: field("Role", { optional: true }),
    owns: field("Owns", { optional: true }),
    account: field("Account", { optional: true }),
  },
});

const affects = defineRelationshipType({
  key: "affects",
  name: "Affects",
  description:
    "Connect commercial signals directly to the renewal or expansion they influence.",
});

const expandedInto = defineRelationshipType({
  key: "expanded-into",
  name: "Expanded Into",
  description:
    "Track where an account is growing so territory and rollout context stay explicit.",
});

const runs = defineRelationshipType({
  key: "runs",
  name: "Runs",
  description:
    "Link the internal team or customer function to the pilot they own.",
});

const accountHealthMonitor = defineAutomation({
  agent: sales,
  slug: "account-health-monitor",
  name: "Account health monitor",
  triggers: [every("0 */12 * * *")],
  tags: ["sales", "health", "renewals"],
  minCooldownSeconds: 1800,
  outputs: { health_changes: { event: "observation" } },
  skills: ["account-health-monitor"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof SalesforcePipelineConnector>(
      "./salesforce-pipeline.connector.ts"
    ),
  ],
  org: "sales",
  orgName: "Sales",
  orgDescription:
    "Help revenue teams track account health, rollout progress, and renewal signals",
  agents: [sales],
  entities: [organization, product, region, renewalRisk, team],
  relationships: [affects, expandedInto, runs],
  automations: [accountHealthMonitor],
});
