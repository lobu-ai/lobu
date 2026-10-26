import { expect, test } from "bun:test";
import config from "../lobu.config";

test("installed CLI compiler preserves identity relationship purpose", async () => {
  // Exercise the package installed by this copyable example, not repo source.
  const { mapProjectToDesiredState } = await import(
    new URL(
      "dist/commands/_lib/apply/map-config.js",
      import.meta.resolve("@lobu/cli/package.json")
    ).href
  );
  const previous = process.env.LOBU_ORG;
  process.env.LOBU_ORG = "synthetic-workspace";
  try {
    const { default: identity } = await import("../identity/lobu.config.ts");
    const desired = mapProjectToDesiredState(identity);
    const relationships: { slug: string; purpose?: string }[] =
      desired.memorySchema.relationshipTypes;
    expect(
      relationships.find((type) => type.slug === "same_source_account")?.purpose
    ).toBe("identity");
    expect(
      relationships.find((type) => type.slug === "same_person")?.purpose
    ).toBe("identity");
    expect(
      relationships.find((type) => type.slug === "matches_contact_field")
        ?.purpose
    ).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.LOBU_ORG;
    else process.env.LOBU_ORG = previous;
  }
});

test("standalone identity recipe has no personal workspace, devices or execution defaults", async () => {
  const previous = process.env.LOBU_ORG;
  process.env.LOBU_ORG = "synthetic-workspace";
  try {
    const { default: identity } = await import("../identity/lobu.config.ts");
    expect(identity.org).toBe("synthetic-workspace");
    expect(identity.prune).toBe(false);
    expect(identity.agents).toEqual([]);
    expect(identity.connections).toBeUndefined();
    expect(identity.automations).toBeUndefined();
    expect(JSON.stringify(identity)).not.toMatch(
      /\/Users\/|deviceWorkerId|authProfile/
    );
  } finally {
    if (previous === undefined) delete process.env.LOBU_ORG;
    else process.env.LOBU_ORG = previous;
  }
});

test("applying personal config preserves independently managed identity and capture definitions", () => {
  expect(config.prune).toBe(false);
  const contact = config.entities?.find(
    (type) => type.key === "contact-identity"
  );
  expect(contact).toBeDefined();
  expect(contact?.resolutionPolicy?.rules).toEqual([
    {
      fields: ["provider", "account_scope", "canonical_source_account_key"],
      normalizer: "exact",
      onMatch: "auto_link",
    },
  ]);
  expect(
    config.relationships?.find((type) => type.key === "same_source_account")
      ?.purpose
  ).toBe("identity");
  expect(
    config.relationships?.find((type) => type.key === "matches_contact_field")
      ?.purpose
  ).toBeUndefined();
  expect(
    config.relationships?.find((type) => type.key === "same_person")?.purpose
  ).toBe("identity");
});
