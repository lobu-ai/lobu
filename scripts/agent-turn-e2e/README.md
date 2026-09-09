# Agent-turn live e2e (isolate lane)

Boots a real `lobu run` from this checkout (embedded Postgres, the isolate
lane, the real MCP route) against a scripted OpenAI-compatible mock and drives
turns over the Direct API. Every assertion reads the durable record (`runs`,
`thread_response` rows, `agent_transcript_snapshot`) or the mock's request log
(what the model was actually sent), never the chat SSE stream.

## Run it

```sh
# once: the CLI dist must carry the current server bundle and guest bundle
(cd packages/server && bun run build:server) && (cd packages/cli && bun run build)

bash scripts/agent-turn-e2e/agent-turn-e2e.sh          # ~4 min, exit 0 on all green
HOLD=1 bash scripts/agent-turn-e2e/agent-turn-e2e.sh   # keep the gateway up; `source run/env.sh`
```

Ports: gateway 8795, embedded Postgres 59201, mock 11634 (`GW_PORT`,
`PG_PORT`, `MOCK_PORT`). Everything lands under `scripts/agent-turn-e2e/run/`
(git-ignored): `run.log`, `model-requests.jsonl`, per-scenario result files.

## Scenarios

| | What it proves | Durable evidence |
|---|---|---|
| A | The composed system prompt ends with `Current date: <UTC today>` | mock request log |
| B | A follow-up sent during a session's FIRST turn is steered into the running turn and ONE `finalText` carries both answers | follower run `consumed_by_run_id`, never claimed; one `thread_response` row |
| B2 | Same, in a warmed conversation | same |
| C | A retrieval tool call opts into `x-mcp-format: json`; the persisted `tool_use` event carries `result_summary` with snippets | `thread_response` customEvent row; the JSON the guest received |
| D | The 50-call tool budget stops the turn and the settled narration is delivered, not `""` | `finalText`, 51 tool_use rows |
| E | A session snapshot over the 4 MiB cap is trimmed to its latest compaction; the next turn hydrates the trimmed session | `agent_transcript_snapshot` row, model request, gateway log line |

Mock markers, read from the last user message: `[SLOW:<ms>]` streams the
answer word by word, `[DELAY:<ms>]` holds it, `[TOOL:search_memory q=<q>]`
and `[SAVE:<title>|<content>]` issue one tool call first, `[LOOP]` calls a
tool on every round. Anything else answers `ECHO[<user text>]`.

## What the first live runs found (2026-09-09, PR #3402)

- Steering never fired on a session's first turn: `executionPolicy()` compared
  `ephemeral_context`, and the Direct API route attaches a changing
  workspace-attention block there. Fixed on the branch (strip the per-message
  field from the policy comparison). Scenario B is the regression check.
- Agent memory recall is fenced to `events.metadata->>'agent_id' = <agent>`
  (search.ts `agentIdScope`), and no save path stamped that scope, so an agent
  could not recall what it had just saved through the tool. Pre-existing on
  main; FIXED on the branch — `save_content.ts` now stamps the scope from the
  bound tool context, which is what `ContentSearchFilters.agent_id` already
  documented ("populated automatically by Lobu-owned save paths"). Scenario C
  asserts both halves: the agent-saved row carries the scope, and a PAT-saved
  row carries none.
- Saved memory stays `indexing_status: pending` until the embed backfill cron
  (`*/5`) runs. The harness enqueues an `embed_backfill` run row directly.

## Open items for whoever picks this up

1. The chat identity block (Slack/Telegram instruction providers) is only
   covered by the fake-provider producer test; the `api` platform registers no
   provider, so this harness cannot see it. One live Slack turn on staging is
   still owed.
2. Consider folding this into `scripts/sdk-e2e.sh` or CI once the runtime is
   stable; it is deliberately separate for now because it needs the built CLI
   dist and takes ~4 minutes.
