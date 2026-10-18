/**
 * Regression coverage for short-query routing in `searchContentByText`.
 *
 * Queries shorter than three characters used to fall through to
 * `listContentInternal`, which ignores the query entirely and returns an
 * unfiltered chronological listing. Short non-empty queries now run the
 * single-query ranker, so text matching (ILIKE/trigram) filters rows and the
 * total counts only matches. These fixtures pair matching rows with decoys
 * that share NEITHER the one-character nor the two-character query, so a
 * regression to list-mode shows up as extra rows AND an inflated total.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { searchContentByText } from "../../../utils/content-search";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";

async function seedOrgFixture(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const org = await createTestOrganization({ name });
  const user = await createTestUser({ email: `${slug}@example.com` });
  await addUserToOrganization(user.id, org.id, "owner");
  const entity = await createTestEntity({
    name: `${name} Entity`,
    organization_id: org.id,
    created_by: user.id,
  });
  await createTestConnectorDefinition({
    key: `${slug}-connector`,
    name: `${name} Connector`,
    organization_id: org.id,
  });
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: `${slug}-connector`,
    entity_ids: [entity.id],
    created_by: user.id,
  });
  return { org, entity, connection, user };
}

describe("searchContentByText > short queries filter instead of listing", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("routes one- and two-character queries to ranked search, excluding non-matches", async () => {
    const { org, entity, connection } = await seedOrgFixture("Short Query Org");
    const bigramMatch = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      organization_id: org.id,
      // No "q" anywhere here: the single-character query below must match
      // exactly one row.
      content: "The zx probe fired at dawn over the calm water",
    });
    const singleMatch = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      organization_id: org.id,
      content: "A quirky brown fox naps at noon",
    });
    // Decoys share neither the "zx" bigram nor any "q": an unfiltered
    // listing would return them all.
    for (const content of [
      "Alpha beta gamma delta epsilon",
      "Plain harbor morning summary",
      "Nothing to note here today",
    ]) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        organization_id: org.id,
        content,
      });
    }

    const bigram = await searchContentByText("zx", {
      organization_id: org.id,
      limit: 50,
    });
    expect(bigram.content.map((item) => item.id)).toEqual([bigramMatch.id]);
    expect(bigram.total).toBe(1);

    const single = await searchContentByText("q", {
      organization_id: org.id,
      limit: 50,
    });
    expect(single.content.map((item) => item.id)).toEqual([singleMatch.id]);
    expect(single.total).toBe(1);
  });

  it("still lists everything when the query is empty or blank", async () => {
    const { org, entity, connection } = await seedOrgFixture("Blank Query Org");
    for (const content of ["First blank-listed row", "Second blank-listed row"]) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        organization_id: org.id,
        content,
      });
    }

    for (const query of [null, "", "   "]) {
      const result = await searchContentByText(query, {
        organization_id: org.id,
        limit: 50,
      });
      expect(result.total).toBe(2);
      expect(result.content).toHaveLength(2);
    }
  });
});
