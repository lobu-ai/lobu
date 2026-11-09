/**
 * `prompts/review-output-schema.json` is handed to BOTH reviewer CLIs by
 * `scripts/review.sh` — `claude --json-schema "$(cat …)"` and `codex exec
 * --output-schema …`. The two accept overlapping but not identical dialects,
 * and `review.sh` fails closed: a schema either CLI rejects produces no
 * verdict, `finalize_review_status error`, and a red `pi-review` status. That
 * check is required with `enforce_admins` on, so a one-key schema edit can
 * block every merge in the repo.
 *
 * That is exactly what happened. The file opened with
 *
 *   "$schema": "https://json-schema.org/draft/2020-12/schema"
 *
 * and `claude --json-schema` cannot resolve that meta-schema reference:
 *
 *   Error: --json-schema is not a valid JSON Schema: no schema with key or
 *   ref "https://json-schema.org/draft/2020-12/schema"
 *
 * It exits before reading the prompt, so the failure looks like a dead
 * reviewer rather than a bad key. codex accepts the file either way, so the
 * repo ran for as long as codex was the selected reviewer and only broke on
 * the fallback — the worst shape for a gate, because it is discovered under a
 * quota outage when there is no second reviewer to fall back to.
 *
 * The keys asserted here are the ones whose absence a reviewer only reports
 * as "no schema-valid JSON verdict", which reads as a model failure and sends
 * the next person to re-run the review instead of to this file.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCHEMA_FILE = join(REPO_ROOT, "prompts/review-output-schema.json");

/**
 * `$schema` and `$id` point the loader at a document it will not fetch —
 * claude refuses the file outright with "no schema with key or ref …". Local
 * `$defs`/`$ref` DO load in the claude CLI (verified: a `#/$defs/…` schema
 * round-trips), but they are reference machinery a flat verdict schema does
 * not need, so the guard keeps the file reference-free instead of tracking
 * which CLI tolerates which indirection.
 */
function unsupportedKeys(schema: Record<string, unknown>): string[] {
  return ["$schema", "$id", "$ref", "$defs"].filter((key) => key in schema);
}

/**
 * `required` naming a property that does not exist is the other way this file
 * fails closed: codex's structured-output mode rejects the schema, and the
 * error surfaces as an empty verdict rather than as a schema complaint.
 */
function danglingRequired(schema: {
  required?: string[];
  properties?: Record<string, unknown>;
}): string[] {
  const properties = schema.properties ?? {};
  return (schema.required ?? []).filter((name) => !(name in properties));
}

describe("review output schema stays loadable by both reviewer CLIs", () => {
  const raw = readFileSync(SCHEMA_FILE, "utf8");
  const schema = JSON.parse(raw) as Record<string, any>;

  it("stays reference-free so both reviewer CLIs load it", () => {
    expect(unsupportedKeys(schema)).toEqual([]);
  });

  it("flags the draft-2020-12 declaration that broke the claude reviewer", () => {
    expect(
      unsupportedKeys({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      })
    ).toEqual(["$schema"]);
  });

  it("requires only properties it defines", () => {
    expect(danglingRequired(schema)).toEqual([]);
  });

  it("flags a required name with no matching property", () => {
    expect(
      danglingRequired({
        required: ["decision", "typo_field"],
        properties: { decision: { type: "string" } },
      })
    ).toEqual(["typo_field"]);
  });

  it("keeps the closed-object shape codex's structured output needs", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });
});
