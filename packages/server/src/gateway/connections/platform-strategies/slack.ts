/**
 * Slack response strategy + the Slack-only text utilities it depends on
 * (HTML-entity decoding, empty-link stripping, paragraph-boundary chunking).
 * Lives in its own module so the default strategy in `./index.ts` stays
 * platform-clean.
 */

import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../../infrastructure/queue/index.js";
import { QueueTerminalError } from "../../infrastructure/queue/types.js";
import { AsyncPushIterator } from "./async-push-iterator.js";
import type {
  PlatformResponseStrategy,
  ResolveTarget,
  StrategyContext,
  StreamState,
} from "./types.js";

const logger = createLogger("platform-response-strategies");

/**
 * Decode HTML entities back to their literal characters. Slack's `chat.postMessage`
 * `text` field auto-escapes `<`, `>`, `&` and re-rendering already-escaped content
 * (e.g. text the worker streamed via the SDK that came back through history) leaves
 * `&gt;` etc. visible to the user. Use the `markdown_text` field for a Slack post
 * so Slack does not double-escape, and pre-decode to handle entities the worker
 * may have produced upstream (e.g. from MCP tool results that returned HTML).
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Strip empty markdown links `[text]()` → `text`. Some MCP tools (notably
 * deepwiki) emit citation footnotes with no URL; rendering them as links
 * leaves visible empty parens in Slack/Telegram.
 */
function stripEmptyLinks(input: string): string {
  return input.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
}

/**
 * Slack accepts up to 12,000 chars per `markdown_text` post. Keep a margin so
 * downstream emoji/mention expansion does not push us over the limit.
 */
const SLACK_MARKDOWN_CHUNK_SIZE = 11_000;

/**
 * Split text on paragraph boundaries (`\n\n`) so we never break mid-sentence,
 * mid-list, or mid-code-fence when posting multiple chunks. Long paragraphs
 * that exceed the limit on their own fall back to line boundaries, then to
 * a hard slice as last resort.
 */
function chunkOnParagraphBoundaries(
  text: string,
  maxChunkSize: number
): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  const pushOversized = (chunk: string) => {
    // Try line boundaries first, then hard slice as a last resort.
    const lines = chunk.split("\n");
    let buf = "";
    for (const line of lines) {
      if (buf.length + line.length + 1 > maxChunkSize) {
        if (buf) chunks.push(buf);
        buf = "";
        if (line.length > maxChunkSize) {
          for (let i = 0; i < line.length; i += maxChunkSize) {
            const slice = line.slice(i, i + maxChunkSize);
            if (i + maxChunkSize >= line.length) {
              buf = slice;
            } else {
              chunks.push(slice);
            }
          }
        } else {
          buf = line;
        }
      } else {
        buf = buf ? `${buf}\n${line}` : line;
      }
    }
    if (buf) chunks.push(buf);
  };

  for (const para of paragraphs) {
    if (para.length > maxChunkSize) {
      flush();
      pushOversized(para);
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChunkSize) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

/**
 * Post a text body to a Slack channel/thread using `chat.postMessage` with
 * `markdown_text`, so Slack renders markdown directly and does not HTML-escape
 * `<`, `>`, `&`. Splits long bodies on paragraph boundaries to avoid hitting
 * Slack's 12,000-char per-post limit.
 *
 * Returns true if the post was handled here, false if the caller should fall
 * back to the SDK's generic `target.post()` path.
 */
async function postSlackMarkdown(
  instance: any,
  channelId: string,
  conversationId: string | undefined,
  body: string
): Promise<boolean> {
  const adapter = instance.chat?.getAdapter?.("slack");
  const slackClient = adapter?.client;
  if (!slackClient?.chat?.postMessage) return false;

  // channelId looks like "slack:C0123ABCD"; conversationId either equals it
  // (DM/channel-level) or is "slack:C0123ABCD:1700000000.123456" for a thread.
  const channel = channelId.startsWith("slack:")
    ? channelId.slice("slack:".length)
    : channelId;
  let thread_ts: string | undefined;
  if (conversationId && conversationId !== channelId) {
    const parts = conversationId.split(":");
    if (parts.length === 3 && parts[0] === "slack") {
      thread_ts = parts[2];
    }
  }

  const chunks = chunkOnParagraphBoundaries(body, SLACK_MARKDOWN_CHUNK_SIZE);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await slackClient.chat.postMessage({
      channel,
      ...(thread_ts ? { thread_ts } : {}),
      markdown_text: chunk,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
  return true;
}

/**
 * Slack strategy: skip the SDK streaming path entirely and post a single
 * chunked `markdown_text` message at completion. The Slack streaming API
 * (`chat.appendStream`) auto-splits at fixed sizes (breaking mid-line) and
 * the regular `chat.postMessage` `text` field HTML-escapes `<`/`>`/`&`.
 * Buffer-and-post on completion gives us paragraph-aligned chunks AND
 * markdown-native rendering.
 */
export class SlackResponseStrategy implements PlatformResponseStrategy {
  // Slack never streams live — it buffers deltas and posts once at completion.
  // So it renders from the worker's authoritative `payload.finalText`, which
  // makes the terminal row self-contained and correct under N>1 replicas (where
  // delta rows scatter across pods and no single replica holds the full buffer).
  readonly deliversAtCompletion = true;

  async disposeOnFullReplacement(_existing: StreamState): Promise<void> {
    // Slack never opens a real streaming target — no async teardown needed.
    // The bridge simply drops the prior state so the next delta opens a
    // fresh buffer (matching pre-strategy semantics: `this.streams.delete`).
  }

  async handleDelta({
    payload,
    existing,
    resolveTarget,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    existing: StreamState | undefined;
    resolveTarget: ResolveTarget;
  }): Promise<StreamState | null> {
    if (existing) {
      existing.buffer += payload.delta as string;
      if (payload.isFullReplacement) existing.wasFullyReplaced = true;
      return existing;
    }

    // Resolve the SDK target up front so that if `postSlackMarkdown`
    // can't reach `slackClient.chat.postMessage` at completion (adapter
    // not wired, getAdapter returns undefined, etc.) we still have a
    // non-null fallback and the response doesn't silently disappear.
    const fallbackTarget = await resolveTarget().catch(() => null);
    const iterator = new AsyncPushIterator<string>();
    // Close immediately — we never feed this iterator; completion uses the
    // buffered-post path. Keeping an open iterator around would leak.
    iterator.close();
    return {
      iterator,
      streamPromise: Promise.resolve(),
      buffer: payload.delta as string,
      streamFailed: true, // Force completion to use the post-buffer path
      wasFullyReplaced: !!payload.isFullReplacement,
      target: fallbackTarget,
    };
  }

  async handleCompletion({
    ctx,
    payload,
    stream,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    stream: StreamState | null;
  }): Promise<void> {
    const { connectionId, instance, channelId } = ctx;
    // Prefer the worker's authoritative full text. `stream?.buffer` is only the
    // subset of deltas THIS replica claimed (or absent entirely cross-pod), so
    // it's not trustworthy under N>1 — finalText is. Fall back to the buffer
    // only when finalText is absent (e.g. a pre-finalText worker).
    const text = payload.finalText ?? stream?.buffer ?? "";
    if (!text.trim()) return;

    const cleaned = stripEmptyLinks(decodeHtmlEntities(text));
    let handled: boolean;
    try {
      handled = await postSlackMarkdown(
        instance,
        channelId,
        payload.conversationId,
        cleaned
      );
    } catch (error) {
      throw new QueueTerminalError("Slack response delivery failed", { cause: error });
    }
    if (!handled) {
      // Fall back only before a send was attempted. Reposting after a rejected
      // request can duplicate accepted chunks or an unacknowledged message.
      if (!stream?.target) throw new Error("No Slack response delivery target");
      try {
        await stream.target.post(cleaned);
      } catch (error) {
        throw new QueueTerminalError("Slack response delivery failed", { cause: error });
      }
    }
    logger.info(
      { connectionId, channelId, length: cleaned.length },
      "Posted Slack response with paragraph chunking or SDK fallback"
    );
  }
}
