import { defineEntityType, defineRelationshipType } from "@lobu/cli/config";

const text = { type: "string" };
const strings = { type: "array", items: text };

// Source observations are not people. These definitions belong to this example,
// not the shared runtime. Automatic grouping requires a structurally proven key.
export const contactIdentity = defineEntityType({
  key: "contact-identity",
  name: "Contact identity",
  description:
    "An account-scoped source identifier. A mailbox, group or handle is not proof of a human identity.",
  resolutionPolicy: {
    rules: [
      {
        fields: ["provider", "account_scope", "canonical_source_account_key"],
        normalizer: "exact",
        onMatch: "auto_link",
      },
    ],
  },
  properties: {
    provider: { ...text, enum: ["gmail", "linkedin", "whatsapp", "x"] },
    namespace: text,
    native_key: text,
    account_scope: text,
    kind: text,
    display_names: strings,
    import_key: { ...text, readOnly: true },
    source_collections: strings,
    certainty: text,
    classification: text,
    provenance_files: strings,
    source_refs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feed_id: { type: "integer" },
          connection_id: { type: "integer" },
          origin_id: text,
          native_id: text,
          observed_at: text,
          collection: text,
        },
        additionalProperties: false,
      },
    },
    first_observed_at: text,
    last_observed_at: text,
    canonical_source_account_key: { ...text, readOnly: true },
    candidate_person_ids: { type: "array", items: { type: "integer" } },
    source_url: text,
  },
});

export const identityRelationships = [
  defineRelationshipType({
    key: "same_source_account",
    name: "Same source account",
    purpose: "identity",
    description:
      "Same provider and account scope, with a structurally proven canonical source key. Never established by a name match.",
    rules: [{ source: contactIdentity, target: contactIdentity }],
  }),
  defineRelationshipType({
    key: "matches_contact_field",
    name: "Matches contact field",
    description:
      "Exact source contact-field evidence, not a verified person merge.",
    rules: [{ source: contactIdentity, target: "person" }],
  }),
  defineRelationshipType({
    key: "same_person",
    name: "Same person",
    purpose: "identity",
    description:
      "A reviewed human identity association. Never created by the deterministic source bootstrap.",
    rules: [{ source: "person", target: "person" }],
  }),
];
