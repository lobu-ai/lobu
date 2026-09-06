/**
 * The turn's media tools: `upload_file`, `generate_image` and `generate_audio`,
 * from `@lobu/plugin-media` itself.
 *
 * GUEST code, so the same portability rules as `workspace.ts` and
 * `gateway-tools.ts` apply: no `node:` import, no host module, no root
 * `@lobu/core` import.
 *
 * Nothing here reimplements a tool. `createMediaTools` is the SAME function the
 * subprocess lane composes, so the schemas, the descriptions, the request
 * bodies and every sentence the model reads on a refusal are identical on both
 * lanes. What this module adds is the one thing that genuinely differs: WHERE
 * the bytes of `upload_file` come from. The subprocess lane reads a directory
 * on the worker's disk; this lane has no disk, so the port below reads the
 * turn's own in-memory workspace — the very filesystem `bash` and `write` just
 * wrote to, not the host's.
 *
 * The upload itself is the plugin's shared multipart driver over the guest's
 * `fetch`, so it goes through the host's one egress module under the turn's one
 * credential, to the same gateway host the MCP route is on.
 */

import {
  createMediaTools,
  type MediaFilePort,
  type MediaFileResolution,
  // The PORTABLE entry point, not the package root: the root defaults the file
  // port to the `node:fs` one, and a Node builtin anywhere in an isolate
  // bundle is rejected outright by `assertIsolateEligible`.
} from '@lobu/plugin-media/portable';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { InMemoryFs } from 'just-bash/browser';
import type { AgentTurnConversation, AgentTurnMediaTool } from './types.js';
import { WORKSPACE_ROOT, type AgentWorkspace } from './workspace.js';

/**
 * `upload_file`'s view of the turn's in-memory workspace.
 *
 * Containment is enforced with the workspace's OWN `resolve`, the same one
 * every file tool calls: a path that escapes `/workspace` throws there and is
 * reported here as `outside-workspace`, so `upload_file` cannot reach a file
 * `read` would refuse. The size cap and the MIME type are the plugin's, applied
 * identically on both lanes.
 */
function createWorkspaceFilePort(workspace: {
  fs: InMemoryFs;
  ready: Promise<unknown>;
  resolve: (path: string | undefined) => string;
}): MediaFilePort {
  return {
    async resolve(requestedPath: string): Promise<MediaFileResolution> {
      await workspace.ready;
      let absolute: string;
      try {
        absolute = workspace.resolve(requestedPath);
      } catch {
        return { ok: false, reason: 'outside-workspace' };
      }
      if (!(await workspace.fs.exists(absolute))) return { ok: false, reason: 'not-a-file' };
      if ((await workspace.fs.stat(absolute)).isDirectory) return { ok: false, reason: 'not-a-file' };
      const bytes = await workspace.fs.readFileBuffer(absolute);
      if (bytes.length === 0) return { ok: false, reason: 'empty' };
      // `resolve` guarantees a path under the workspace root, so the last slash
      // is always at a positive index.
      return {
        ok: true,
        path: absolute,
        name: absolute.slice(absolute.lastIndexOf('/') + 1),
        size: bytes.length,
      };
    },
    async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
      return (await workspace.fs.readFileBuffer(path)) as Uint8Array<ArrayBuffer>;
    },
  };
}

/**
 * Build the media tools this turn may call.
 *
 * `allowed` is the producer's list, already filtered through the agent's tool
 * policy — this function only selects, it never grants, exactly as
 * `createGatewayTools` does.
 *
 * `upload_file` is dropped when the turn has no workspace: with no filesystem
 * behind it there is no file it could ever show, and offering the model a tool
 * that can only fail is worse than not offering it.
 */
export function createTurnMediaTools(
  allowed: readonly AgentTurnMediaTool[],
  args: {
    gatewayUrl: string;
    credential: string;
    conversation: AgentTurnConversation;
    workspace: AgentWorkspace | null;
    onFileUploaded: (data: Record<string, unknown>) => void;
  }
): AgentTool[] {
  const wanted = new Set<string>(allowed);
  if (wanted.size === 0) return [];
  const tools = createMediaTools({
    gatewayUrl: args.gatewayUrl,
    workerToken: args.credential,
    channelId: args.conversation.channelId,
    conversationId: args.conversation.conversationId,
    platform: args.conversation.platform,
    // Names the workspace for the tool's prose only; the port is what actually
    // resolves a path on this lane.
    workspaceDir: WORKSPACE_ROOT,
    onFileUploaded: args.onFileUploaded,
    // With no workspace the port can only answer "no workspace", and
    // `upload_file` is dropped from the manifest below rather than offered as a
    // tool that always fails.
    filePort: args.workspace
      ? createWorkspaceFilePort(args.workspace)
      : { resolve: async () => ({ ok: false, reason: 'no-workspace' }), read: async () => new Uint8Array(0) },
  });
  return tools.filter(
    (tool) => wanted.has(tool.name) && (tool.name !== 'upload_file' || args.workspace !== null)
  ) as unknown as AgentTool[];
}
