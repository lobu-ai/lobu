-- migrate:up
-- lobu:quiesce Old configuration mutation handlers do not enforce expected_revision; mixed-version replicas could accept a stale save after a new replica returned its revision.
-- Operational cost: O(1) catalog addition of a nullable JSONB column with no
-- default, backfill, table rewrite, or index build. ALTER TABLE requires an
-- ACCESS EXCLUSIVE lock; acquisition time depends on concurrent traffic.
-- Production row count and execution timing have not been measured.
-- One bounded, authored sidebar document per workspace. Keep it outside the
-- Better Auth metadata object so generic metadata updates cannot bypass its
-- conditional-write contract or expose an unprojected navigation document.
-- Existing workspaces retain the default sidebar; no backfill is necessary.
ALTER TABLE public.organization ADD COLUMN IF NOT EXISTS navigation jsonb;
COMMENT ON COLUMN public.organization.navigation IS
  'Workspace navigation envelope {id, document}; null uses the default sidebar. Writes require the original revision.';

-- migrate:down
ALTER TABLE public.organization DROP COLUMN IF EXISTS navigation;
