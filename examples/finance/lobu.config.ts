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
import type QuickBooksTransactionsConnector from "./quickbooks-transactions.connector.ts";

const reconciliationMonitorSkill = defineSkill({
  name: "reconciliation-monitor",
  content:
    'Check accounts for unreconciled transactions, new variances, and approaching reporting deadlines. Return actionable exceptions in `alerts` as standard observation event drafts. Put the readable exception in `content` and counts/details in `metadata` with `kind: "reconciliation_alert"`. Return an empty array when there is nothing to review.\n',
});

const finance = defineAgent({
  id: "finance",
  skills: [reconciliationMonitorSkill],
  name: "finance",
  description:
    "Help finance teams reconcile data, explain variance, and prepare reporting runs",
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

const account = defineEntityType({
  key: "account",
  name: "Account",
  description:
    "A financial account that holds balances, transactions, and reconciliation state",
  properties: {
    account_name: field("Account", { optional: true }),
    account_type: field("Type", { optional: true }),
    balance: field("Balance", { optional: true }),
    reconciliation_status: field("Reconciliation", { optional: true }),
  },
});

const report = defineEntityType({
  key: "report",
  name: "Report",
  description:
    "A financial report or summary generated from account and transaction data",
  properties: {
    report_name: field("Report", { optional: true }),
    period: field("Period", { optional: true }),
    status: field("Status", { optional: true }),
    exceptions_count: field("Exceptions", { optional: true }),
  },
});

const transaction = defineEntityType({
  key: "transaction",
  name: "Transaction",
  description: "A financial transaction that affects account balances",
  properties: {
    description: field("Description", { optional: true }),
    amount: field("Amount", { optional: true }),
    date: field("Date", { optional: true }),
    category: field("Category", { optional: true }),
  },
});

const variance = defineEntityType({
  key: "variance",
  name: "Variance",
  description:
    "A discrepancy or anomaly identified during reconciliation or reporting",
  properties: {
    variance_type: field("Type", { optional: true }),
    amount: field("Amount", { optional: true }),
    source_account: field("Account", { optional: true }),
    explanation: field("Explanation", { optional: true }),
  },
});

const createsVariance = defineRelationshipType({
  key: "creates-variance",
  name: "Creates Variance",
  description:
    "Keep anomalies attached to the source records that produced them.",
});

const reconcilesTo = defineRelationshipType({
  key: "reconciles-to",
  name: "Reconciles To",
  description:
    "Tie transactions and balances back to the accounts they roll into.",
});

const summarizedIn = defineRelationshipType({
  key: "summarized-in",
  name: "Summarized In",
  description:
    "Let agents trace reporting outputs back to the supporting data.",
});

const reconciliationMonitor = defineAutomation({
  agent: finance,
  slug: "reconciliation-monitor",
  name: "Reconciliation monitor",
  triggers: [every("0 6 * * 1-5")],
  tags: ["finance", "reconciliation", "daily"],
  minCooldownSeconds: 3600,
  outputs: { alerts: { event: "observation" } },
  skills: ["reconciliation-monitor"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof QuickBooksTransactionsConnector>(
      "./quickbooks-transactions.connector.ts"
    ),
  ],
  org: "finance",
  orgName: "Finance",
  orgDescription:
    "Help finance teams reconcile data, explain variance, and prepare reporting runs",
  agents: [finance],
  entities: [account, report, transaction, variance],
  relationships: [createsVariance, reconcilesTo, summarizedIn],
  automations: [reconciliationMonitor],
});
