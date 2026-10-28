import { describe, expect, it } from 'bun:test';
import { reactionErrorIsNonTransient } from '../../../automations/reaction-task';

describe('reactionErrorIsNonTransient', () => {
  it('classifies deterministic sandbox failures as non-retryable', () => {
    expect(reactionErrorIsNonTransient('TimeoutError: script exceeded 60000ms wall-clock budget')).toBe(true);
    expect(reactionErrorIsNonTransient('CompileError: failed to bundle')).toBe(true);
    expect(reactionErrorIsNonTransient('QuotaExceeded: SDK call quota reached')).toBe(true);
    expect(reactionErrorIsNonTransient('OutputSizeExceeded: bridge message exceeded bytes')).toBe(true);
    expect(reactionErrorIsNonTransient('ValidationError: invalid SDK arguments')).toBe(true);
    expect(reactionErrorIsNonTransient('McpScopeRequiredError: mcp:write is required')).toBe(true);
    expect(reactionErrorIsNonTransient('ScriptError: Script must `export default` an async function')).toBe(true);
    expect(reactionErrorIsNonTransient('ScriptError: CrossOrgAccessDenied: unavailable')).toBe(true);
  });

  it('stops on a failure the host classified as not retryable, whatever its name', () => {
    const denial =
      'AccessDeniedError: manage_agents.delete requires admin or owner access in synthetic-org. Your role in synthetic-org is member.';
    expect(reactionErrorIsNonTransient(denial, false)).toBe(true);
    expect(reactionErrorIsNonTransient(denial)).toBe(true);
    expect(reactionErrorIsNonTransient('ToolUserError: entity 7 was not found', false)).toBe(true);
    expect(reactionErrorIsNonTransient('ToolError: upstream returned 503', true)).toBe(false);
  });

  it('leaves transient errors retryable', () => {
    expect(reactionErrorIsNonTransient('Error: upstream returned 503')).toBe(false);
    expect(reactionErrorIsNonTransient('FetchError: network connection lost')).toBe(false);
    expect(reactionErrorIsNonTransient(undefined)).toBe(false);
  });
});
