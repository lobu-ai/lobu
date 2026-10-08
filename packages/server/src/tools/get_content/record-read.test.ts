import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Env } from "../../index";
import type { ToolContext } from "../registry";

const readActivity = vi.fn();
const readLinks = vi.fn();
const evaluatePolicy = vi.fn();
const loadReadRestrictions = vi.fn();
const sql = vi.fn(async () => [{ role: "owner" }]);
const ctx = {
  organizationId: "record-test-org",
  userId: "record-test-user",
  memberRole: "owner",
  isAuthenticated: true,
  scopes: ["mcp:read"],
  baseUrl: "http://localhost",
} as ToolContext;
const record = { type: "account", key: "a1" };
let getContent: typeof import("./handler")["getContent"];
let manageEntity: typeof import("../admin/manage_entity")["manageEntity"];

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../db/client", async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getDb: () => sql,
    createDbClientFromEnv: () => sql,
  }));
  vi.doMock("../../authz/entity-policy", async (original) => ({
    ...(await original<Record<string, unknown>>()),
    resolveActingPrincipal: vi.fn(async () => ({
      kind: "agent",
      id: "record-test-agent",
    })),
    evaluateEntityMutation: evaluatePolicy,
    loadEntityReadRestrictions: loadReadRestrictions,
  }));
  vi.doMock("../../utils/source-record-reads", () => ({
    readSourceRecordActivity: readActivity,
    readSourceRecordLinks: readLinks,
  }));
  ({ getContent } = await import("./handler"));
  ({ manageEntity } = await import("../admin/manage_entity"));
});

beforeEach(() => {
  vi.clearAllMocks();
  evaluatePolicy.mockResolvedValue("auto");
  loadReadRestrictions.mockResolvedValue([]);
  readActivity.mockResolvedValue({ events: [], failures: [] });
  readLinks.mockResolvedValue({ links: [], failures: [], next_cursor: null });
});

afterAll(() => {
  vi.doUnmock("../../db/client");
  vi.doUnmock("../../authz/entity-policy");
  vi.doUnmock("../../utils/source-record-reads");
  vi.resetModules();
});

describe("record read admission", () => {
  it.each([record.type, null])("applies the entity read policy (%s) before contacting a source", async entityType => {
    loadReadRestrictions.mockResolvedValue([{ entity_type_slug: entityType, entity_id: null }]);
    await expect(
      getContent({ record }, {} as Env, {
        ...ctx,
        agentId: "record-test-agent",
      })
    ).rejects.toThrow(/Policy denies reading/);
    expect(loadReadRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ctx.organizationId, principalKind: "agent", principalId: "record-test-agent" })
    );
    expect(readActivity).not.toHaveBeenCalled();
  });

  it("allows a source read when the principal's restrictions concern another entity type", async () => {
    loadReadRestrictions.mockResolvedValue([{ entity_type_slug: "other-record", entity_id: null }]);
    await getContent({ record }, {} as Env, { ...ctx, agentId: "record-test-agent" });
    expect(loadReadRestrictions).toHaveBeenCalledOnce();
    expect(readActivity).toHaveBeenCalledOnce();
  });

  it.each([
    { offset: 10 },
    { min_similarity: 0.9 },
    { sort_order: "asc" as const },
    { include_superseded: true },
    { agent_id: "some-agent" },
    { produced_by_automation_id: 12 },
    { run_ids: [34] },
  ])("rejects a non-default unsupported activity filter: %j", async (filter) => {
    await expect(
      getContent({ record, ...filter }, {} as Env, ctx)
    ).rejects.toThrow(/cannot be combined/);
    expect(readActivity).not.toHaveBeenCalled();
  });

  it("accepts the schema defaults for an activity read", async () => {
    await getContent({ record }, {} as Env, ctx);
    expect(readActivity).toHaveBeenCalledOnce();
  });

  it("preserves the requesting Automation for Activity and relationship source admission", async () => {
    const automationContext = { ...ctx, actingAutomationId: 42 };
    await getContent({ record }, {} as Env, automationContext);
    await manageEntity({ action: "list_links", record }, {} as Env, automationContext);
    for (const read of [readActivity, readLinks]) {
      expect(read).toHaveBeenCalledWith(
        expect.anything(),
        record,
        expect.objectContaining({ automationId: 42 })
      );
    }
  });

  it("passes connector, connection and feed filters to the source read", async () => {
    const filters = { platforms: ["test_source"], connection_ids: [7], feed_ids: [11] };
    await getContent({ record, ...filters }, {} as Env, ctx);
    expect(readActivity).toHaveBeenCalledWith(
      expect.anything(), record, expect.objectContaining(filters)
    );
  });

  it.each([
    { offset: 10 },
    { confidence_min: 0.9 },
    { source: "ui" as const },
    { include_deleted: true },
  ])("rejects an unsupported relationship filter: %j", async (filter) => {
    await expect(
      manageEntity({ action: "list_links", record, ...filter }, {} as Env, ctx)
    ).rejects.toThrow(/cannot be combined/);
    expect(readLinks).not.toHaveBeenCalled();
  });

  it("passes relationship direction and type to the source read", async () => {
    await manageEntity(
      {
        action: "list_links",
        record,
        direction: "outbound",
        relationship_type_slug: "owns",
      },
      {} as Env,
      ctx
    );
    expect(readLinks).toHaveBeenCalledWith(
      expect.anything(),
      record,
      expect.objectContaining({ relationshipType: "owns", direction: "outgoing" })
    );
  });
});
