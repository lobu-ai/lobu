import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Guards the scaffolded AGENTS.md against connector-key drift (#1178): the
 * template once documented `google_gmail` while the catalog key is
 * `google.gmail`, so generated configs failed `lobu apply` with
 * "connector ... is not installed in the org".
 *
 * The catalog source of truth is the `key:` literal that opens each
 * `definition` literal under packages/connectors/src. Feed runtimes use
 * `RuntimeConnectorDefinition` (optionally generic, possibly over several
 * lines); feedless integrations use `ConnectorDefinition`. Filenames use underscores while keys use dots.
 * Module-level maps and payload shapes also contain `key:` fields, so the match
 * must be anchored to the definition rather than taking the file's first key.
 */

const TEMPLATE_PATH = resolve(import.meta.dir, "../templates/AGENTS.md.tmpl");
const CONNECTORS_SRC_DIR = resolve(import.meta.dir, "../../../connectors/src");

function catalogKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(CONNECTORS_SRC_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(CONNECTORS_SRC_DIR, file), "utf-8");
    if (!source.includes("ConnectorDefinition")) continue;
    const match = source.match(
      /definition:\s*(?:Runtime)?ConnectorDefinition(?:<[\s\S]+?>)?\s*=\s*\{\s*key:\s*["']([^"']+)["']/
    );
    if (match) keys.add(match[1]);
  }
  return keys;
}

function documentedKeys(): string[] {
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const paragraph = template.match(
    /\*\*Bundled connector keys\*\*[\s\S]*?(?:\n\n|$)/
  )?.[0];
  expect(paragraph).toBeDefined();
  // The key list starts after the parenthesized prose ("... `google_gmail`):").
  // Tokens before it are prose examples (including deliberately wrong keys).
  const listStart = (paragraph as string).indexOf("):");
  expect(listStart).toBeGreaterThan(-1);
  const list = (paragraph as string).slice(listStart);
  const keys = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  expect(keys.length).toBeGreaterThan(10); // parse sanity, not a real bound
  return keys;
}

describe("AGENTS.md.tmpl bundled connector keys", () => {
  test("every documented key exists in the connector catalog", () => {
    const catalog = catalogKeys();
    const unknown = documentedKeys().filter((key) => !catalog.has(key));
    expect(unknown).toEqual([]);
  });

  test("every catalog key is documented", () => {
    const documented = new Set(documentedKeys());
    const undocumented = [...catalogKeys()].filter(
      (key) => !documented.has(key)
    );
    expect(undocumented).toEqual([]);
  });

  test("the canonical dotted Google keys are documented", () => {
    const documented = documentedKeys();
    expect(documented).toContain("google.gmail");
    expect(documented).toContain("google.calendar");
    expect(documented).not.toContain("google_gmail");
    expect(documented).not.toContain("google_calendar");
  });
});
