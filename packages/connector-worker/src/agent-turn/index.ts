/**
 * The agent-turn lane: one conversation turn executed as one isolate job.
 *
 * The turn reuses the connector lane wholesale — `IsolateExecutor` runs it
 * under the same egress dispatcher, credential vault, streaming fetch, wall
 * clock, memory limit and log budget a connector gets. What lives here is only
 * what a turn adds: the wire shapes and the guest bundle.
 */

export { agentGuestBundle } from './bundle.js';
export { MAX_TOOL_CALLS_PER_TURN } from './types.js';
export type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput } from './types.js';
