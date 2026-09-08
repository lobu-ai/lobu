import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { LOBU_CONFIG_DIR } from "../internal/context.js";
import {
  agentApiBase,
  apiBaseFromContextUrl,
  getActiveOrg,
  getAgentApiToken,
  getCurrentContextName,
  resolveContext,
  resolveGatewayUrl,
} from "../internal/index.js";
import { renderMarkdown } from "../utils/markdown.js";
import { loadProjectConfig } from "./_lib/apply/desired-state.js";
/**
 * How `lobu chat --user <platform>:<id>` addresses a recipient: the request
 * body gets `{ [platform]: { [key]: id } }` (plus `thread` when supported).
 * Only platforms with direct-send support appear here.
 */
const CHAT_TARGETS: Record<
  string,
  { key: string; includeThread?: boolean } | undefined
> = {
  telegram: { key: "chatId" },
  slack: { key: "channel", includeThread: true },
  discord: { key: "channelId" },
};

const THREADS_FILE = join(LOBU_CONFIG_DIR, "threads.json");

async function getLastThread(
  context: string,
  agent: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(THREADS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed[`${context}|${agent}`];
  } catch {
    return undefined;
  }
}

async function setLastThread(
  context: string,
  agent: string,
  threadId: string
): Promise<void> {
  let store: Record<string, string> = {};
  try {
    const raw = await readFile(THREADS_FILE, "utf-8");
    store = JSON.parse(raw) as Record<string, string>;
  } catch {
    // first-write or corrupt; reset
  }
  store[`${context}|${agent}`] = threadId;
  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(THREADS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

interface ChatOptions {
  agent?: string;
  gateway?: string;
  user?: string;
  thread?: string;
  dryRun?: boolean;
  new?: boolean;
  continue?: boolean;
  context?: string;
  org?: string;
  autoApprove?: boolean;
  json?: boolean;
}

/**
 * Resolve which org the chat invocation targets. Precedence mirrors the other
 * org-scoped commands (`lobu memory run`, `lobu call`): explicit `--org` >
 * `LOBU_ORG` env > the context's stored `activeOrg`. `getActiveOrg` already
 * folds in the env var and context lookup, so an explicit flag is the only
 * thing layered on top.
 *
 * Returns `undefined` when nothing is configured — the server then falls back
 * to the PAT-bound org / the user's default membership, preserving the
 * pre-flag semantics for callers that never pass `--org`.
 */
export async function resolveChatOrg(
  options: Pick<ChatOptions, "org" | "context">
): Promise<string | undefined> {
  if (options.org?.trim()) return options.org.trim();
  return getActiveOrg(options.context);
}

/**
 * Build the Authorization header plus an optional `x-lobu-org` override the
 * embedded gateway honors per-request (membership-checked server-side). The
 * header is omitted entirely when no org is resolved, so unflagged invocations
 * are byte-for-byte identical to the previous semantics.
 */
function agentApiHeaders(
  authToken: string,
  org: string | undefined,
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    ...extra,
  };
  if (org) headers["x-lobu-org"] = org;
  return headers;
}

/**
 * `lobu chat <prompt>` — send a prompt to an agent and stream the response.
 *
 * With --user platform:id, routes through Telegram/Slack.
 * With --continue, resumes the last thread for (context, agent).
 */
export async function chatCommand(
  cwd: string,
  prompt: string,
  options: ChatOptions
): Promise<void> {
  let gatewayUrl: string;
  if (options.gateway) {
    gatewayUrl = options.gateway;
  } else {
    // Prefer an explicit `--context` over the active context, but fall back
    // to the active context before defaulting to a local `lobu run`. Without
    // this, `lobu chat` against a remote-context-set CLI silently sent every
    // request to localhost:8787 — failing with `fetch failed` if no local
    // gateway was running, or worse, hitting the wrong instance.
    const ctx = await resolveContext(options.context).catch(() => null);
    gatewayUrl = ctx
      ? apiBaseFromContextUrl(ctx.url)
      : await resolveGatewayUrl({ cwd });
  }
  // The Agent API lives under `<origin>/lobu` on every Lobu deployment; the
  // context apiUrl and `.env` PORT only give the origin.
  gatewayUrl = agentApiBase(gatewayUrl);

  const authToken = await getAgentApiToken(options.context);
  if (!authToken) {
    console.error(
      chalk.red("\n  Session expired or not logged in. Run `lobu login`.\n")
    );
    process.exit(1);
  }

  const agentId = options.agent ?? (await resolveAgentId(cwd));
  const platformUser = options.user ? parsePlatformUser(options.user) : null;
  const contextName = options.context ?? (await getCurrentContextName());
  // Explicit `--org` overrides the context's activeOrg for this invocation
  // only (no config write). Threaded as `x-lobu-org` on every Agent API call.
  const org = await resolveChatOrg(options);

  // Resolve thread: explicit --thread > --continue (last for this agent)
  let threadId = options.thread;
  if (!threadId && options.continue && agentId) {
    threadId = await getLastThread(contextName, agentId);
    if (!threadId) {
      console.error(
        chalk.dim(
          `\n  No prior thread for ${agentId} in context ${contextName}; starting fresh.\n`
        )
      );
    }
  }

  if (platformUser) {
    await sendViaPlatform(gatewayUrl, authToken, {
      agentId,
      platform: platformUser.platform,
      userId: platformUser.userId,
      message: prompt,
      thread: threadId,
      json: options.json,
      org,
    });
  } else {
    await sendViaApi(gatewayUrl, authToken, {
      agentId,
      message: prompt,
      thread: threadId,
      dryRun: options.dryRun,
      forceNew: options.new && !threadId,
      autoApprove: options.autoApprove,
      json: options.json,
      contextName,
      org,
    });
  }
}

function parsePlatformUser(
  user: string
): { platform: string; userId: string } | null {
  const colonIndex = user.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    platform: user.slice(0, colonIndex),
    userId: user.slice(colonIndex + 1),
  };
}

async function sendViaPlatform(
  gatewayUrl: string,
  authToken: string,
  opts: {
    agentId?: string;
    platform: string;
    userId: string;
    message: string;
    thread?: string;
    json?: boolean;
    org?: string;
  }
): Promise<void> {
  const agentId = opts.agentId || `test-${opts.platform}`;
  const body: Record<string, any> = {
    platform: opts.platform,
    content: opts.message,
  };

  const chatTarget = CHAT_TARGETS[opts.platform];
  if (chatTarget) {
    body[opts.platform] = {
      [chatTarget.key]: opts.userId,
      ...(chatTarget.includeThread ? { thread: opts.thread } : {}),
    };
  }

  const res = await fetch(
    `${gatewayUrl}/api/v1/agents/${encodeURIComponent(agentId)}/messages`,
    {
      method: "POST",
      headers: agentApiHeaders(authToken, opts.org, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const resBody = await res.text().catch(() => "");
    console.error(
      chalk.red(`\n  Failed to send message (${res.status}): ${resBody}\n`)
    );
    process.exit(1);
  }

  const result = (await res.json()) as {
    success: boolean;
    agentId?: string;
    messageId?: string;
    eventsUrl?: string;
    queued?: boolean;
  };

  if (result.eventsUrl) {
    const sseUrl = result.eventsUrl.startsWith("http")
      ? result.eventsUrl
      : `${gatewayUrl}${result.eventsUrl}`;

    const sseController = new AbortController();
    await streamResponse(sseUrl, authToken, sseController, {
      expectedMessageId: result.messageId,
      json: opts.json,
      org: opts.org,
    });
  } else {
    console.log(
      chalk.dim(
        `  Message sent via ${opts.platform}. Response will appear on the platform.\n`
      )
    );
  }
}

interface ApiSendOptions {
  agentId?: string;
  message: string;
  thread?: string;
  dryRun?: boolean;
  forceNew?: boolean;
  autoApprove?: boolean;
  json?: boolean;
  contextName?: string;
  org?: string;
}

interface ApiSession {
  agentId: string;
  token: string;
  threadId?: string;
}

async function createSession(
  gatewayUrl: string,
  authToken: string,
  opts: {
    agentId?: string;
    thread?: string;
    dryRun?: boolean;
    forceNew?: boolean;
    org?: string;
  }
): Promise<ApiSession> {
  const createBody: Record<string, any> = {};
  if (opts.agentId) createBody.agentId = opts.agentId;
  if (opts.thread) createBody.thread = opts.thread;
  if (opts.dryRun) createBody.dryRun = true;
  if (opts.forceNew) createBody.forceNew = true;

  const createRes = await fetch(`${gatewayUrl}/api/v1/agents`, {
    method: "POST",
    headers: agentApiHeaders(authToken, opts.org, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(createBody),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    if (createRes.status === 401) {
      console.error(
        chalk.red("\n  Authentication required. Run `lobu login`.\n")
      );
      process.exit(1);
    }
    console.error(
      chalk.red(`\n  Failed to create session (${createRes.status}): ${body}\n`)
    );
    process.exit(1);
  }

  const session = (await createRes.json()) as {
    agentId: string;
    token: string;
    threadId?: string;
    thread?: string;
  };
  return {
    agentId: session.agentId,
    token: session.token,
    threadId: session.threadId ?? session.thread,
  };
}

async function sendViaApi(
  gatewayUrl: string,
  authToken: string,
  opts: ApiSendOptions
): Promise<void> {
  const session = await createSession(gatewayUrl, authToken, {
    agentId: opts.agentId,
    thread: opts.thread,
    dryRun: opts.dryRun,
    forceNew: opts.forceNew,
    org: opts.org,
  });

  const base = `${gatewayUrl}/api/v1/agents/${session.agentId}`;
  const sseUrl = `${base}/events`;
  const messagesUrl = `${base}/messages`;

  const sseController = new AbortController();
  const streaming = streamResponse(sseUrl, session.token, sseController, {
    autoApprove: opts.autoApprove,
    json: opts.json,
    org: opts.org,
  });

  const msgRes = await fetch(messagesUrl, {
    method: "POST",
    headers: agentApiHeaders(session.token, opts.org, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ content: opts.message }),
  });

  if (!msgRes.ok) {
    sseController.abort();
    const body = await msgRes.text().catch(() => "");
    console.error(
      chalk.red(`\n  Failed to send message (${msgRes.status}): ${body}\n`)
    );
    process.exit(1);
  }

  await streaming;

  if (opts.contextName && session.threadId) {
    await setLastThread(opts.contextName, session.agentId, session.threadId);
  }
}

async function resolveAgentId(cwd: string): Promise<string | undefined> {
  try {
    const { project } = await loadProjectConfig(cwd);
    return project.agents[0]?.id;
  } catch {
    return undefined;
  }
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function writeStderr(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

interface StreamOptions {
  expectedMessageId?: string;
  autoApprove?: boolean;
  json?: boolean;
  org?: string;
}

// Ten minutes of the agent saying nothing at all. Comfortably clears a chain
// of `os.shell` calls at their 150s ceiling plus model latency, while still
// bounding a run that died server-side without a terminal event — the case
// the gateway's unconditional 30s heartbeat would otherwise mask forever.
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function resolveIdleTimeoutMs(): number {
  const raw = process.env.LOBU_CHAT_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_IDLE_TIMEOUT_MS;
}

async function streamResponse(
  sseUrl: string,
  token: string,
  controller: AbortController,
  options: StreamOptions = {}
): Promise<void> {
  // How long the AGENT may go quiet, not the socket.
  //
  // The distinction is the whole design. The gateway heartbeats a `ping` every
  // 30s for as long as the connection is open, whether or not a run is still
  // alive (routes/public/agent.ts), so a deadline reset by any traffic would
  // be held open forever by heartbeats alone if a run died without emitting a
  // terminal event. Only substantive events postpone it.
  //
  // Correspondingly generous: a single `os.shell` call may legitimately run
  // 150s with nothing to report, and an agent can chain several. A dead
  // TRANSPORT does not need this timer at all — the socket dropping rejects
  // `reader.read()` and surfaces immediately.
  const IDLE_TIMEOUT_MS = resolveIdleTimeoutMs();

  let idleTimedOut = false;
  const abortIdle = () => {
    idleTimedOut = true;
    controller.abort();
  };

  // A budget of network silence, spent only while actually waiting on the
  // socket and refilled only by the agent saying something.
  //
  // It has to be a budget rather than a deadline measured from the last event.
  // Heartbeats mean many short waits rather than one long one, so each wait
  // must draw down a shared allowance instead of restarting a full one — and
  // wall-clock since the last event would charge the budget for time spent
  // rendering output or waiting for a human at an approval prompt, aborting a
  // perfectly healthy turn.
  let idleBudgetMs = IDLE_TIMEOUT_MS;

  /** A `ping` is the connection talking, not the agent; it refills nothing. */
  const noteAgentActivity = (event: string) => {
    if (event !== "ping") idleBudgetMs = IDLE_TIMEOUT_MS;
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdleTimer = () => {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const waitForStream = async <T>(operation: Promise<T>): Promise<T> => {
    clearIdleTimer();
    const waitStartedAt = Date.now();
    idleTimer = setTimeout(abortIdle, idleBudgetMs);
    try {
      return await operation;
    } finally {
      clearIdleTimer();
      // Charge only the time spent inside this wait. Everything after it —
      // rendering to stdout, a human answering a tool-approval prompt — is
      // this client being slow, not the agent going quiet.
      idleBudgetMs = Math.max(0, idleBudgetMs - (Date.now() - waitStartedAt));
    }
  };

  // Tracked across try/finally so we can cancel the body stream on early
  // `return` paths (complete / error / ephemeral). Without this, the reader
  // holds the lock and the SSE connection stays open until GC.
  let readerForCleanup: { cancel(reason?: unknown): Promise<void> } | undefined;

  try {
    const res = await waitForStream(
      fetch(sseUrl, {
        headers: agentApiHeaders(token, options.org),
        signal: controller.signal,
      })
    );

    if (!res.ok || !res.body) {
      console.error(chalk.red(`\n  SSE connection failed (${res.status})\n`));
      process.exit(1);
    }

    const reader = res.body.getReader();
    readerForCleanup = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let sawFileUploadedEvent = false;
    let sawSandboxLink = false;

    while (true) {
      const { done, value } = await waitForStream(reader.read());
      if (done) {
        await writeStderr(
          chalk.red(
            "\n  Stream closed before the agent finished. The turn may still be running server-side.\n"
          )
        );
        process.exitCode = 1;
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          noteAgentActivity(currentEvent);
        } else if (line.startsWith("data: ") && currentEvent) {
          const data = parseJSON(line.slice(6));
          if (!data) continue;
          if (
            options.expectedMessageId &&
            currentEvent !== "connected" &&
            currentEvent !== "ping" &&
            typeof data.messageId === "string" &&
            data.messageId !== options.expectedMessageId
          ) {
            currentEvent = "";
            continue;
          }

          if (options.json) {
            await writeStdout(
              `${JSON.stringify({ event: currentEvent, ...data })}\n`
            );
            if (currentEvent === "complete" || currentEvent === "error") {
              if (currentEvent === "error") process.exitCode = 1;
              controller.abort();
              return;
            }
            currentEvent = "";
            continue;
          }

          switch (currentEvent) {
            case "output":
              if (typeof data.content === "string") {
                if (data.content.includes("sandbox:/")) {
                  sawSandboxLink = true;
                }
                await writeStdout(data.content);
              }
              break;
            case "ephemeral":
              if (typeof data.content === "string") {
                await writeStderr(`\n${renderMarkdown(data.content)}\n`);
              }
              controller.abort();
              return;
            case "tool-approval": {
              const args = data.args as Record<string, unknown> | undefined;
              const argsText = args
                ? Object.entries(args)
                    .map(
                      ([k, v]) =>
                        `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
                    )
                    .join("\n")
                : "";
              await writeStderr(
                chalk.yellow(
                  `\n  Tool Approval Required\n  ${data.mcpId} → ${data.toolName}\n${argsText}\n`
                )
              );

              let decision: string;
              if (options.autoApprove) {
                decision = "always";
                await writeStderr(
                  chalk.dim("\n  --auto-approve: approving (always).\n")
                );
              } else {
                const choices = ["1h", "24h", "always", "deny"];
                const labels: Record<string, string> = {
                  "1h": "1h",
                  "24h": "24h",
                  always: "always",
                  deny: "deny always",
                };
                await writeStderr(
                  `${choices
                    .map(
                      (o, i) =>
                        `  ${chalk.bold(`${i + 1}`)}. ${o === "deny" ? chalk.red(labels[o]) : chalk.green(labels[o])}`
                    )
                    .join("\n")}\n`
                );

                const rl = createInterface({
                  input: process.stdin,
                  output: process.stderr,
                });
                const answer = await new Promise<string>((resolve) =>
                  rl.question(chalk.dim("\n  Choice (1-4): "), (a) => {
                    rl.close();
                    resolve(a.trim());
                  })
                );
                const idx = Number.parseInt(answer, 10) - 1;
                decision = choices[idx] || "deny";
              }

              const approveUrl = sseUrl
                .replace(/\/events$/, "")
                .replace(/\/api\/v1\/agents\/[^/]+/, "/api/v1/agents/approve");
              const approveRes = await fetch(approveUrl, {
                method: "POST",
                headers: agentApiHeaders(token, options.org, {
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({ requestId: data.requestId, decision }),
              });
              if (approveRes.ok) {
                const result = (await approveRes.json()) as any;
                if (result.result?.content) {
                  const text = result.result.content
                    .map((c: any) => c.text)
                    .join("\n");
                  await writeStdout(renderMarkdown(text));
                }
                await writeStderr(
                  chalk.green(
                    `\n  Tool ${decision === "deny" ? "denied" : "approved"} (${decision})\n`
                  )
                );
              } else {
                await writeStderr(
                  chalk.red(`\n  Approval failed: ${await approveRes.text()}\n`)
                );
              }
              break;
            }
            case "link-button":
            case "question":
            case "suggestion":
            case "file-uploaded":
              if (currentEvent === "file-uploaded") {
                sawFileUploadedEvent = true;
              }
              await writeStderr(
                `${JSON.stringify({ event: currentEvent, ...data })}\n`
              );
              break;
            case "complete":
              await writeStdout("\n");
              if (sawSandboxLink && !sawFileUploadedEvent) {
                await writeStderr(
                  chalk.red(
                    "\n  Warning: assistant output contained a sandbox/local file link, but no file-uploaded event was emitted. Treat this as a failed file-delivery attempt.\n"
                  )
                );
              }
              controller.abort();
              return;
            case "error":
              await writeStdout("\n");
              await writeStderr(
                chalk.red(`\n  Agent error: ${String(data.error)}\n`)
              );
              // Surface the failure to the shell — a script wrapping `lobu chat`
              // must not see exit 0 when the agent run errored.
              process.exitCode = 1;
              controller.abort();
              return;
          }

          currentEvent = "";
        } else if (line === "") {
          currentEvent = "";
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      // Every terminal event (complete / error / ephemeral) aborts deliberately
      // before returning, so an abort we did not schedule is a stalled stream.
      // Reporting it as success would tell a wrapping script the turn finished.
      if (!idleTimedOut) return;
      const timeoutLabel =
        IDLE_TIMEOUT_MS % 1000 === 0
          ? `${IDLE_TIMEOUT_MS / 1000}s`
          : `${IDLE_TIMEOUT_MS}ms`;
      await writeStderr(
        chalk.red(
          `\n  Stream timed out: no data from the agent for ${timeoutLabel}. The turn may still be running server-side.\n`
        )
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    clearIdleTimer();
    if (readerForCleanup) {
      // Cancel the body stream so the underlying connection is released
      // immediately on early return — otherwise the lock stays held until GC.
      await readerForCleanup.cancel().catch(() => undefined);
    }
  }
}

function parseJSON(str: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(str);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
