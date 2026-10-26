import { defineConfig } from "@lobu/cli/config";
import { contactIdentity, identityRelationships } from "../identity.schema.ts";
import { person } from "../person.schema.ts";

const org = process.env.LOBU_ORG;
if (!org)
  throw new Error(
    "Set LOBU_ORG to the explicitly selected workspace before applying this identity recipe"
  );

// Data definitions only: no credentials, connections, schedules or agent runs.
// Always preview the diff when adopting a workspace with custom person fields.
export default defineConfig({
  org,
  agents: [],
  prune: false,
  entities: [person, contactIdentity],
  relationships: identityRelationships,
});
