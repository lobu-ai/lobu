/**
 * The model-facing message shape and pi's summary framing, with no imports:
 * this file is what the isolate guest's compaction shares with the server's
 * session replay, and the guest bundle must stay free of Node.
 */

/**
 * A message the model is shown, in pi's own shape: `user`, `assistant` or
 * `toolResult`, with whatever fields the entry carried (usage, stop reason,
 * tool call ids) preserved so a provider sees exactly what it produced.
 */
export type SessionMessage = Record<string, unknown> & { role: string };

/**
 * pi's exact framing for a compaction summary when it is shown to the model
 * (`convertToLlm` in pi-coding-agent's messages.ts). Copied verbatim so the
 * summary reads identically whichever lane replays it.
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;
