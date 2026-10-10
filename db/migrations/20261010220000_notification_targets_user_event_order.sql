-- Order-preserving access path for the notification inbox reads.
--
-- listNotifications (notifications/service.ts) drives from notification_targets
-- filtered by user, ordered by event id DESC with LIMIT ~21 — but the only
-- indexes led with delivered_at, so every page enriched + sorted the user's
-- entire inbox (128k calls x ~1.3s mean on prod). (user_id, event_id DESC)
-- lets the planner scan newest-first and stop after the page; the partial
-- twin serves the unreadOnly variant the same way.
--
-- transaction:false for the CONCURRENTLY index builds; every statement is
-- individually rerunnable so a partial failure can retry.

-- migrate:up transaction:false
-- lobu:no-quiesce

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_notification_targets_user_event'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_notification_targets_user_event';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_notification_targets_user_event_unread'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_notification_targets_user_event_unread';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_targets_user_event
  ON public.notification_targets (user_id, event_id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_targets_user_event_unread
  ON public.notification_targets (user_id, event_id DESC)
  WHERE (read_at IS NULL);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_notification_targets_user_event;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_notification_targets_user_event_unread;
