import { defineEntityType, Type } from "@lobu/cli/config";

/** Production accounts, not contacts inferred from email or workspace members. */
export const productUsers = defineEntityType({
  key: "product-user",
  name: "User",
  description:
    "Lobu production accounts, read live; signup_at is the canonical signup record. Activity shows inferred acquisition and observed first success, with computation time and bounded coverage. Missing milestones mean unknown, not inactivity; this is not a full browsing or tool-call history.",
  backing: {
    connection: "lobu-product-activity-db",
    sql: `SELECT u.id, coalesce(nullif(u.name, ''), 'Unnamed user') AS name,
      u.email, u."emailVerified" AS email_verified, u."createdAt" AS signup_at,
      CASE WHEN split_part(lower(u.email), '@', 2) = 'lobu.ai' THEN 'internal'
        WHEN split_part(lower(u.email), '@', 2) IN ('example.com', 'example.org', 'example.net')
          OR split_part(lower(u.email), '@', 2) LIKE '%.test' THEN 'test'
        ELSE 'external' END AS account_kind
      FROM "user" u WHERE coalesce(u.principal_kind, 'human') = 'human'`,
  },
  properties: {
    id: Type.String({ title: "Account ID", readOnly: true }),
    name: Type.String({
      title: "Name",
      readOnly: true,
      "x-table-column": true,
    }),
    email: Type.String({
      title: "Email",
      readOnly: true,
      "x-table-column": true,
    }),
    email_verified: Type.Boolean({ title: "Email verified", readOnly: true }),
    signup_at: Type.String({
      title: "Signed up",
      format: "date-time",
      readOnly: true,
      "x-table-column": true,
    }),
    account_kind: Type.Unsafe({
      type: "string",
      enum: ["external", "internal", "test"],
      title: "Account kind",
      readOnly: true,
      "x-facet": true,
      "x-table-column": true,
    }),
  },
});
