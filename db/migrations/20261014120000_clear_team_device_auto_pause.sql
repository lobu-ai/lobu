-- Resume team device connections that device reconciliation auto-paused.
--
-- Device reconciliation used to pause a team workspace's device connection,
-- with a stamped `error_message`, when its device ran an older connector
-- version than the workspace or stopped offering the connector, and resumed it
-- by matching that stamp. Reconciliation no longer writes connection status:
-- a behind device simply cannot claim the workspace's version. Nothing clears
-- the stamps any more, so a connection paused that way would stay paused.
--
-- A stamped row was always a system pause: the pause only took over an
-- active, unstamped connection, and a user's own pause or resume cleared the
-- stamp. Resuming it restores the connection to the state its owner left it
-- in. Feeds were never touched by the pause, so none are changed here.
--
-- A single UPDATE over the bounded `connections` table; idempotent on re-run.

-- migrate:up

UPDATE connections
SET status = 'active',
    error_message = NULL,
    updated_at = NOW()
WHERE deleted_at IS NULL
  AND status = 'paused'
  AND device_worker_id IS NOT NULL
  AND (
    starts_with(error_message, 'Update Lobu on this device to use ')
    OR right(error_message, 37) = ' is no longer offered by this device.'
  );

-- migrate:down

-- Data cleanup is not reversed: the stamps are no longer read by anything.
SELECT 1;
