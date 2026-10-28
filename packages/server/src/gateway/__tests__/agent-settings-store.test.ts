import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { DeclaredAgentRegistry } from "../services/declared-agent-registry.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-settings";

describe("AgentSettingsStore", () => {
  let store: AgentSettingsStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    store = new AgentSettingsStore(createPostgresAgentConfigStore());
  });

  function withOrg<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run({ organizationId: ORG_ID }, fn);
  }

  describe("organization scoping", () => {
    test("getSettings uses explicit organization context when agent ids collide", async () => {
      const otherOrg = `${ORG_ID}-other`;
      await orgContext.run({ organizationId: ORG_ID }, async () => {
        await seedAgentRow("shared-agent", { organizationId: ORG_ID });
        await store.saveSettings("shared-agent", {
          models: ["openai/gpt-4o-mini"],
        });
      });
      await orgContext.run({ organizationId: otherOrg }, async () => {
        await seedAgentRow("shared-agent", { organizationId: otherOrg });
        await store.saveSettings("shared-agent", {
          models: ["z-ai/glm-5.2"],
        });
      });

      const settings = await store.getSettings("shared-agent", {
        organizationId: ORG_ID,
      });

      expect(settings?.models).toEqual(["openai/gpt-4o-mini"]);
    });

    test("R7 #2 COLLISION: a declared id must NOT shadow a real tenant DB row (DB wins, isDeclaredAgentScoped=false)", async () => {
      // A declared (SDK-embedded) agent and a tenant DB agent share the id
      // "shared-agent". The declared settings are org-agnostic; a tenant's
      // org-scoped read must return the DB row, NOT the declared identity.
      await orgContext.run({ organizationId: ORG_ID }, async () => {
        await seedAgentRow("shared-agent", { organizationId: ORG_ID });
        await store.saveSettings("shared-agent", {
          models: ["tenant/db-model"],
          identityMd: "TENANT DB IDENTITY",
        });
      });

      const declared = new DeclaredAgentRegistry();
      declared.replaceAll(
        new Map([
          [
            "shared-agent",
            {
              settings: {
                models: ["declared/model"],
                identityMd: "DECLARED IDENTITY",
              } as never,
              credentials: [],
            },
          ],
        ])
      );
      store.setDeclaredAgents(declared);

      // Org-scoped read of the tenant's agent returns the DB row (DB wins).
      const scoped = await store.getSettings("shared-agent", {
        organizationId: ORG_ID,
      });
      expect(scoped?.models).toEqual(["tenant/db-model"]);
      expect(scoped?.identityMd).toBe("TENANT DB IDENTITY");

      // …and the collision does NOT flip the orgless guard open for that org.
      expect(
        await store.isDeclaredAgentScoped("shared-agent", ORG_ID)
      ).toBe(false);

      // An org with NO DB row falls back to the declared overlay (legitimate).
      const otherOrg = `${ORG_ID}-nodbrow`;
      const declaredView = await store.getSettings("shared-agent", {
        organizationId: otherOrg,
      });
      expect(declaredView?.models).toEqual(["declared/model"]);
      expect(
        await store.isDeclaredAgentScoped("shared-agent", otherOrg)
      ).toBe(true);

      // Orgless read is org-agnostic → declared overlay applies.
      expect(await store.isDeclaredAgentScoped("shared-agent", undefined)).toBe(
        true
      );
    });
  });

  describe("partial update merging", () => {
    test("merges new fields with existing", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", {
          models: ["claude/claude-sonnet-4"],
          soulMd: "Original",
        });
        await store.updateSettings("agent-1", { userMd: "New field" });
        const result = await store.getSettings("agent-1");
        expect(result!.models).toEqual(["claude/claude-sonnet-4"]);
        expect(result!.soulMd).toBe("Original");
        expect(result!.userMd).toBe("New field");
      });
    });
  });

});
