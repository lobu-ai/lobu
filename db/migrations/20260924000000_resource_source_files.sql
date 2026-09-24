-- migrate:up
ALTER TABLE views
  ADD COLUMN IF NOT EXISTS source_files jsonb,
  ADD COLUMN IF NOT EXISTS dependencies jsonb,
  ADD COLUMN IF NOT EXISTS source_complete boolean;

ALTER TABLE connector_versions
  ADD COLUMN IF NOT EXISTS source_files jsonb,
  ADD COLUMN IF NOT EXISTS dependencies jsonb,
  ADD COLUMN IF NOT EXISTS source_complete boolean;

-- Existing artifacts have unknown source provenance. Re-saving captures it;
-- neither a compiled-code hash nor source-looking text proves completeness.

-- migrate:down
ALTER TABLE connector_versions DROP COLUMN IF EXISTS source_files, DROP COLUMN IF EXISTS dependencies, DROP COLUMN IF EXISTS source_complete;
ALTER TABLE views DROP COLUMN IF EXISTS source_files, DROP COLUMN IF EXISTS dependencies, DROP COLUMN IF EXISTS source_complete;
