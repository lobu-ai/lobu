/**
 * The daemon arm for an agent turn: one conversation turn as one isolate job.
 *
 * There is no separate executor. The turn is an `ExecutorJob` mode, so it runs
 * through `selectExecutor` exactly as a connector does and inherits that lane's
 * egress dispatcher, credential vault, wall clock, memory limit and log budget.
 * What this module adds is only the envelope: the guest bundle, the allowlist,
 * and reporting the result.
 */

import {
  type AgentTurnPollPayload,
  type AgentTurnToolEvent,
  type PollResponse,
  TURN_DELTA_MAX_CHARS,
} from '@lobu/core/contracts/worker/protocol';
import { agentGuestBundle } from '../agent-turn/bundle.js';
import type { AgentTurnEvent, AgentTurnGatewayTool } from '../agent-turn/types.js';
import { selectExecutor } from '../executor/select.js';
import type { ExecutorConfig } from './executor.js';
import type { ExecutorClient } from './client.js';
import { log } from './log.js';

/**
 * How often a streaming turn pushes what it has produced.
 *
 * This is the DELTA cadence, deliberately separate from the liveness heartbeat
 * (30s in production, shared with five other lanes). A reply delivered in 30s
 * clumps is not streaming, and lowering the shared interval to fix that would
 * multiply heartbeat write load across every lane that does not need it. Only
 * a turn that is actively producing text beats this often, and each beat is
 * the same request the liveness beat would have made.
 */
const TURN_DELTA_FLUSH_MS = 400;

/**
 * How many batches the pre-completion drain will push before giving up.
 *
 * A bound, not a budget for the whole reply: the terminal `finalText` is
 * authoritative and repairs anything left behind, so waiting longer here buys
 * a cosmetic improvement at the cost of the completion the client is blocked
 * on.
 */
const TURN_DELTA_DRAIN_BATCHES = 4;

/**
 * How many tool traces a turn will hold for the next beat.
 *
 * A tool trace is a view of the turn, not its answer, so a backlog is dropped
 * rather than grown: past this many the OLDEST go, because what a client wants
 * to see is what the agent is doing now.
 */
const TURN_TOOL_EVENT_QUEUE_MAX = 20;

function isAgentTurnPayload(value: unknown): value is AgentTurnPollPayload {
  return !!value && typeof value === 'object' && 'turn' in value;
}

export async function executeAgentTurnRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Record<string, string | undefined>,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const runId = job.run_id;
  if (!runId) return { itemsCollected: 0, error: 'agent turn run missing its run id' };

  const fail = async (error: string) => {
    await client.completeAgentTurn({
      run_id: runId,
      worker_id: client.id,
      status: 'failed',
      error,
      exit_reason: 'error_message',
    });
    return { itemsCollected: 0, error };
  };

  // The run is already claimed, so a rejected envelope must be REPORTED, not
  // returned: a local return leaves the turn parked until the stale sweep.
  const payload = job.payload;
  if (!isAgentTurnPayload(payload)) {
    return fail('agent turn run received a non-turn payload envelope');
  }
  const turn = payload.turn;
  if (!job.credentials?.accessToken) {
    return fail('agent turn run arrived without its provider credential');
  }

  let toolCalls = 0;
  // Text the guest has produced that the SERVER has not acknowledged yet.
  //
  // Incremental, because that is what every renderer of a `thread_response`
  // delta does with it — the API renderer broadcasts the span and the SPA
  // appends it, exactly as the subprocess lane's `sendStreamDelta(delta,
  // false)` intends. A cumulative snapshot down the same path renders as the
  // reply repeated back to itself.
  //
  // Nothing leaves this queue until the server names its sequence in the
  // heartbeat's ack, so a beat that fails or is fenced out re-sends the same
  // span rather than dropping it. The server's own sequence fence makes the
  // duplicate a no-op, which is what lets a retry be safe.
  let pending = '';
  // The batch currently in flight, and the sequence it was sent under. A retry
  // reuses BOTH: a new sequence for the same text would be a second span the
  // server's fence has no reason to refuse.
  let inFlight: { text: string; sequence: number } | null = null;
  let deltaSequence = 0;
  let sending = false;
  // Tool traces waiting for the next beat, oldest first.
  let toolEvents: AgentTurnToolEvent[] = [];

  /**
   * Send the next batch, if there is one and none is already in flight.
   *
   * Serial by construction (`sending`): two batches in parallel would race to
   * the same run row and the loser's span would be fenced out and — because
   * its ack would still name its own sequence — retired unwritten. One batch,
   * one ack, then the next.
   */
  const flushDelta = async (): Promise<void> => {
    if (sending) return;
    if (!inFlight) {
      if (!pending) {
        // Nothing to say about the text, but a tool may have finished. That
        // still rides a beat — just without a delta.
        if (toolEvents.length === 0) return;
      } else {
        // Bounded per batch, never per reply: the text this cap holds back
        // stays in `pending` and rides the next batch. Slicing the HEAD is what
        // makes that true — the tail is the part not sent yet.
        const text = pending.slice(0, TURN_DELTA_MAX_CHARS);
        pending = pending.slice(text.length);
        inFlight = { text, sequence: (deltaSequence += 1) };
      }
    }
    sending = true;
    const batch = inFlight;
    // Taken before the await so a trace arriving mid-flight queues for the
    // next beat rather than being dropped by the reset below.
    const traces = toolEvents;
    toolEvents = [];
    try {
      const ack = await client.heartbeat(
        runId,
        { items_collected_so_far: deltaSequence },
        undefined,
        batch ?? undefined,
        traces.length > 0 ? traces : undefined
      );
      // Retire the batch only on a positive ack for ITS sequence. `published:
      // false` is an ack too — a shadow turn and an already-passed sequence
      // are both answers, and there is nothing more the worker can do about
      // either. No ack at all (an older gateway, or a publish that threw)
      // keeps the text queued for the next beat.
      if (batch && ack?.turn_delta_ack?.sequence === batch.sequence) inFlight = null;
    } catch (err) {
      // The batch stays in flight and is re-sent under the same sequence. The
      // traces are not: they are a view of the turn, not its answer, and
      // re-queueing them would grow without bound against a failing gateway.
      log.debug('[agent-turn] delta beat failed:', err);
    } finally {
      sending = false;
    }
  };

  /**
   * Flush what is left before the completion row lands, so the last span of
   * the reply arrives as a delta rather than as a jump at completion.
   *
   * Bounded on BOTH axes. `TURN_DELTA_DRAIN_BATCHES` caps how many batches it
   * will push, so a long reply cannot make the turn's completion wait on its
   * whole backlog; and the loop stops the moment a batch fails to retire, so a
   * server that is refusing cannot spin here. Whatever is left is not lost —
   * the terminal `finalText` is the authoritative reply and repairs it.
   */
  const drainDeltas = async (): Promise<void> => {
    for (let batch = 0; batch < TURN_DELTA_DRAIN_BATCHES; batch += 1) {
      if (!pending && !inFlight && toolEvents.length === 0) return;
      const before = inFlight;
      await flushDelta();
      // No progress — the batch is still in flight under the same sequence —
      // means the server is not taking it, and retrying inline would only
      // delay the completion the client is actually waiting for.
      if (inFlight && inFlight === before) return;
    }
  };

  // The delta cadence, which is NOT the liveness cadence. The reaper's
  // contract is satisfied by a beat every `cfg.heartbeatIntervalMs` (30s in
  // production), but a reply that arrives in 30s clumps is not streaming — so
  // deltas run on their own short timer and the liveness beat below only fires
  // when the turn has produced nothing to say. Both call the same endpoint, so
  // a delta beat IS a liveness beat; this adds write load only while a turn is
  // actively streaming, and only on this lane.
  const deltaTimer = setInterval(() => {
    void flushDelta();
  }, Math.min(TURN_DELTA_FLUSH_MS, cfg.heartbeatIntervalMs));
  // The connector-lane reaper writes a claimed run off once its heartbeat goes
  // stale, and a turn's wall clock is far longer than that threshold. Beat on
  // the same interval every other lane does, so a live turn is never reaped and
  // a crashed worker's turn still is. Skipped while a delta beat is in flight
  // or due: that beat already proves the same thing.
  const heartbeat = setInterval(() => {
    if (sending || inFlight || pending || toolEvents.length > 0) return;
    void client
      .heartbeat(runId, { items_collected_so_far: deltaSequence })
      .catch((err) => log.debug('[agent-turn] heartbeat failed:', err));
  }, cfg.heartbeatIntervalMs);
  try {
    const guestCode = await agentGuestBundle();
    // Same executor seam every other lane uses (`resolveJobExecution`): an
    // injected one owns its own limits, otherwise build the isolate here.
    const executor =
      cfg.executor ??
      (await selectExecutor({
        timeoutMs: cfg.timeoutMs,
        // Deny-all but the hosts the gateway named — normally just itself. A
        // connector's open default would let a prompt-injected turn reach the
        // whole internet.
        allowedDomains: turn.allowed_hosts,
      }));
    const result = await executor.execute(
      guestCode,
      {
        mode: 'agent_turn',
        turn: {
          provider: {
            api: turn.provider.api,
            provider: turn.provider.provider,
            modelId: turn.provider.model_id,
            baseUrl: turn.provider.base_url,
            ...(turn.provider.max_tokens !== undefined ? { maxTokens: turn.provider.max_tokens } : {}),
            // pi-ai's own `Model.input`, resolved by the gateway from pi-ai's
            // model registry. Passed through untouched: pi is what enforces it.
            ...(turn.provider.input ? { input: turn.provider.input } : {}),
          },
          systemPrompt: turn.system_prompt,
          messages: turn.messages,
          userMessage: turn.message_text,
          // Attachment bytes the gateway already resolved out of its artifact
          // store. The guest fetches nothing: an attachment URL never reaches
          // it, so a turn cannot be talked into dialling one.
          ...(turn.message_images && turn.message_images.length > 0
            ? {
                images: turn.message_images.map((image) => ({
                  mimeType: image.mime_type,
                  data: image.data,
                })),
              }
            : {}),
          // Non-image attachments, by name and type only — the same thing the
          // subprocess lane tells the model, minus the disk it could read them
          // from.
          ...(turn.message_files && turn.message_files.length > 0
            ? {
                files: turn.message_files.map((file) => ({
                  name: file.name,
                  mimeType: file.mime_type,
                  ...(file.size !== undefined ? { size: file.size } : {}),
                })),
              }
            : {}),
          ...(turn.tools
            ? {
                tools: {
                  gatewayUrl: turn.tools.gateway_url,
                  definitions: turn.tools.definitions.map((tool) => ({
                    mcpId: tool.mcp_id,
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.input_schema,
                  })),
                  ...(turn.tools.builtin ? { builtin: turn.tools.builtin } : {}),
                  ...(turn.tools.bash_policy
                    ? {
                        bashPolicy: {
                          allowAll: turn.tools.bash_policy.allow_all,
                          allowPrefixes: turn.tools.bash_policy.allow_prefixes,
                          denyPrefixes: turn.tools.bash_policy.deny_prefixes,
                        },
                      }
                    : {}),
                  // Names only; the guest selects them out of the plugin
                  // package, which is where their routing and schemas live.
                  // Without the conversation they address there is nothing to
                  // post into, so the pair travels together or not at all.
                  ...(turn.tools.gateway && turn.tools.gateway.length > 0 && turn.tools.conversation
                    ? {
                        gateway: turn.tools.gateway as AgentTurnGatewayTool[],
                        conversation: {
                          channelId: turn.tools.conversation.channel_id,
                          conversationId: turn.tools.conversation.conversation_id,
                          platform: turn.tools.conversation.platform,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
        config: {},
        credentials: job.credentials,
        sessionState: null,
        env,
      },
      {
        onTurnEvent: (event: AgentTurnEvent) => {
          if (event.type === 'text_delta') {
            // Queued, not accumulated: the next batch carries what the server
            // has not acknowledged, and nothing here is ever discarded. The
            // per-batch cap lives in `flushDelta`.
            pending += event.delta;
            return;
          }
          if (event.type === 'tool_call_start') {
            toolCalls += 1;
            return;
          }
          if (event.type === 'tool_call_end') {
            // The turn's tool trace, queued onto the same beat the text takes.
            // The server turns it into the SAME `tool_use` custom event the
            // subprocess lane emits per `tool_execution_end`, so every consumer
            // that already reads that — the SPA, the promptfoo provider, the
            // menubar — sees this lane's tools without learning a second shape.
            //
            // Bounded, and the newest are the ones kept: a tool trace is a view
            // of the turn, not its answer, and a turn that spends its budget on
            // tool calls must not grow an unbounded queue in the worker.
            toolEvents.push({
              tool_call_id: event.toolCallId,
              name: event.name,
              is_error: event.isError,
              output: event.output,
            });
            if (toolEvents.length > TURN_TOOL_EVENT_QUEUE_MAX) toolEvents.shift();
          }
        },
      }
    );
    if (result.mode !== 'agent_turn') {
      return fail(`agent turn produced a ${result.mode} result`);
    }
    // Everything the guest streamed, before the completion row lands. The
    // terminal reply is authoritative and repairs any delta the client missed,
    // so this is not correctness — it is the last span arriving as a delta
    // rather than as a jump at completion. Bounded so a turn cannot hang on a
    // queue the server keeps refusing.
    await drainDeltas();
    await client.completeAgentTurn({
      run_id: runId,
      worker_id: client.id,
      status: 'completed',
      text: result.turn.text,
      stop_reason: result.turn.stopReason,
      usage: result.turn.usage,
      transcript: result.turn.messages,
      ...(result.turn.repliedInBand ? { replied_in_band: true } : {}),
      exit_reason: 'ok',
    });
    log.info(
      `[agent-turn] run ${runId} completed after ${deltaSequence} delta batches and ${toolCalls} tool calls`
    );
    return { itemsCollected: 0 };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(deltaTimer);
    clearInterval(heartbeat);
  }
}
