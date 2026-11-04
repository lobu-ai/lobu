/** Runs in the candidate container with --network=none before image promotion. */
import assert from "node:assert/strict";
import { createValidatorServer } from "./service";
import { validationIdentity } from "../../packages/server/src/views/validation-contract";
assert.notEqual(process.getuid?.(), 0, "Validator must run without root");
// An explicit endpoint reuses these assertions from a trusted host-network
// probe against the isolated Compose service. It never launches author code here.
const runner = process.argv[2] ? undefined : createValidatorServer();
if (runner)
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
const url = process.argv[2]
  ? new URL("/validate", process.argv[2]).href
  : `http://127.0.0.1:${(runner!.address() as { port: number }).port}/validate`;
const handshake = `<script>window.addEventListener('message', e => { if(e.data.id === 1) window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*'); }); window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*');</script>`;
try {
  for (const [code, expected] of [
    ["", true],
    ['throw new Error("candidate failure")', false],
    ['fetch("https://blocked.invalid/")', false],
  ] as const) {
    const artifact = {
      html: `<div id="root">Fixture</div>${handshake}<script>${code}</script>`,
      runtime: "",
      assets: {},
    };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifact,
        scenarios: [
          {
            theme: "light",
            displayMode: "inline",
            queryState: "empty",
            scope: {},
            params: {},
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      passed: boolean;
      artifactHash: string;
      runtimeHash: string;
    };
    assert.equal(result.passed, expected);
    assert.equal(
      result.artifactHash,
      validationIdentity(artifact).artifactHash
    );
    assert.equal(result.runtimeHash, validationIdentity(artifact).runtimeHash);
  }
  console.log(
    "PASS: isolated validator mounts, rejects broken candidates and denies network"
  );
} finally {
  if (runner)
    await new Promise<void>((resolve) => runner.close(() => resolve()));
}
