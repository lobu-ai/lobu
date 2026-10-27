import { describe, expect, test } from "bun:test";
import { McpScopeRequiredError } from "../../../tools/access-control";
import { runOrSkip, stubSDK } from "./_helpers";

/**
 * The sandbox tallies change-capable dispatches outside the byte-capped call
 * trace. That separation is the whole point: `sdk_call_trace` is a ring that
 * evicts OLDEST entries, so a long run's early writes disappear from it — and a
 * summary derived from the trace would go silent on exactly the runs most
 * likely to have timed out mid-write.
 *
 * These run only where isolated-vm loads (CI Linux). `runOrSkip` returns null
 * otherwise, so a green result on a machine without the runtime proves nothing
 * — check `result === null` before reading a local pass as evidence. The
 * boundary semantics these feed is covered runtime-free in
 * `sdk-mcp-public-result.test.ts`.
 */
describe("sandbox started-side-effect tally", () => {
  test("survives trace eviction that drops every early write", async () => {
    let updates = 0;
    const result = await runOrSkip({
      source: `export default async (ctx, client) => {
        for (let i = 0; i < 40; i++) {
          await client.entities.update({ id: i, note: "x".repeat(400) });
        }
        for (let i = 0; i < 5; i++) await client.entities.list({});
        return "done";
      }`,
      sdk: stubSDK({
        entities: {
          update: async () => {
            updates++;
            return { ok: true };
          },
          list: async () => [],
        },
      } as never),
      sdkMode: "full",
      maxAccessLevel: "admin",
      // Small enough that the 40 writes cannot all fit; oldest get evicted.
      limits: { traceBytes: 2_048 },
    });
    if (!result) return; // isolated-vm unavailable in this environment

    expect(result.success).toBe(true);
    expect(updates).toBe(40);

    // The trace lost entries...
    expect(result.traceDropped).toBeGreaterThan(0);
    const writesLeftInTrace = result.sdkCallTrace.filter(
      (entry) => entry.access === "write",
    ).length;
    expect(writesLeftInTrace).toBeLessThan(40);

    // ...but the tally is complete and argument-free.
    const update = result.startedSideEffects.find(
      (entry) => entry.path === "entities.update",
    );
    expect(update).toEqual({ path: "entities.update", access: "write", count: 40 });
    expect(JSON.stringify(result.startedSideEffects)).not.toContain("xxxx");
  });

  test("records nothing for a read-only run", async () => {
    const result = await runOrSkip({
      source: `export default async (ctx, client) => {
        await client.entities.list({});
        return "read";
      }`,
      sdk: stubSDK({ entities: { list: async () => [] } } as never),
      sdkMode: "read",
    });
    if (!result) return;

    expect(result.success).toBe(true);
    expect(result.startedSideEffects).toEqual([]);
  });

  test("records nothing when dry-run skipped the writes", async () => {
    const result = await runOrSkip({
      source: `export default async (ctx, client) => {
        await client.entities.update({ id: 1 });
        return "skipped";
      }`,
      sdk: stubSDK({
        entities: {
          update: async () => {
            throw new Error("dry-run must not dispatch this");
          },
        },
      } as never),
      sdkMode: "full",
      maxAccessLevel: "admin",
      dryRun: true,
    });
    if (!result) return;

    expect(result.startedSideEffects).toEqual([]);
    expect(result.skippedCalls).toBe(1);
  });

  test("carries an admin-scope denial across the isolate with prior side effects intact", async () => {
    const result = await runOrSkip({
      source: `export default async (ctx, client) => {
        await client.entities.update({ id: 1 });
        await client.agents.delete({ agent_id: "agent-1" });
      }`,
      sdk: stubSDK({
        entities: { update: async () => ({ ok: true }) },
        agents: {
          delete: async () => {
            throw new McpScopeRequiredError(
              "manage_agents.delete needs admin access. This connection to example-org was approved without it, and tokens are not upgraded on refresh.",
              "mcp:admin",
            );
          },
        },
      } as never),
      sdkMode: "full",
      maxAccessLevel: "admin",
    });
    if (!result) return;

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("admin access");
    expect(result.requiredMcpScopes).toEqual(["mcp:admin"]);
    expect(result.startedSideEffects).toEqual([
      { path: "entities.update", access: "write", count: 1 },
      { path: "agents.delete", access: "admin", count: 1 },
    ]);
  });
});
