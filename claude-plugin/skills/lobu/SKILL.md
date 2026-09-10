---
name: lobu
description: Use Lobu MCP for shared, permission-aware company context, durable organizational memory, and governed actions. Trigger when the user asks what the organization knows, needs context from connected company systems, wants to preserve a durable fact or decision, or needs to discover and use Lobu SDK capabilities.
---

# Lobu

Use Lobu for organizational context that must survive one conversation, agent, or local workspace. Keep temporary reasoning, scratch notes, and code changes local.

## Work safely

- Stay within the workspace, identity, permissions, and approval state returned by Lobu.
- Treat Lobu memory as durable, append-only system events. Search before saving so a correction can supersede earlier context instead of duplicating or rewriting history.
- Prefer a read or dry-run path before a write. Never invent an identifier, URL, approval state, or successful side effect.
- Do not attempt to bypass a required approval. Explain what is waiting and what the user must approve.
- Never ask for or expose connector credentials. Lobu brokers authorized access to connected systems.

## Discover before acting

When the right tool or SDK method is unclear:

1. Search existing Lobu memory for relevant company context.
2. Use Lobu's SDK discovery tool before choosing an SDK method.
3. Inspect the result schema and required arguments.
4. Execute the smallest read-only call that proves the path.
5. Only perform a mutation when the user asked for it and any approval requirement is satisfied.

If Lobu authentication is required, let the host complete OAuth in the user's browser. Do not install the Lobu CLI just to use the hosted MCP server. The CLI is for connecting clients or developing and running Lobu projects locally.

Local Automation delivery is a separate opt-in setup and is not enabled by installing Lobu here.

Before requesting connector app credentials, discover `connections.setupOptions` with `search_sdk` and call it in the selected workspace. It returns verified managed OAuth, hosted cloud chat, and local setup choices. Follow the returned URL and instructions; an unavailable cloud lookup is not proof that no managed offer exists. On account-scoped MCP, select an authorized home workspace before calling `connections.connectManaged` against cloud; the provider org is its `managed_by_org` argument. Managed OAuth can support local execution. Hosted Slack chat targets a cloud agent and does not connect an independent embedded runtime.
