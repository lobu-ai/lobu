# Chat turns act in the sender's workspaces

Status: accepted design (confirmed 2026-10-15), not yet implemented. It changes
the chat turn-token contract. It adds no table, no SDK method and no public API.

Evidence checked on 2026-10-15 against `origin/main` at
[`9ac7d26500227d09ec0c52fa5468ba7e2ca78472`](https://github.com/lobu-ai/lobu/tree/9ac7d26500227d09ec0c52fa5468ba7e2ca78472).
Revalidate this baseline before implementation.

## Problem

A chat bot connection belongs to one workspace. Every turn it runs can only
read and act in one workspace: the workspace of the Automation that matched
the message, or the bot's own workspace when no Automation matched.

So a linked member who messages the team WhatsApp bot "add this to my calendar"
cannot reach their personal workspace, even though they are a member there and
an external MCP client signed in as the same person can. The only ways around
this today are a second bot per workspace, or a cross-workspace `/lobu link`
chat-link Automation on a preview bot. Both bind the conversation to one other
workspace instead of following the person.

Making Automations the routing table for conversations also caused the
2026-10-15 duplicate replies: two workspaces each linked the same Slack DM, and
both answered.

## What exists today

| Piece | Where | What it does |
| --- | --- | --- |
| Turn token | `mintTurnToken`, `gateway/orchestration/agent-turn-producer.ts` | Signs a single `organizationId` plus the sender's `chatAccess` tier and `actorUserId`. |
| Sender tier | `resolveChatTurnActor`, `chat-turn-actor.ts` | Checks membership in that one workspace only (`member` / `org_shared` / `public_visitor` / `reply_only`). |
| Workspace check | `workspace/multi-tenant.ts` | Rejects any workspace other than the token's own ("Worker token is not valid for this organization"). Then grants exactly `[requestedOrgId]`. |
| Agent-bound restriction | `restrictBoundIdentityWorkspaceAccess` (`mcp-handler.ts`), `identityBound` (`tools/execute.ts`) | Switches cross-workspace off whenever an `agentId` is bound. So `client.org(slug)` throws `CrossOrgAccessDenied`, and `search_memory`'s `workspace` argument only accepts the bound workspace. |
| Multi-workspace model | External OAuth `/mcp` | `grantedOrganizationIds`, `client.org(slug)`, and the `workspace` argument already work for external MCP clients. |
| Preview bots | `previewMode`, `crossOrganization` routing in `message-handler-bridge.ts` | Choose which single workspace a turn runs in. Never give a turn more than one. |

## Decision

The workspaces a turn can reach follow **the sender**, not the bot, under two
conditions: the sender is a linked member, and the conversation is private.

1. **Who qualifies.**
   - The sender tier in the home workspace is `member`. The home workspace is the one today's routing already picks: the Automation's, or the bot's.
   - The conversation is a direct message: the Chat SDK thread's `isDM`, the same structured value the bridge already uses.
   - Group channels, threads in channels, and every other tier (`org_shared`, `public_visitor`, `reply_only`) keep today's single-workspace scope. Replies in a channel are visible to everyone in it, so pulling in another workspace's data there would leak it.
2. **What the turn token carries.**
   - For a qualifying turn, the token grants the home workspace (still the default for every call) plus the workspaces where the linked user is a member.
   - The actor is the sender in every workspace, with that sender's own role there.
   - The model, provider and billing remain the home workspace's agent. Only data and actions cross.
3. **Enforcement reuses the external-MCP path.**
   - `multi-tenant.ts` accepts any workspace in the token's grant.
   - The agent-bound restriction allows cross-workspace calls only when the grant lists more than one workspace.
   - `client.org(slug)` and the `workspace` argument then behave exactly as they do for an OAuth MCP client.
4. **Each target workspace keeps its own rules.**
   - Connector policy (`evaluateConnectorPolicy`), approvals, resource ACLs and audit apply in the workspace where an action runs. Crossing in from chat never bypasses them.
   - Approvals that need a human session stay human-session-only.
5. **Membership is read at request time.** The token carries the user and the home workspace. The grant is resolved against `member` rows when a call names another workspace, so a membership change takes effect immediately and the token stays small.

## What does not change

- Automations stay workflows ("when a message arrives in #support, triage it").
  They are no longer the only way a direct message reaches a member's data.
- How group channels are handled, sender tiers, rate limits and the unlinked-sender
  notice.
- No new tables, columns, SDK methods or public routes.

## What this lets us delete later

- Cross-workspace `/lobu link` chat-link Automations whose only purpose is to
  point a DM at another workspace. They become optional. Removing them is a
  separate change, after usage is measured.

## Open questions to settle in the implementation PR

1. **Per-workspace opt-out.** Can a member keep a workspace out of chat reach?
   Proposed default: on. An opt-out can reuse the existing policy rows, not a
   new table.
2. **Agent instructions.** The turn's system context should name the home
   workspace and say that others are reachable on request, so the model does
   not wander across workspaces unprompted.

## Verification plan

- **Integration test.** A member DM on a bot in workspace A calls `client.org('B')`, where the sender is a member of B, and succeeds as the sender. The same call from a group channel, or from an `org_shared` sender, is refused.
- **Policy test.** An action in B gated by B's connector policy still asks or blocks per B's rules.
- **Live check.** A WhatsApp or Slack DM to a team bot asks for something in the sender's personal workspace and gets it.
