import { SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
import { decodeJwtClaims } from "../../auth/jwt-claims.js";
import { getDb, type DbClient } from "../../db/client.js";

/**
 * Resolve all of the signed-in user's Slack identities as team/user pairs.
 * Both sources are OAuth-backed: the entity graph (stamped on sign-in and by
 * the install claim) and the Better Auth account row. The provider guard
 * consumes these pairs before org selection, exact-team scopes ordinary
 * workspace claims, and separately restricts bare-user matches to Grid.
 */
export async function resolveClaimingUserSlackIdentities(
  userId: string,
  sql: DbClient = getDb(),
): Promise<Array<{ teamId: string; slackUserId: string }>> {
  const rows = (await sql`
    SELECT DISTINCT ei.identifier
    FROM "member" m
    JOIN entity_identities auth_ei
      ON auth_ei.organization_id = m."organizationId"
     AND auth_ei.namespace = 'auth_user_id'
     AND auth_ei.identifier = m."userId"
     AND auth_ei.scope_key IS NULL
     AND auth_ei.source_connector = 'auth:signup'
     AND auth_ei.deleted_at IS NULL
    JOIN entity_identities ei
      ON ei.organization_id = auth_ei.organization_id
     AND ei.entity_id = auth_ei.entity_id
     AND ei.namespace = ${SLACK_IDENTITY.USER_ID}
     AND ei.scope_key IS NULL
     AND ei.deleted_at IS NULL
    WHERE m."userId" = ${userId}
  `) as Array<{ identifier: string }>;
  const fromGraph = rows
    .map((r) => String(r.identifier))
    .map((id) => {
      const sep = id.indexOf(":");
      return sep === -1
        ? null
        : { teamId: id.slice(0, sep), slackUserId: id.slice(sep + 1) };
    })
    .filter((x): x is { teamId: string; slackUserId: string } => x !== null);

  const accountRows = (await sql`
    SELECT "accountId", "idToken"
    FROM account
    WHERE "providerId" = 'slack' AND "userId" = ${userId}
  `) as Array<{ accountId: string | null; idToken: string | null }>;
  const fromAccounts = accountRows
    .map((a) => {
      const slackUserId = a.accountId?.toUpperCase();
      if (!slackUserId) return null;
      const teamId = a.idToken
        ? ((decodeJwtClaims(a.idToken)?.["https://slack.com/team_id"] as
            | string
            | undefined) ?? "")
        : "";
      return { teamId: teamId.toUpperCase(), slackUserId };
    })
    .filter((x): x is { teamId: string; slackUserId: string } => x !== null);

  // `fromGraph` above IS the third source that used to be read from
  // `chat_user_identities`: sign-in stamps the same workspace-scoped
  // `TEAM:USER` key onto the user's `$member`, so reading the table as well
  // only ever returned rows the graph already had. `fromAccounts` still covers
  // the account-without-a-graph-stamp case.
  const seen = new Set<string>();
  return [...fromGraph, ...fromAccounts].filter((x) => {
    const key = `${x.teamId}:${x.slackUserId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
