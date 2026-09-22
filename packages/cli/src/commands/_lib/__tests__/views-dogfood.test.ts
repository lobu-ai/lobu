/**
 * PR4 dogfood coverage: the four shipped example views bundle under the same
 * sandbox rules as production (`bundleViewFromFile`, the apply-time path), so
 * a view that imports a forbidden specifier or leaks the build machine into
 * its bytes fails here, not after deploy.
 *
 * Unlike `view-bundler.test.ts` (inline fixtures), this suite reads the real
 * files the example configs list, pinning each view's key/attach/params/
 * actions contract end to end.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bundleViewFromFile } from "../view-bundler.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
const TEAM_VIEWS = join(REPO_ROOT, "examples", "lobu-team", "views");
const CRM_VIEWS = join(REPO_ROOT, "examples", "lobu-crm", "views");

async function bundle(rel: string, base: string) {
  return bundleViewFromFile(join(base, rel));
}

describe("dogfood views", () => {
  test("connection-health card declares its key, attach and filter", async () => {
    const bundled = await bundle(join("connection", "health.tsx"), TEAM_VIEWS);
    expect(bundled.metadata.key).toBe("connection-health");
    expect(bundled.metadata.attach).toEqual([
      { type: "engineering-task", placement: "overview" },
    ]);
    expect(bundled.metadata.params).toEqual({
      only: { type: "string", default: "all" },
    });
    // Read-only: an example may only declare an action the workspace actually
    // handles. The earlier `retry: { emits: "connection.retry_requested" }`
    // named an event kind that exists in no registry and that no Automation
    // consumes, so invoking it appended a row nothing would ever read while
    // reporting success to the user.
    expect(bundled.metadata.actions ?? {}).toEqual({});
  });

  test("automation-runs tab declares its key, attach and status/window params", async () => {
    const bundled = await bundle(join("automation", "runs.tsx"), TEAM_VIEWS);
    expect(bundled.metadata.key).toBe("automation-runs");
    expect(bundled.metadata.attach).toEqual([{ type: "engineering-task" }]);
    expect(bundled.metadata.params).toEqual({
      status: { type: "string", default: "all" },
      window: { type: "string", default: "24h" },
    });
    expect(bundled.metadata.actions ?? {}).toEqual({});
  });

  test("provider-refusals page declares its workspace attach and window param", async () => {
    const bundled = await bundle(join("pages", "refusals.tsx"), TEAM_VIEWS);
    expect(bundled.metadata.key).toBe("provider-refusals");
    expect(bundled.metadata.attach).toEqual([{ workspace: true }]);
    expect(bundled.metadata.params).toEqual({
      window: { type: "string", default: "7d" },
    });
  });

  test("account-360 declares its pilot card+tab attach and no actions", async () => {
    const bundled = await bundle(join("pilot", "account-360.tsx"), CRM_VIEWS);
    expect(bundled.metadata.key).toBe("account-360");
    expect(bundled.metadata.attach).toEqual([
      { type: "pilot", placement: "overview" },
      { type: "pilot", placement: "tab" },
    ]);
    expect(bundled.metadata.actions ?? {}).toEqual({});
  });

  test("every dogfood bundle is self-contained, small and portable", async () => {
    for (const [rel, base] of [
      [join("connection", "health.tsx"), TEAM_VIEWS],
      [join("automation", "runs.tsx"), TEAM_VIEWS],
      [join("pages", "refusals.tsx"), TEAM_VIEWS],
      [join("pilot", "account-360.tsx"), CRM_VIEWS],
    ] as Array<[string, string]>) {
      const bundled = await bundle(rel, base);
      // No guest SDK chain (spike: 378 KB of zod + MCP SDK in the bundle).
      expect(bundled.compiledCode).not.toContain("ext-apps");
      expect(bundled.compiledCode).not.toContain("@modelcontextprotocol");
      // Hand-written bridge + React stay well under the server bundle cap.
      expect(bundled.compiledCode.length).toBeLessThan(300_000);
      // Portable: neither the repo root nor the entry path leaked into bytes.
      expect(bundled.compiledCode).not.toContain(REPO_ROOT);
      expect(bundled.compiledCode).not.toContain(join(base, rel));
    }
  });
  /**
   * Class-wide guard for the defect that shipped in `connection-health`: a
   * declared action whose `emits` names an event kind nothing registers and no
   * Automation consumes. `invoke_view_action` will happily append it, so the
   * button reports success while doing nothing — the failure is silent and
   * only visible by reading the config.
   *
   * An example may only emit an event kind its own config declares. This walks
   * every shipped example view rather than the one that regressed, so the next
   * view to invent an event fails here instead of in a review round.
   */
  test("no example view emits an unregistered event kind", async () => {
    const configs = [
      {
        config: await import(
          "../../../../../../examples/lobu-team/lobu.config.js"
        ),
        views: TEAM_VIEWS,
        files: [
          join("connection", "health.tsx"),
          join("automation", "runs.tsx"),
          join("pages", "refusals.tsx"),
        ],
      },
      {
        config: await import(
          "../../../../../../examples/lobu-crm/lobu.config.js"
        ),
        views: CRM_VIEWS,
        files: [join("pilot", "account-360.tsx")],
      },
    ];
    for (const entry of configs) {
      const cfg = (entry.config as { default: Record<string, unknown> })
        .default;
      const registered = new Set<string>();
      for (const entity of (cfg.entities ?? []) as Array<{
        eventKinds?: Record<string, unknown>;
      }>) {
        for (const kind of Object.keys(entity.eventKinds ?? {}))
          registered.add(kind);
      }
      for (const rel of entry.files) {
        const bundled = await bundle(rel, entry.views);
        const actions = (bundled.metadata.actions ?? {}) as Record<
          string,
          { emits?: string }
        >;
        for (const [name, decl] of Object.entries(actions)) {
          const emits = decl?.emits;
          expect(
            typeof emits,
            `${rel} action "${name}" must declare emits`
          ).toBe("string");
          expect(
            registered.has(emits as string),
            `${rel} action "${name}" emits "${emits}", which no entity in this example registers as an event kind`
          ).toBe(true);
        }
      }
    }
  });
});
