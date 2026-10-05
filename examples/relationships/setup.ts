/**
 * Relationships onboarding, composed from existing ClientSDK schema methods.
 * Run in the selected workspace with run_sdk. Existing schemas are owned by
 * that workspace: this preset only creates a missing person type, never updates
 * one. A held approval is returned unchanged; onboarding must wait for approval.
 */
export const personSchema = {
  slug: "person",
  name: "Person",
  description: "People linked across connected sources by their identities.",
  icon: "user",
  metadata_schema: {
    type: "object",
    properties: {
      linkedin_url: { type: "string", title: "LinkedIn" },
      company: { type: "string", title: "Company" },
      position: { type: "string", title: "Position" },
      last_linkedin_message_at: { type: "string", format: "date-time" },
      x_handle: { type: "string", title: "X" },
      x_display_name: { type: "string" },
      last_x_interaction_at: { type: "string", format: "date-time" },
      last_x_dm_at: { type: "string", format: "date-time" },
      email: { type: "string" },
      first_name: { type: "string" },
      last_name: { type: "string" },
    },
    "x-lobu-resolution": {
      rules: [
        { fields: ["email"], normalizer: "email", onMatch: "review" },
        { fields: ["emails"], normalizer: "email", onMatch: "review" },
        { fields: ["phone"], normalizer: "phone", onMatch: "review" },
        { fields: ["phones"], normalizer: "phone", onMatch: "review" },
      ],
    },
  },
};

interface RelationshipsClient {
  entitySchema: {
    listTypes(input: { list_scope: "organization" }): Promise<unknown>;
    createType(input: typeof personSchema): Promise<unknown>;
  };
}

export default async function setupRelationships(
  _ctx: unknown,
  client: RelationshipsClient
) {
  const result = (await client.entitySchema.listTypes({
    list_scope: "organization",
  })) as { entity_types: Array<{ slug: string }> };
  const existing = result.entity_types.find((type) => type.slug === "person");
  if (existing) return { status: "already_present", entity_type: existing };
  return client.entitySchema.createType(personSchema);
}
