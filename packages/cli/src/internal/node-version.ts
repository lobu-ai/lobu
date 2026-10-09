/**
 * Single source of truth for the CLI's Node-version policy.
 *
 * Lobu's SDK sandbox (query_sdk / run_sdk) uses isolated-vm, whose native addon
 * is tied to each Node line's V8 ABI: isolated-vm@6 covers Node 22–24, the
 * aliased isolated-vm@7 covers Node 26+. Node 25 is an EOL non-LTS line upstream
 * skipped, so it boots but has no sandbox build. Below 22 nothing works — the
 * bundled server's deps (undici) reference globals absent on
 * old Node and crash on load.
 *
 * The `bin/lobu.js` entrypoint carries an inline copy of the MIN threshold
 * because it must run with zero imports (before the bundle loads); keep it and
 * packages/server/src/utils/assert-node-version.ts in sync with this file.
 */

export const MIN_NODE_MAJOR = 22;
const SANDBOX_GAP_NODE_MAJOR = 25;

function currentNodeMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
}

/** True when isolated-vm has a build for this Node major (sandbox works). */
export function sandboxAvailableForNode(major: number): boolean {
  return (
    (major >= MIN_NODE_MAJOR && major < SANDBOX_GAP_NODE_MAJOR) || major >= 26
  );
}

type NodeSupport =
  | { ok: true; sandbox: boolean }
  | { ok: false; reason: string; why: string };

/**
 * One-line explanation of the floor, so user-facing messages say WHY 22 —
 * not a bare "unsupported" that reads as arbitrary.
 */
const NODE_FLOOR_REASON =
  `Lobu runs agent code in an isolated-vm sandbox whose native builds only ` +
  `cover Node ${MIN_NODE_MAJOR}–24 and 26+, so ${MIN_NODE_MAJOR} is the minimum.`;

/** Classify the running Node against Lobu's support policy. */
export function checkNodeSupport(): NodeSupport {
  const current = process.versions.node;
  const major = currentNodeMajor();
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      reason: `Lobu needs Node.js ${MIN_NODE_MAJOR} or newer — you're on Node ${current}.`,
      why: NODE_FLOOR_REASON,
    };
  }
  return { ok: true, sandbox: sandboxAvailableForNode(major) };
}
