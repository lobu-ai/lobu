# Chat cards for kind-bearing notifications

## Problem

Connector-operation approvals arrived in Slack as bare text:

> Action "run" needs approval
> A queued action on Mac Shell is waiting for your review.

Never *which* operation, on *which* connection, with *what* input — so the
decision could not be made from the notification.

## One pipeline: kind -> json_template -> card

Every notification that names a `semanticType` now resolves an event kind the
normal way (`resolveEventKindDefinition`) and renders its `json_template` in
chat through the same walker the web and MCP surfaces use. When a kind declares
no template, `resolveEntityRender` synthesizes the default field table from the
kind's `metadataSchema` — again the same path the other surfaces take — so the
three surfaces cannot drift apart by construction.

The template semantics live in **`@lobu/core/json-template`**: `walkTemplate`
owns path resolution, `if` truthiness, `each` scoping, the `{{path}}` /
`"a/{{b}}"` binding forms, and `formatValue` (currency/date/url/enum/boolean/
number formatting) so the formatting of a bound scalar agrees everywhere. The
server's `validate-json-template` imports the same directive set rather than
keeping its own copy.

`notifications/template-card.ts` is only a *visitor* over that tree: it decides
how a node becomes Slack/Teams/GChat content. The structural nodes are shared;
the component vocabulary stays open (the server validates, not allowlists,
component types), and chat maps the components it has an equivalent for —
buttons, link buttons, selects, images, fields, tables, dividers, text-ish
leaves — to Block Kit. A component chat cannot draw (`entity-board`, charts) is
collected as `unsupported` and the card links out to the full record instead of
silently showing a subset. The same rule covers template-declared controls: a
button whose action nothing in the interaction bridge routes is dropped with a
note rather than drawn dead.

## Platform notification kinds

`utils/platform-notification-kinds.ts` declares the kinds the platform emits, consulted
as the **last** resort in `resolveEventKindDefinition` so an org that declares
the same slug still wins. Each kind declares a `metadataSchema` (and, where the
interesting content is a list, a hand-authored `jsonTemplate`):

- `connector_operation_approval` — operation, connection, input; schema-only.
- `entity_change_approval` — the proposed fields / before-after diffs; authors a
  `jsonTemplate` because a list is what `each` exists for.
- `connection_authorization_needed`, `browser_session_expired`,
  `invitation_received` — a handful of scalars, schema-only.

Because the kind is resolved the normal way, the Memory view and MCP apps pick
up the same rendering with no extra work. `triggers.ts` stamps the semantic
type, payload, and (for the two approval families) `decisionRunId`; connector
operations are keyed on the explicit `operation` argument, not on the absence
of `details` (builder runs such as `manage_automations` also arrive without
`details` but are not chat-decidable).

## Slack output

```
Action "run" needs approval
A queued action on Mac Shell is waiting for your review.

Operation    Run shell command
Connection   Mac Shell
Input        Command: git status --porcelain; Cwd: /synthetic/project

[Approve] [Reject] [Review in Lobu]
```

## Deciding from chat

`resolveEntityApprovalRun` in `interaction-bridge.ts` is the allowlist of runs a
chat click may decide; it now admits `run_type = 'action'` alongside the
entity-change family. The click still resolves the Slack identity to an org
admin/owner and executes through `manage_operations approve|reject` with the
real process env, exactly as the web review does; `action_input.owner_user_id`
is only read for entity-change runs, never for a connector operation whose
input the agent authored. `approval-decision-scope.test.ts` pins the boundary
against a real DB.
