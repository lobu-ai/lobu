import path from "node:path";
import { sanitizeConversationId } from "@lobu/core";

/**
 * Generic, provider-agnostic workspace + request hardening shared by every
 * runtime provider. Lifted verbatim from the original Vercel route — the
 * path-escape / token-context checks are security, not Vercel-specific.
 */

export function errorStatus(error: Error): 400 | 500 {
  if (
    error.message === "Invalid agentId" ||
    error.message === "Workspace resolved outside workspaces root" ||
    error.message === "Workspace does not match token conversation context" ||
    error.message === "cwd must stay inside the workspace"
  ) {
    return 400;
  }
  return 500;
}

/**
 * Resolve and validate the local workspace path against the token's agent +
 * conversation. Rejects any request whose `workspaceDir` escapes the agent root
 * or doesn't match the token's conversation context — a worker bearing a
 * same-(org,agent) token cannot reach another conversation's workspace.
 */
export function resolveWorkspacePath(
  agentId: string,
  conversationId: string,
  requestedWorkspaceDir: unknown
): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
    throw new Error("Invalid agentId");
  }
  const root = path.resolve("workspaces");
  const agentRoot = path.resolve(root, agentId);
  const expectedWorkspace = path.resolve(
    agentRoot,
    sanitizeConversationId(conversationId)
  );
  const workspace =
    typeof requestedWorkspaceDir === "string" && requestedWorkspaceDir.trim()
      ? path.resolve(requestedWorkspaceDir)
      : expectedWorkspace;
  if (workspace !== agentRoot && !workspace.startsWith(agentRoot + path.sep)) {
    throw new Error("Workspace resolved outside workspaces root");
  }
  if (workspace !== expectedWorkspace) {
    throw new Error("Workspace does not match token conversation context");
  }
  return workspace;
}

/**
 * Map a worker-requested cwd (local-absolute, relative, or already-remote) onto
 * the provider's remote workspace root, clamped inside it.
 */
export function remoteCwd(
  cwd: unknown,
  workspaceDir: string,
  remoteRoot: string
): string {
  const raw = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "/";
  let rel = raw;
  if (path.isAbsolute(raw)) {
    const absoluteCwd = path.resolve(raw);
    if (absoluteCwd === workspaceDir) {
      rel = "";
    } else if (absoluteCwd.startsWith(workspaceDir + path.sep)) {
      rel = path.relative(workspaceDir, absoluteCwd);
    } else if (raw === remoteRoot || raw.startsWith(`${remoteRoot}/`)) {
      rel = path.posix.relative(remoteRoot, raw);
    } else {
      rel = raw.slice(1);
    }
  }
  const normalized = path.posix.normalize(`/${rel}`).slice(1);
  if (normalized === "" || normalized === ".") return remoteRoot;
  return path.posix.join(remoteRoot, normalized);
}
