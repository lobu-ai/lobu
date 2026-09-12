# WhatsApp live delivery through existing feeds

Implementation in progress. Live provider proof, review, CI and release are still required.

WhatsApp messages enter the existing `whatsapp.web.messages` feed and Automation subscriptions. There is no new subscription registry, scheduler, event bus, HTTP endpoint or SQL table.

```text
WhatsApp Web collection changes
  -> connector-owned page adapter normalizes the source record
  -> generic extension transport persists the record and notifies worker poll
  -> shared server scheduling marks the existing feed due
  -> normal connector sync merges current source, history and buffered records
  -> existing ingestion and Automation subscriptions
```

The WhatsApp implementation stays in `packages/connectors`. The extension owns only the reusable browser transport. The server owns generic device authorization, scheduling and completion. GitHub's two provider-specific ingress selectors use the same scheduling mutation; their authentication and routing stay separate.

## Contract

- One browser operation, `feed_listen({tab_id})`, binds a page and returns a bounded, non-destructive buffer snapshot. A dry run reads without installing a listener or consuming records.
- Authority comes from the server's top-level `feed_context`, derived from the running parent sync, its feed, connection and owning device. Action input cannot grant authority.
- Existing worker poll carries bounded `feed_notifications` containing feed instance, connection, feed key and notification identity. Bodies and credentials are absent.
- Poll receipts confirm committed scheduling. A receipt also carries any saved `source_ack` from a successful sync checkpoint. Intermediate checkpoints and failed/dry completions cannot advance source acknowledgments.
- Each acknowledgment names a binding, buffer epoch and exact record revisions. A newer revision survives an older acknowledgment. Partial acknowledgment schedules remaining work through the same feed.
- Feed pause/removal, connection revocation or device unpairing stops the binding. The extension validates the actual sender document, tab and origin.

The initial limits are 64 bindings, 10,000 coalesced records or 16 MiB per binding, 128 KiB per record, and 1,000 records or 4 MiB per snapshot. Overflow must surface as a recovery error; it is not a complete-capture claim. Scheduled sync remains the bootstrap and recovery path. A logged-in Web tab is required; an open desktop WhatsApp app is insufficient.

## Correctness and acceptance

The active-sync scheduling race was reproduced against Postgres: successful completion overwrote a notification's earlier due time. Completion now preserves that pending due time atomically. Failure backoff and the existing one-active-sync-per-feed constraint remain in force.

Verification must cover source add/change filtering, listener replacement, delayed normalization, stale acknowledgments, duplicate content, partial batches, deferred history, scope rejection, streaming checkpoints, failed/dry completion, server outage, page and extension reload, service-worker eviction, browser restart, burst bounds and overflow.

The existing Playwright harness loads the real extension in a disposable profile and exercises worker poll and page messaging. It complements real Postgres tests; its synthetic gateway is not production provider proof.

The user authorized a labeled WhatsApp self-message test. Verify that exact source identity reaches the deployed feed through the live notification path, then verify the matching Automation and notification. A self-message does not establish unrelated inbound/group/edit coverage. Do not send messages to other people.

Release reviewed Owletto content before the parent pointer/server change. Verify the deployed squash SHA, active WhatsApp connector version and installed extension version separately. Keep all live tenant/device/source identifiers out of shipping code and this document. Archive task-created test Automations and remove temporary test infrastructure after verification.
