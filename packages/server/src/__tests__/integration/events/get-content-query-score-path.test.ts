/**
 * Regression coverage for the entity-scoped score branch in
 * `tools/get_content/handler.ts`.
 *
 * With `entity_id` + `sort_by: 'score'` but NO query, results come from the
 * multi-signal score ranking. With a query present they must go through
 * text search instead: the query filters rows. The fixture gives the
 * NON-matching decoy a higher stored score, so routing to the score builder
 * (the old behavior for any `sort_by: 'score'` + `entity_id` call) surfaces
 * the decoy first and inflates the total — a loud failure instead of a
 * silent pass.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getContent } from "../../../tools/get_content";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";

describe("getContent > entity query with sort_by=score searches instead of score-listing", () => {
  let organizationId: string;
  let userId: string;
  let entityId: number;
  let connectionId: number;
  let matchId: number;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();

    const org = await createTestOrganization({ name: "Query Score Org" });
    organizationId = org.id;
    const user = await createTestUser({ email: "query-score@example.com" });
    userId = user.id;
    await addUserToOrganization(userId, organizationId, "owner");

    const entity = await createTestEntity({
      name: "Query Score Entity",
      organization_id: organizationId,
      created_by: userId,
    });
    entityId = entity.id;

    await createTestConnectorDefinition({
      key: "query-score-connector",
      name: "Query Score Connector",
      organization_id: organizationId,
    });
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: "query-score-connector",
      entity_ids: [entityId],
      created_by: userId,
    });
    connectionId = connection.id;

    // The match scores LOW on purpose; the decoy scores HIGH. A score-listing
    // would return the decoy first with total 2.
    matchId = (
      await createTestEvent({
        entity_id: entityId,
        connection_id: connectionId,
        organization_id: organizationId,
        title: "physician rounds summary",
        content: "The physician visited every ward at noon",
      })
    ).id;
    await getTestDb()`UPDATE events SET score = 1 WHERE id = ${matchId}`;
    const decoy = await createTestEvent({
      entity_id: entityId,
      connection_id: connectionId,
      organization_id: organizationId,
      title: "Quarterly budget review",
      content: "Numbers and charts with no medical terms at all",
    });
    await getTestDb()`UPDATE events SET score = 99 WHERE id = ${decoy.id}`;

    ctx = {
      organizationId,
      userId,
      memberRole: "owner",
      isAuthenticated: true,
      tokenType: "oauth",
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ["mcp:read"],
    } as ToolContext;
  });

  it("filters by the query and counts only matches", async () => {
    const result = await getContent(
      { entity_id: entityId, query: "physician", sort_by: "score", limit: 50 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((item) => item.id)).toEqual([matchId]);
    expect(result.total).toBe(1);
  });

  it("keeps the score listing when no query is given", async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: "score", limit: 50 } as never,
      {} as never,
      ctx
    );
    expect(result.total).toBe(2);
    expect(result.content.map((item) => item.id)).toEqual(
      expect.arrayContaining([matchId])
    );
  });
});
