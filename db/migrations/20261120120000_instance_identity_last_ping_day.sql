-- migrate:up
-- lobu:no-quiesce
-- UTC day of the last anonymous install-ping attempt. The first boot of a day
-- claims it with one atomic UPDATE so N replicas and repeated restarts still
-- send one ping; the daily cron heartbeat shares the marker. Additive and
-- nullable: code running before this deploy never reads or writes it (during
-- that roll an old replica may also send its old daily ping, which only
-- duplicates the upgrade day).
ALTER TABLE public.instance_identity
  ADD COLUMN IF NOT EXISTS last_ping_day date;

-- migrate:down
ALTER TABLE public.instance_identity
  DROP COLUMN IF EXISTS last_ping_day;
