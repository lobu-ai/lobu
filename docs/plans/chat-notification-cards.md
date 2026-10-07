# Chat presentation for events

`notifications/event-card.ts` builds the shared presentation for explicit event
posts, kind-bearing notification delivery, queued event refreshes, and native
approval questions. Custom events show a short summary and a canonical
**Open event** link to the full event and its React UI. Chat does not interpret
event-kind JSON templates or render arbitrary custom interaction buttons.

Native approvals retain their server-owned `decisionRunId` controls and the
operation, connection, and input evidence needed to decide. Authorization,
browser-session, and invitation notices retain their original destination.
Input-required questions continue to open the full review UI.

Summaries and titles are bounded for Slack, Discord, and Google Chat. If native
approval evidence exceeds the safe card budget, the card links to the full review
without offering a decision on truncated evidence. Existing approval authorization
and `manage_operations approve|reject` routing remain unchanged.

Delivery keeps Postgres coordination, destination receipts, idempotent retries,
and locked refreshes of the latest event version. Kind-bearing notifications
rebuild the shared presentation rather than reusing stored custom cards.

The chat template interpreter has been deleted. General entity/list templates
and historical event rendering remain active on the web and MCP surfaces.
Historical event conversion, reconciliation of previously delivered controls,
and removal of the old event-action and refresh paths are separate remaining
retirement steps.
