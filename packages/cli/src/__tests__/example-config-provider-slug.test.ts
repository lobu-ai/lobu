/**
 * Every `examples/*` config must name a provider that can actually route.
 *
 * A provider `id` becomes the org provider row's SLUG, and the gateway routes a
 * turn by resolving that slug back to a `config/providers.json` entry for its
 * upstream base URL. A slug that names no catalog entry synthesizes no module
 * (`synthesizeOrgProviderModule` returns null when neither the row nor its kind
 * names an upstream), so the row persists, lists as configured, and silently
 * never routes — every turn dies with NO_MODEL_CONFIGURED.
 *
 * Eleven shipped examples said `id: "anthropic"`. The catalog entry is
 * `claude`; `anthropic` is only the wire protocol's name. Following any of them
 * produced an agent that could not answer a single message.
 *
 * The model is checked for the same reason in reverse: the stored ref is
 * `<provider>/<model>`, so a `model` that already carries a slash yields a
 * three-segment ref that matches nothing.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const examplesDir = join(repoRoot, "examples");

function catalogSlugs(): Set<string> {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, "config", "providers.json"), "utf8")
  ) as unknown;
  const entries = Array.isArray(raw)
    ? raw
    : ((raw as { providers?: unknown[] }).providers ?? []);
  return new Set(
    (entries as Array<{ id?: string }>)
      .map((p) => p.id)
      .filter((id): id is string => typeof id === "string")
  );
}

function exampleConfigs(): Array<{ name: string; source: string }> {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      path: join(examplesDir, d.name, "lobu.config.ts"),
    }))
    .flatMap(({ name, path }) => {
      try {
        return [{ name, source: readFileSync(path, "utf8") }];
      } catch {
        // Not every example ships a config; those are simply out of scope.
        return [];
      }
    });
}

describe("example lobu.config.ts provider refs", () => {
  const slugs = catalogSlugs();
  const configs = exampleConfigs();

  /**
   * A provider entry is the only place these two keys sit together:
   * `{ id, model, key }`. An Automation's `model:` is a FULL `<provider>/<model>`
   * ref and carries no sibling `id:`, so anchoring on the pair keeps this from
   * flagging a correct Automation model.
   */
  function providerEntries(
    source: string
  ): Array<{ id: string; model: string }> {
    const out: Array<{ id: string; model: string }> = [];
    for (const m of source.matchAll(
      /\bid:\s*["']([^"']+)["']\s*,\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*model:\s*["']([^"']+)["']/g
    )) {
      out.push({ id: m[1] as string, model: m[2] as string });
    }
    return out;
  }

  test("the catalog and the example set are both non-empty", () => {
    // Guards the assertions below from passing vacuously if either the
    // providers.json shape or the examples layout changes.
    expect(slugs.size).toBeGreaterThan(0);
    expect(configs.length).toBeGreaterThan(0);
    expect(
      configs.flatMap(({ source }) => providerEntries(source)).length
    ).toBeGreaterThan(0);
  });

  test("every provider id is a routable catalog slug", () => {
    const offenders = configs.flatMap(({ name, source }) =>
      providerEntries(source)
        .filter((e) => !slugs.has(e.id))
        .map((e) => `${name}: id "${e.id}"`)
    );
    expect(offenders).toEqual([]);
  });

  test("no provider model carries its own slash", () => {
    // The stored ref is `<provider>/<model>`; a slash here makes it three
    // segments, which resolves to no provider module.
    const offenders = configs.flatMap(({ name, source }) =>
      providerEntries(source)
        .filter((e) => e.model.includes("/"))
        .map((e) => `${name}: model "${e.model}"`)
    );
    expect(offenders).toEqual([]);
  });
});
