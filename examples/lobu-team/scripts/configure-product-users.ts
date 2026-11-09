import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { productUsers } from "../product-users";

/** Existing SDK configuration only: no copied accounts or physical DB schema. */
export async function configureProductUsers(
  client: Pick<ClientSDK, "entitySchema">
) {
  const { entity_type: current } = (await client.entitySchema.getType(
    "product-user"
  )) as {
    entity_type: { metadata_schema?: Record<string, unknown> } | null;
  };
  const input = {
    slug: "product-user",
    name: productUsers.name ?? "User",
    description: productUsers.description,
    backing: productUsers.backing,
    // The CLI preserves root schema extensions on subsequent applies. Its
    // property DSL does not author the existing source-record key extension.
    metadata_schema: {
      ...current?.metadata_schema,
      type: "object",
      properties: productUsers.properties,
      "x-lobu-record-key": "id",
    },
  };
  return current
    ? client.entitySchema.updateType(input)
    : client.entitySchema.createType(input);
}
