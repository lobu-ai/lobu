import {
  defineEntityType,
  defineRelationshipType,
  field,
  rulesFromFile,
} from "@lobu/cli/config";
import type documentRules from "./legal-document.rules";
import type guidanceRules from "./legal-guidance.rules";
import type requestRules from "./legal-request.rules";

const text = (label: string) => field(label, { optional: true });
const number = (title: string) => ({ type: "integer", title, minimum: 0 });
const date = (title: string) => ({
  type: "string",
  title,
  format: "date-time",
});
const states = (title: string, values: string[]) => ({
  type: "string",
  title,
  enum: values,
});
const ids = (title: string) => ({
  type: "array",
  title,
  items: number("Record ID"),
  maxItems: 30,
});
const preset = (key: string, label: string, field: string, value: string) => ({
  key,
  label,
  selection: { filters: [{ field, op: "eq" as const, value }] },
});

export const counterpartyFields = {
  relationship: text("Relationship"),
  risk_tier: text("Risk tier"),
  notes: text("Relationship history"),
};
export const contractFields = {
  expiry_date: { type: "string", title: "Expiry date", format: "date" },
  auto_renew: { type: "boolean", title: "Auto-renew" },
  notice_days: number("Notice period (days)"),
  counterparty_id: number("Counterparty record"),
  current_document_id: number("Current document"),
};

export const legalEntities = [
  defineEntityType({
    key: "person",
    name: "People",
    properties: {
      role: text("Role"),
      team: text("Team"),
      email: text("Email"),
      expertise: text("Expertise"),
      capacity: number("Open matter capacity"),
    },
    required: [],
    resolutionPolicy: {
      rules: [{ fields: ["email"], normalizer: "email", onMatch: "review" }],
    },
  }),
  defineEntityType({
    key: "legal-team",
    name: "Legal teams",
    properties: { practice: text("Practice"), region: text("Region") },
    required: [],
  }),
  defineEntityType({
    key: "legal-folder",
    name: "Folders",
    properties: { description: text("Description") },
    required: [],
  }),
  defineEntityType({
    key: "knowledge-bank",
    name: "Knowledge Banks",
    properties: {
      topic: text("Topic"),
      owner: text("Owner"),
      description: text("Description"),
    },
    required: [],
  }),
  defineEntityType({
    key: "legal-document",
    name: "Documents",
    properties: {
      version: number("Version"),
      counterparty_id: number("Counterparty"),
      source_event_id: number("Evidence event"),
      available_at: date("Available from"),
      source_url: text("Source URL"),
      contract_id: number("Agreement"),
    },
    required: ["version", "counterparty_id", "source_event_id", "available_at"],
    rules: rulesFromFile<typeof documentRules>("./legal-document.rules.ts"),
    eventKinds: {
      "legal-document-evidence": {
        description:
          "A specific source document revision, with its original attachment or text.",
      },
    },
  }),
  defineEntityType({
    key: "legal-request",
    name: "Legal requests",
    properties: {
      request_id: text("Request ID"),
      matter_type: text("Matter type"),
      summary: text("Request"),
      status: states("Status", [
        "new",
        "triaged",
        "awaiting_decision",
        "approved",
        "negotiating",
        "escalated",
        "blocked",
        "closed",
      ]),
      requester_id: number("Requester"),
      owner_id: number("Counsel"),
      counterparty_id: number("Counterparty"),
      current_document_id: number("Current document"),
      contract_id: number("Agreement"),
      knowledge_bank_id: number("Knowledge Bank"),
      review_event_id: number("Current review"),
      review_document_id: number("Reviewed document"),
      decision_review_id: number("Decision review"),
      decision_document_id: number("Decision document"),
      last_decision_id: number("Decision receipt"),
      decision: text("Decision"),
      instruction: text("Counsel instruction"),
      sla_due_at: date("SLA due"),
      first_touch_at: date("First touch"),
      closed_at: date("Closed"),
      priority: text("Priority"),
      source_url: text("Original request"),
    },
    required: ["request_id", "status"],
    rules: rulesFromFile<typeof requestRules>("./legal-request.rules.ts"),
    collection: {
      table: {
        columns: ["status", "matter_type", "priority", "sla_due_at"],
        sort: { field: "sla_due_at", order: "asc" },
      },
      presets: [
        preset("new", "New", "status", "new"),
        preset(
          "awaiting-decision",
          "Awaiting decision",
          "status",
          "awaiting_decision"
        ),
        preset("approved", "Approved for signature", "status", "approved"),
        preset("blocked", "Needs information", "status", "blocked"),
      ],
    },
    eventKinds: {
      "legal-review": {
        description: "One evidence-bound review of one document revision.",
      },
      "legal-decision": {
        description: "A human response to the exact review displayed.",
      },
    },
  }),
  defineEntityType({
    key: "playbook-position",
    name: "Playbook positions",
    properties: {
      clause: text("Clause"),
      preferred_position: text("Preferred position"),
      fallback_position: text("Fallback"),
      escalate_if: text("Escalate if"),
      rationale: text("Rationale"),
      status: states("Status", ["draft", "approved", "retired"]),
      counterparty_id: number("Counterparty (0 means general)"),
      source_event_ids: ids("Evidence"),
      effective_at: date("Effective from"),
      expires_at: date("Expires"),
    },
    required: ["clause", "status", "effective_at"],
    rules: rulesFromFile<typeof guidanceRules>("./legal-guidance.rules.ts"),
  }),
  defineEntityType({
    key: "legal-guidance",
    name: "Approved Q&A",
    properties: {
      question: text("Question"),
      answer: text("Answer"),
      status: states("Status", ["draft", "approved", "retired"]),
      counterparty_id: number("Counterparty (0 means general)"),
      request_id: text("Original matter"),
      source_event_ids: ids("Evidence"),
      effective_at: date("Effective from"),
      expires_at: date("Expires"),
      decision_id: number("Human decision"),
    },
    required: [
      "question",
      "answer",
      "status",
      "source_event_ids",
      "effective_at",
    ],
    rules: rulesFromFile<typeof guidanceRules>("./legal-guidance.rules.ts"),
    collection: {
      presets: [
        preset("approved", "Approved answers", "status", "approved"),
        preset("draft", "Needs review", "status", "draft"),
      ],
    },
  }),
  defineEntityType({
    key: "legal-suggestion",
    name: "Suggestions",
    properties: {
      kind: states("Kind", ["guidance", "playbook", "renewal", "obligation"]),
      status: states("Status", ["open", "accepted", "dismissed"]),
      summary: text("Suggestion"),
      subject_id: number("Related record"),
      evidence_ids: ids("Evidence"),
    },
    required: ["kind", "status", "summary", "subject_id"],
    collection: { presets: [preset("open", "Open", "status", "open")] },
  }),
  defineEntityType({
    key: "legal-obligation",
    name: "Obligations",
    properties: {
      contract_id: number("Agreement"),
      due_at: date("Due"),
      status: states("Status", ["open", "complete"]),
      owner_id: number("Owner"),
      summary: text("Obligation"),
      source_event_id: number("Evidence"),
    },
    required: ["contract_id", "due_at", "status", "summary"],
  }),
  defineEntityType({
    key: "legal-ops-snapshot",
    name: "Legal operations",
    properties: {
      as_of: date("As of"),
      open_requests: number("Open requests"),
      awaiting_decision: number("Awaiting decision"),
      sla_breaches: number("SLA breaches"),
      approvals: number("Approved for signature"),
      completed: number("Closed"),
      coverage: text("Coverage"),
      decision_cursor: number("Last processed counsel receipt"),
    },
    required: ["as_of", "coverage"],
  }),
];

export const legalRelationships = [
  defineRelationshipType({
    key: "concerns",
    name: "Concerns",
    rules: [{ source: "legal-request", target: "counterparty" }],
  }),
  defineRelationshipType({
    key: "covered-by",
    name: "Covered by",
    rules: [{ source: "legal-request", target: "contract" }],
  }),
  defineRelationshipType({
    key: "requested-by",
    name: "Requested by",
    rules: [{ source: "legal-request", target: "person" }],
  }),
  defineRelationshipType({
    key: "assigned-to",
    name: "Assigned to",
    rules: [{ source: "legal-request", target: "person" }],
  }),
  defineRelationshipType({
    key: "works-with",
    name: "Works with",
    rules: [
      { source: "person", target: "counterparty" },
      { source: "person", target: "legal-team" },
    ],
  }),
  defineRelationshipType({
    key: "document-of",
    name: "Document of",
    rules: [
      { source: "legal-document", target: "contract" },
      { source: "legal-document", target: "counterparty" },
      { source: "legal-document", target: "legal-request" },
    ],
  }),
  defineRelationshipType({
    key: "guided-by",
    name: "Guided by",
    rules: [
      { source: "legal-request", target: "knowledge-bank" },
      { source: "legal-request", target: "legal-guidance" },
      { source: "legal-request", target: "playbook-position" },
    ],
  }),
];
