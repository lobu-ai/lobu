/**
 * The daemon arm for an agent turn: one conversation turn as one isolate job.
 *
 * There is no separate executor. The turn is an `ExecutorJob` mode, so it runs
 * through `selectExecutor` exactly as a connector does and inherits that lane's
 * egress dispatcher, credential vault, wall clock, memory limit and log budget.
 * What this module adds is only the envelope: the guest bundle, the allowlist,
 * and reporting the result.
 */

import type { AgentTurnPollPayload, PollResponse } from '@lobu/core/contracts/worker/protocol';
import { agentGuestBundle } from '../agent-turn/bundle.js';
import type { AgentTurnEvent, AgentTurnGatewayTool } from '../agent-turn/types.js';
import { selectExecutor } from '../executor/select.js';
import type { ExecutorConfig } from './executor.js';
import type { ExecutorClient } from './client.js';
import { log } from './log.js';

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

  let deltas = 0;
  let toolCalls = 0;
  // The connector-lane reaper writes a claimed run off once its heartbeat goes
  // stale, and a turn's wall clock is far longer than that threshold. Beat on
  // the same interval every other lane does, so a live turn is never reaped and
  // a crashed worker's turn still is.
  const heartbeat = setInterval(() => {
    void client
      .heartbeat(runId, { items_collected_so_far: deltas })
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
          if (event.type === 'text_delta') deltas += 1;
          if (event.type === 'tool_call_start') toolCalls += 1;
        },
      }
    );
    if (result.mode !== 'agent_turn') {
      return fail(`agent turn produced a ${result.mode} result`);
    }
    await client.completeAgentTurn({
      run_id: runId,
      worker_id: client.id,
      status: 'completed',
      text: result.turn.text,
      stop_reason: result.turn.stopReason,
      usage: result.turn.usage,
      transcript: result.turn.messages,
      exit_reason: 'ok',
    });
    log.info(`[agent-turn] run ${runId} completed after ${deltas} deltas and ${toolCalls} tool calls`);
    return { itemsCollected: 0 };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(heartbeat);
  }
}
