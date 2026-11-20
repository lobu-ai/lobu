import { build } from "bun";
import { fileURLToPath } from "node:url";
import { issueRepairPrompt } from "../issue-repair.prompt";
import type { HealthScope } from "../issue-tracker.reaction";

/** Operator supplies live scope at installation. Bundled bytes contain no
 * build paths, secrets, or implicit tenant defaults. */
export async function buildIssueRepair(
  scope: HealthScope,
  entrypoint = fileURLToPath(
    new URL("../issue-tracker.reaction.ts", import.meta.url)
  )
) {
  const result = await build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "cjs",
    env: "disable",
    sourcemap: "none",
    minify: { whitespace: true, identifiers: false, syntax: false },
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Issue tracker build failed");
  const code = await result.outputs[0]!.text();
  const module = `(() => { const module = {exports:{}}; ${code}\nreturn module.exports; })()`;
  const run = `(ctx, client, dryRun) => (${module}).runIssueTracker(ctx, client, dryRun, ${JSON.stringify(scope)})`;
  return {
    reaction: `export default (ctx, client) => (${run})(ctx, client, false);`,
    preview: `export default (ctx, client) => (${run})({window:{automation_id:0,run_id:0}}, client, true);`,
    prompt: issueRepairPrompt(scope.workspaces),
  };
}
