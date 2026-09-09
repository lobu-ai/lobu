// Scripted OpenAI-compatible mock for the agent-turn e2e. What it does is chosen
// per request from markers in the LAST user message, so one server serves every
// scenario:
//   [DELAY:<ms>]                 hold the answer open for <ms> before the text
//   [TOOL:search_memory q=<q>]   first round: call search_memory({query:q}); after
//                                the tool result: the echo answer
//   [LOOP]                       every round: narrate "Still looking (n)" and call
//                                search_memory again (exercises the tool budget)
//   otherwise                    ECHO[<last user text>]
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 11634);
const REQLOG = process.env.MOCK_REQLOG || "";

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
          .join("")
      : "";
const lastUser = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user") return textOf(messages[i].content);
  return "";
};
// The guest prepends transient context ("Context for this message: …") as its
// own text block; the user's words are the LAST block. Echo those.
const lastUserBlock = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (Array.isArray(m.content)) {
      const texts = m.content
        .filter((p) => p && typeof p === "object" && typeof p.text === "string")
        .map((p) => p.text);
      return texts.at(-1) ?? textOf(m.content);
    }
    return textOf(m.content);
  }
  return "";
};
// Tool results that belong to the CURRENT turn: those after the last user message.
// (Earlier turns' tool rounds are replayed as history and must not count.)
const toolResults = (messages) => {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  return messages.slice(lastUser + 1).filter((m) => m?.role === "tool").length;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const url = req.url || "";
    if (url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-model", object: "model" }],
        })
      );
      return;
    }
    if (!url.includes("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (REQLOG)
      appendFileSync(
        REQLOG,
        `${JSON.stringify({ at: Date.now(), url, body })}\n`
      );
    let request = {};
    try {
      request = JSON.parse(body || "{}");
    } catch {
      // A malformed body is the mock's own scripting error, not a case
      // under test: fall through to the empty request and let the
      // scenario's assertion name what was missing.
    }
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const user = lastUser(messages);
    const results = toolResults(messages);

    let delay = 0;
    const delayMatch = /\[DELAY:(\d+)\]/.exec(user);
    if (delayMatch) delay = Number(delayMatch[1]);
    // [SLOW:<ms>] streams the answer one word at a time over <ms>, so the turn
    // keeps producing deltas (and heartbeats) while a follow-up arrives.
    let slow = 0;
    const slowMatch = /\[SLOW:(\d+)\]/.exec(user);
    if (slowMatch) slow = Number(slowMatch[1]);
    const toolMatch = /\[TOOL:search_memory q=([^\]]+)\]/.exec(user);
    // [SAVE:<title>|<content>] first round: call save_memory so the memory is
    // written BY the agent (content recall is fenced to the calling agent's own
    // saved events); after the tool result: the echo answer.
    const saveMatch = /\[SAVE:([^|\]]+)\|([^\]]+)\]/.exec(user);
    const loop = user.includes("[LOOP]");

    let text = `ECHO[${lastUserBlock(messages).replace(/\s+/g, " ").trim().slice(0, 120)}]`;
    let toolCall = null;
    if (loop) {
      text = `Still looking (${results + 1})`;
      toolCall = {
        id: `call_loop_${results + 1}`,
        name: "search_memory",
        arguments: JSON.stringify({ query: "loop" }),
      };
    } else if (toolMatch && results === 0) {
      text = "";
      toolCall = {
        id: "call_1",
        name: "search_memory",
        arguments: JSON.stringify({ query: toolMatch[1].trim() }),
      };
    } else if (saveMatch && results === 0) {
      text = "";
      toolCall = {
        id: "call_save_1",
        name: "save_memory",
        arguments: JSON.stringify({
          title: saveMatch[1].trim(),
          content: saveMatch[2].trim(),
          semantic_type: "summary",
        }),
      };
    }

    if (request.stream === true) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const id = "chatcmpl-mock";
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
      res.write(chunk({ role: "assistant" }));
      if (delay) await sleep(delay);
      if (slow && text) {
        const words = text.split(" ");
        for (const [i, word] of words.entries()) {
          res.write(chunk({ content: i === 0 ? word : ` ${word}` }));
          await sleep(Math.max(50, Math.floor(slow / words.length)));
        }
      } else if (text) res.write(chunk({ content: text }));
      if (toolCall) {
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.name, arguments: "" },
              },
            ],
          })
        );
        res.write(
          chunk({
            tool_calls: [
              { index: 0, function: { arguments: toolCall.arguments } },
            ],
          })
        );
      }
      res.write(chunk({}, toolCall ? "tool_calls" : "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (delay) await sleep(delay);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || null,
              ...(toolCall
                ? {
                    tool_calls: [
                      {
                        id: toolCall.id,
                        type: "function",
                        function: {
                          name: toolCall.name,
                          arguments: toolCall.arguments,
                        },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`[agent-turn-e2e mock] listening on 127.0.0.1:${PORT}`)
);
