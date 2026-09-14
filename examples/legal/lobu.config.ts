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
import type DocuSignEnvelopesConnector from "./docusign-envelopes.connector.ts";

const contractReviewTrackerSkill = defineSkill({
  name: "contract-review-tracker",
  content:
    "Review active contracts for approaching deadlines, unsigned agreements, and unresolved risk items. Flag any clauses that still need counsel approval.\n",
});

const legalReview = defineAgent({
  id: "legal-review",
  skills: [contractReviewTrackerSkill],
  name: "legal-review",
  description:
    "Review contracts, summarize risk, and surface missing protections",
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

const clause = defineEntityType({
  key: "clause",
  name: "Clause",
  description:
    "A specific provision or section within a contract that defines terms or obligations",
  properties: {
    clause_type: field("Type", { optional: true }),
    section: field("Section", { optional: true }),
    risk_level: field("Risk Level", { optional: true }),
    language_summary: field("Summary", { optional: true }),
  },
});

const contract = defineEntityType({
  key: "contract",
  name: "Contract",
  description:
    "A legal agreement between parties with defined terms, obligations, and conditions",
  properties: {
    contract_type: field("Type", { optional: true }),
    status: field("Status", { optional: true }),
    effective_date: field("Effective Date", { optional: true }),
    counterparty_name: field("Counterparty", { optional: true }),
    governing_law: field("Governing Law", { column: false, optional: true }),
  },
});

const counterparty = defineEntityType({
  key: "counterparty",
  name: "Counterparty",
  description: "An external party involved in a contract or legal agreement",
  properties: {
    organization_name: field("Organization", { optional: true }),
    jurisdiction: field("Jurisdiction", { optional: true }),
    contact_person: field("Contact", { optional: true }),
    relationship_status: field("Status", { optional: true }),
  },
});

const risk = defineEntityType({
  key: "risk",
  name: "Risk",
  description:
    "A legal risk identified in a contract or clause that requires attention or mitigation",
  properties: {
    severity: field("Severity", { optional: true }),
    category: field("Category", { optional: true }),
    mitigation: field("Mitigation", { optional: true }),
    source_clause: field("Source Clause", { optional: true }),
  },
});

const belongsToCounterparty = defineRelationshipType({
  key: "belongs-to-counterparty",
  name: "Belongs to Counterparty",
  description:
    "Tie agreements and negotiation context back to the right external party.",
});

const containsClause = defineRelationshipType({
  key: "contains-clause",
  name: "Contains Clause",
  description:
    "Represent how a contract is composed so risky language stays attached to the right section.",
});

const createsRisk = defineRelationshipType({
  key: "creates-risk",
  name: "Creates Risk",
  description: "Keep legal risk linked to the clause or term that caused it.",
});

const contractReviewTracker = defineAutomation({
  agent: legalReview,
  slug: "contract-review-tracker",
  name: "Contract review tracker",
  triggers: [every("0 8 * * 1-5")],
  tags: ["legal", "contract", "daily"],
  minCooldownSeconds: 1800,
  reactionsGuidance:
    "For any contract with `status: needs_counsel`, route an entity-scoped event\nto the assigned reviewer. For contracts >90 days unsigned, escalate to the\ncounterparty owner; never auto-resolve risk items.\n",
  skills: ["contract-review-tracker"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof DocuSignEnvelopesConnector>(
      "./docusign-envelopes.connector.ts"
    ),
  ],
  org: "legal-review",
  orgName: "Legal",
  orgDescription:
    "Review contracts, summarize risk, and surface missing protections",
  agents: [legalReview],
  entities: [clause, contract, counterparty, risk],
  relationships: [belongsToCounterparty, containsClause, createsRisk],
  automations: [contractReviewTracker],
});
