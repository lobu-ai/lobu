/** Most characters of per-turn context (Automation instructions) a chat turn carries. */
export const CHAT_TURN_CONTEXT_CHARS = 2_048;

/**
 * Room left behind the caller's context for the sender line `chatTurnContext`
 * appends. A retry's interrupted-turn note never takes this space.
 */
export const CHAT_TURN_SENDER_LINE_RESERVE_CHARS = 160;

/** The interrupted-turn note a retry carries when its full tool summary does not fit. */
export const INTERRUPTED_TURN_SHORT_NOTE =
  "A previous attempt at this message was interrupted after it ran tools. Check for their effects before repeating any.";

/**
 * Most optional context (such as recent thread history) a producer may add
 * beside an Automation preamble, so a retry still fits the one-line
 * interrupted-turn note in front of it and the sender line behind it.
 */
export const CHAT_TURN_OPTIONAL_CONTEXT_CHARS =
  CHAT_TURN_CONTEXT_CHARS - CHAT_TURN_SENDER_LINE_RESERVE_CHARS - (INTERRUPTED_TURN_SHORT_NOTE.length + 2);
