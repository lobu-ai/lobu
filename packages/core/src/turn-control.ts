/**
 * Turn control policy: whether an inbound message steers the turn already
 * running, cancels it, or queues as a turn of its own.
 *
 * Shared by every lane that can have a turn in flight — the agent worker, which
 * holds the running child process, and the gateway producer that dispatches an
 * isolate turn to a fleet worker it cannot address directly. One message gets
 * one answer whichever lane is running it, which is the whole point of putting
 * the predicates here rather than beside either dispatcher.
 *
 * Everything here is pure and depends only on the wire payload, so the isolate
 * guest can import this module by its own subpath (`@lobu/core/turn-control`)
 * without dragging the logger and its Node transports into the bundle.
 */
import type { MessagePayload } from "./worker/wire";

/**
 * Sources that produce a message without a human waiting on it. An automation
 * firing while a turn runs is a second job, not a correction of the first, so
 * it queues instead of steering.
 */
const AUTOMATION_SOURCES = new Set([
  "automation-run",
  "scheduled-job",
  "connector-repair",
  "internal",
  "automation",
]);

/**
 * Whether this message should be injected into the turn already running.
 *
 * The exclusions are each a case where treating the message as ordinary model
 * input would lose the thing that makes it special, so they queue as their own
 * turn instead.
 */
export function isSteerableHumanMessage(payload: MessagePayload): boolean {
  if (
    payload.platformMetadata?.automationId &&
    payload.platformMetadata?.automationActiveRunPolicy !== "steer"
  ) {
    return false;
  }
  // `/new` must run after the active turn: it flushes memory, deletes the
  // transcript, and purges durable snapshots. Steering it into the current Pi
  // session would treat the control command as ordinary text and preserve the
  // history the user explicitly asked to reset.
  if (payload.platformMetadata?.sessionReset === true) return false;
  // A `!`-bash message is a control action, not model input: steering it into an
  // active turn would feed the raw `!cmd` text to the model instead of running
  // it. Queue it as its own turn (the worker intercept runs the shell).
  if (payload.platformMetadata?.bangBash) return false;
  const source = payload.platformMetadata?.source;
  if (typeof source === "string" && AUTOMATION_SOURCES.has(source)) {
    return false;
  }
  // An attachment rides its own load path into the prompt; steering would send
  // the caption and silently drop the file.
  const files = payload.platformMetadata?.files;
  return !Array.isArray(files) || files.length === 0;
}

/** Whether this message asks the running turn to stop. */
export function isExplicitCancelMessage(payload: MessagePayload): boolean {
  const metadata = payload.platformMetadata;
  if (metadata?.control === "cancel") return true;
  const intent = metadata?.intent;
  if (
    typeof intent === "object" &&
    intent !== null &&
    (intent as Record<string, unknown>).kind === "cancel"
  ) {
    return true;
  }
  return payload.messageText.trim().toLowerCase() === "/cancel";
}
