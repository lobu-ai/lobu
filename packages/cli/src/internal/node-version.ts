/**
 * Single source of truth for the CLI's Node-version policy.
 *
 * Lobu's gateway and worker load isolated-vm, whose native addon is tied to a
 * single Node major's V8 ABI. This repo ships one isolated-vm 7 build and runs
 * it on Node 26 only; Node 27 and later need a matching addon build before they
 * can be supported.
 *
 * The `bin/lobu.js` entrypoint carries an inline copy of the same major because
 * it must run with zero imports (before the bundle loads); keep it and
 * packages/server/src/utils/assert-node-version.ts in sync with this file.
 */

export const MIN_NODE_MAJOR = 26;
const MAX_NODE_MAJOR_EXCLUSIVE = 27;

function currentNodeMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
}

type NodeSupport = { ok: true } | { ok: false; reason: string; why: string };

/**
 * One-line explanation of the floor, so user-facing messages say WHY 26 —
 * not a bare "unsupported" that reads as arbitrary.
 */
const NODE_FLOOR_REASON =
  `Lobu runs agent code in an isolated-vm sandbox whose native build covers ` +
  `Node ${MIN_NODE_MAJOR}.x only.`;

/** Classify the running Node against Lobu's support policy. */
export function checkNodeSupport(): NodeSupport {
  const current = process.versions.node;
  const major = currentNodeMajor();
  if (
    !Number.isFinite(major) ||
    major < MIN_NODE_MAJOR ||
    major >= MAX_NODE_MAJOR_EXCLUSIVE
  ) {
    return {
      ok: false,
      reason: `Lobu needs Node.js ${MIN_NODE_MAJOR}.x — you're on Node ${current}.`,
      why: NODE_FLOOR_REASON,
    };
  }
  return { ok: true };
}
