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
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      for (const idMatch of line.matchAll(/\bid:\s*["']([^"']*)["']/g)) {
        const start = (idMatch.index ?? 0) + idMatch[0].length;
        // Scan from this id onward. Each step looks only at the text BEFORE
        // the object closes, so a `model:` that belongs to a later sibling on
        // the same line can never be pulled back onto this id. The first step
        // is the remainder of the id's own line, which is what lets a
        // single-line `{ id: "gemini", model: "gemini-2.5-flash" }` pair.
        // Line-at-a-time so the scan stays linear.
        for (let j = i; j < lines.length; j++) {
          const rest = j === i ? line.slice(start) : (lines[j] as string);
          const closedAt = rest.search(/[}\]]/);
          const open = closedAt === -1 ? rest : rest.slice(0, closedAt);
          // A further `id:` opens a different object — an agent's own `id:`
          // sits a few lines above its `providers:` array and would otherwise
          // swallow the provider's model.
          if (/\bid:\s*["']/.test(open)) break;
          const modelMatch = /\bmodel:\s*["']([^"']*)["']/.exec(open);
          if (modelMatch) {
            out.push({
              id: idMatch[1] as string,
              model: modelMatch[1] as string,
            });
            break;
          }
          // The object closed with no sibling `model:`. That is what keeps a
          // lone Automation `model:` from pairing with an unrelated `id:`.
          if (closedAt !== -1) break;
        }
      }
    }
    return out;
  }

  test("a provider entry is paired however the object is laid out", () => {
    // The layouts that actually occur in `examples/`, plus the one the pair
    // anchor exists to REJECT. A parser that silently skips a layout makes the
    // guard below pass vacuously for that example.
    expect(
      providerEntries(
        `  providers: [{ id: "gemini", model: "gemini-2.5-flash" }],`
      )
    ).toEqual([{ id: "gemini", model: "gemini-2.5-flash" }]);
    expect(
      providerEntries(
        [
          "  providers: [",
          "    {",
          '      id: "claude",',
          '      model: "claude-sonnet-5",',
          "      key: secret('K'),",
          "    },",
          "  ],",
        ].join("\n")
      )
    ).toEqual([{ id: "claude", model: "claude-sonnet-5" }]);
    expect(
      providerEntries(
        [
          "  {",
          '    id: "claude",',
          "    // a comment between the two keys",
          '    model: "claude-sonnet-5",',
          "  },",
        ].join("\n")
      )
    ).toEqual([{ id: "claude", model: "claude-sonnet-5" }]);
    // Two entries on one line: each id takes its OWN model, and neither
    // reaches past the brace that closed its object.
    expect(
      providerEntries(
        `  providers: [{ id: "a", model: "m-a" }, { id: "c", model: "m-c" }],`
      )
    ).toEqual([
      { id: "a", model: "m-a" },
      { id: "c", model: "m-c" },
    ]);
    // A closed object with no model must not borrow the next object's.
    expect(providerEntries(`  [{ id: "x" }, { model: "y" }]`)).toEqual([]);
    // An Automation's `model:` is a full ref and has no sibling `id:`; the
    // nearest `id:` above it belongs to a different object.
    expect(
      providerEntries(
        [
          "  {",
          '    id: "weekly-digest",',
          "  },",
          "  {",
          '    model: "claude/claude-sonnet-5",',
          "  },",
        ].join("\n")
      )
    ).toEqual([]);
  });

  test("every example that declares agent providers contributes an entry", () => {
    // Enumerates the class against the real tree: if a config declares
    // `providers: [` but yields nothing, the parser missed its layout and the
    // assertions below never look at that example at all.
    const missed = configs
      .filter(
        ({ source }) =>
          source.includes("providers: [") &&
          providerEntries(source).length === 0
      )
      .map(({ name }) => name);
    expect(missed).toEqual([]);
  });

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

  test("no provider model prefixes a slug other than its own", () => {
    // `map-config.ts` builds the ref as `model.startsWith(`${id}/`) ? model :
    // `${id}/${model}``, so a model already prefixed with its OWN id resolves
    // fine. Any other slash makes a three-segment ref that resolves to no
    // provider module.
    const offenders = configs.flatMap(({ name, source }) =>
      providerEntries(source)
        .filter((e) => e.model.includes("/") && !e.model.startsWith(`${e.id}/`))
        .map((e) => `${name}: model "${e.model}"`)
    );
    expect(offenders).toEqual([]);
  });
});
