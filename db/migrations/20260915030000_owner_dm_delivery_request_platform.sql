-- `delivery_request.ownerDm` is a persisted snapshot of the owner's chat DM
-- destination, re-validated against a fresh resolve before the durable delivery
-- task posts. Owner routing used to be Slack-only, so the snapshot stored
-- `{connectionId, slackUserId}` and the task hardcoded the Slack adapter.
--
-- Now that any chat platform can own an approval, the snapshot carries the
-- platform it resolved on: `{connectionId, platform, platformUserId}`. A row
-- left in the old shape fails re-validation on EVERY field the new reader
-- compares, so its delivery task would retry to exhaustion and drop the owner
-- DM. Rewriting the snapshot in place is what lets the reader stay a single
-- shape instead of carrying a compat read of the retired key.
--
-- Every pre-existing row is Slack by construction: no other platform could
-- reach this code path before the change that adds this migration.
--
-- Scale, measured on prod 2026-09-15: 4,161,293 rows in `events`, 233 carrying
-- a `delivery_request`, and 2 in the retired shape. The predicate has no
-- supporting index, so this is ONE seq scan of `events` in a single
-- transaction that updates two rows — bounded work, and no narrower indexed
-- column exists to key it by (`delivery_request` lives in `metadata`, which
-- carries no GIN index). Writers are unblocked throughout: MVCC means the scan
-- takes no table lock and the row locks cover only the rows actually rewritten.
-- Idempotent — the guard names the retired key, so a re-run matches nothing.
-- migrate:up
UPDATE events
SET metadata = jsonb_set(
      metadata,
      '{delivery_request,ownerDm}',
      jsonb_build_object(
        'connectionId', metadata->'delivery_request'->'ownerDm'->'connectionId',
        'platform', '"slack"'::jsonb,
        'platformUserId', metadata->'delivery_request'->'ownerDm'->'slackUserId'
      )
    )
WHERE metadata->'delivery_request'->'ownerDm' ? 'slackUserId';

-- migrate:down
-- Reversible only for Slack rows, which is exactly the set the up migration
-- rewrote. A snapshot on any other platform has no representation in the old
-- Slack-only shape, so it is left alone rather than silently mislabelled.
UPDATE events
SET metadata = jsonb_set(
      metadata,
      '{delivery_request,ownerDm}',
      jsonb_build_object(
        'connectionId', metadata->'delivery_request'->'ownerDm'->'connectionId',
        'slackUserId', metadata->'delivery_request'->'ownerDm'->'platformUserId'
      )
    )
WHERE metadata->'delivery_request'->'ownerDm' ? 'platformUserId'
  AND metadata->'delivery_request'->'ownerDm'->>'platform' = 'slack';
