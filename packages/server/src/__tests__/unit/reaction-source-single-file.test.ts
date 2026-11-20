import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { compileReactionScript } from "../../automations/reaction-executor";

/**
 * Automation reactions are uploaded as ONE source file. Bun resolves a local
 * import in the example's own tests, but the server compiler rejects it at
 * apply time — a modular helper module therefore has to be inlined before the
 * reaction ships.
 */
describe("example reaction sources", () => {
  test.each(["issue-tracker.reaction.ts", "issue-triage.reaction.ts"])(
    "%s compiles as a single-file reaction",
    async (name) => {
      const source = await readFile(
        new URL(
          `../../../../../examples/lobu-team/${name}`,
          import.meta.url
        ),
        "utf8"
      );
      await expect(compileReactionScript(source)).resolves.toBeString();
    }
  );
});
