import { describe, expect, it } from "vitest";
import type { ClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import { compileReactionScript, extractReactionInputSchema } from "../automations/reaction-executor";
import { AUTOMATION_CATALOG_TEMPLATES } from "./automation-templates";

const template = AUTOMATION_CATALOG_TEMPLATES.find((entry) => entry.id === "duplicate-identity");
if (!template) throw new Error("duplicate-identity Automation template is missing");
const reaction = String(template.detail.reaction_script);
const decision = (id: number) => ({ from_entity_id: id, to_entity_id: id + 1, relationship_type_slug: "same_record" });
const component = (id: number) => ({ component_id: id, candidate_count: 2, candidate_entity_ids: [id, id + 1], oversized: false, deferred_candidates: 0, decisions: [decision(id)] });

async function executeReaction(options: {
  entities?: Array<{ entity_type: string }>;
  discover?: (input: Record<string, unknown>) => unknown;
  link?: (input: Record<string, unknown>) => unknown;
} = {}) {
  const discoveries: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  const logs: unknown[] = [];
  const sdk = {
    entities: {
      discoverDuplicates: async (input: Record<string, unknown>) => {
        discoveries.push(input);
        return options.discover?.(input) ?? { components: [], next_cursor: null };
      },
      link: async (input: Record<string, unknown>) => {
        links.push(input);
        return options.link?.(input) ?? { action: "link", relationship: { id: 1 } };
      },
    },
    log: (_message: string, data: unknown) => { logs.push(data); },
  } as unknown as ClientSDK;
  const result = await runScript({ source: reaction, sdk, context: { entities: options.entities ?? [{ entity_type: "contact-record" }] } });
  return { discoveries, links, logs, result };
}

describe("duplicate identity Automation template", () => {
  it("uses explicit schema policy and the user's bound entity type", () => {
    expect(template.detail.prompt).toContain("x-lobu-resolution");
    expect(template.detail.prompt).toContain("no implicit identity rules");
    expect(template.detail.prompt).toContain("Do not call entity tools or emit backlog tasks");
    expect(template.detail.sources).toBeUndefined();
    expect(template.detail.triggers).toEqual([expect.objectContaining({ skip_if_unchanged: false })]);
    expect(reaction).not.toContain("person");
    expect(reaction).not.toContain("entities.manage");
  });

  it("compiles with a small explanatory extraction contract", async () => {
    await expect(compileReactionScript(reaction)).resolves.toBeTruthy();
    expect((await extractReactionInputSchema(reaction))?.required).toEqual(["analysis_summary"]);
  });

  it("pages whole components and links only the server's root-pair proposals", async () => {
    const { discoveries, links, logs, result } = await executeReaction({
      discover: (input) => input.cursor ? { components: [component(3)], next_cursor: null } : { components: [component(1)], next_cursor: "page-2" },
    });
    expect(result.success).toBe(true);
    expect(discoveries).toEqual([
      { entity_type: "contact-record", limit: 100 },
      { entity_type: "contact-record", limit: 100, cursor: "page-2" },
    ]);
    expect(links).toEqual([decision(1), decision(3)]);
    expect(logs).toEqual([expect.objectContaining({ applied: 2, queued: 0, complete: true, next_cursor: null })]);
  });

  it("reports queued and suppressed outcomes without claiming applied links", async () => {
    const { links, logs, result } = await executeReaction({
      discover: () => ({ components: [component(1), component(3), { ...component(5), oversized: true, deferred_candidates: 27, decisions: [] }], next_cursor: null }),
      link: (input) => input.from_entity_id === 1 ? { approval_queued: true, approval_run_id: 7 } : { approval_suppressed: true },
    });
    expect(result.success).toBe(true);
    expect(links).toHaveLength(2);
    expect(logs).toEqual([expect.objectContaining({ applied: 0, queued: 1, suppressed: 1, oversized: 1, deferred_candidates: 27 })]);
  });

  it("stops below the SDK quota and exposes incomplete progress", async () => {
    const { discoveries, links, logs, result } = await executeReaction({
      discover: (input) => ({ components: Array.from({ length: Number(input.limit) }, (_, i) => component(i * 2 + 1)), next_cursor: "more" }),
    });
    expect(result.success).toBe(true);
    expect(discoveries).toHaveLength(2);
    expect(links).toHaveLength(197);
    expect(discoveries.length + links.length + logs.length).toBe(200);
    expect(logs).toEqual([expect.objectContaining({ complete: false, next_cursor: "more" })]);
  });

  it.each([{ entities: [] }, { entities: [{ entity_type: "a" }, { entity_type: "b" }] }, { entities: [{ entity_type: "$user" }] }])("rejects missing, mixed, or reserved type bindings before discovery: %j", async ({ entities }) => {
    const { discoveries, result } = await executeReaction({ entities });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("exactly one stored entity type");
    expect(discoveries).toEqual([]);
  });

  it("fails visibly for an unrecognized link receipt", async () => {
    const { result } = await executeReaction({ discover: () => ({ components: [component(1)], next_cursor: null }), link: () => ({}) });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("no applied, queued, or suppressed receipt");
  });
});
