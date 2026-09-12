import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  printSelfCheckResult,
  runConnectorRuntimeSelfCheck,
} from "@lobu/connector-worker/self-check";
/**
 * `lobu connector runtime-self-check` — the CLI side of the connector-runtime
 * parity smoke gate. STATIC-imports the SAME `runConnectorRuntimeSelfCheck`
 * the worker image runs (`@lobu/connector-worker/self-check`); the parity
 * invariant is that both entrypoints call this one function over the same
 * compile + isolate execution path. Internal/CI-only — not user
 * facing (no auth, no network), so it's registered hidden in index.ts.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export async function connectorRuntimeSelfCheckCommand(options: {
  json?: boolean;
}): Promise<void> {
  const result = await runConnectorRuntimeSelfCheck({
    surface: "cli",
    connectorSourceCandidates: [
      // Published CLI: build.cjs vendors connector sources under dist/connectors.
      resolve(HERE, "../connectors"),
      // Source/workspace execution.
      resolve(HERE, "../../../connectors/src"),
    ],
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printSelfCheckResult(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}
