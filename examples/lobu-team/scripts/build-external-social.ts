import { build } from "bun";
import { fileURLToPath } from "node:url";
import type { EvidencePolicy } from "../external-social-evidence";
import type { SocialScripts } from "../external-social.prompt";

/** Build locally, then pass the returned scripts to configureExternalSocial in
 * MCP. Normal imports stay in source; Bun includes their dependencies in the
 * standalone scripts that Chrome and MCP can execute without a module loader. */
export async function buildExternalSocial(
  policy: EvidencePolicy
): Promise<SocialScripts> {
  async function bundle(file: string, exported: string) {
    const result = await build({
      entrypoints: [fileURLToPath(new URL(`../${file}.ts`, import.meta.url))],
      target: "browser",
      format: "cjs",
      env: "disable",
      sourcemap: "none",
      minify: { whitespace: true, identifiers: false, syntax: false },
    });
    if (!result.success)
      throw new AggregateError(result.logs, "Social script build failed");
    const code = await result.outputs[0]!.text();
    // CJS exports stay local to the expression, including in an import-free V8 isolate.
    return `(() => { const module = {exports:{}}; ${code}\nreturn module.exports.${exported}; })()`;
  }
  const [reader, verifier, reaction] = await Promise.all([
    bundle("social-timeline-reader", "readSocialTimelinePage"),
    bundle("external-social-evidence", "verifySocialEvidence"),
    bundle("external-social.reaction", "deliverExternalSocial"),
  ]);
  return {
    policy,
    preflight: `const timelineReaderSource = ${JSON.stringify(reader)};\nconst verifySocialEvidence = (${verifier}).bind(null, timelineReaderSource);`,
    reaction: `export default (ctx, client) => (${reaction})(ctx, client, ${JSON.stringify(policy)});`,
  };
}
