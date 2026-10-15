-- migrate:up
-- lobu:no-quiesce -- only the ON DELETE action changes; columns and tenant scope are unchanged.

-- Deleting an auth profile that a connection references failed with
-- `null value in column "organization_id" of relation "connections"`.
-- Both foreign keys are composite, (organization_id, auth_profile_id) and
-- (organization_id, app_auth_profile_id), and a bare ON DELETE SET NULL nulls
-- every referencing column, including the NOT NULL organization_id. The
-- common path is DELETE /api/me/devices/:id: device_workers cascades to its
-- device-bound auth profiles, so removing a browser device whose connections
-- still point at those profiles returned 500.
--
-- SET NULL (column) clears only the profile reference and keeps the
-- connection in its workspace. Each constraint is re-added NOT VALID and then
-- validated. The transaction holds ACCESS EXCLUSIVE on connections through
-- both validation scans until commit. Connections is a bounded configuration
-- table.

-- squawk-ignore adding-foreign-key-constraint -- NOT VALID followed by validation
ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_auth_profile_id_fkey,
  ADD CONSTRAINT connections_auth_profile_id_fkey
    FOREIGN KEY (organization_id, auth_profile_id)
    REFERENCES auth_profiles (organization_id, id)
    ON DELETE SET NULL (auth_profile_id) NOT VALID,
  DROP CONSTRAINT IF EXISTS connections_app_auth_profile_id_fkey,
  ADD CONSTRAINT connections_app_auth_profile_id_fkey
    FOREIGN KEY (organization_id, app_auth_profile_id)
    REFERENCES auth_profiles (organization_id, id)
    ON DELETE SET NULL (app_auth_profile_id) NOT VALID;
-- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
ALTER TABLE connections VALIDATE CONSTRAINT connections_auth_profile_id_fkey;
-- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
ALTER TABLE connections VALIDATE CONSTRAINT connections_app_auth_profile_id_fkey;

-- migrate:down

-- squawk-ignore adding-foreign-key-constraint -- NOT VALID followed by validation
ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_auth_profile_id_fkey,
  ADD CONSTRAINT connections_auth_profile_id_fkey
    FOREIGN KEY (organization_id, auth_profile_id)
    REFERENCES auth_profiles (organization_id, id)
    ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS connections_app_auth_profile_id_fkey,
  ADD CONSTRAINT connections_app_auth_profile_id_fkey
    FOREIGN KEY (organization_id, app_auth_profile_id)
    REFERENCES auth_profiles (organization_id, id)
    ON DELETE SET NULL NOT VALID;
-- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
ALTER TABLE connections VALIDATE CONSTRAINT connections_auth_profile_id_fkey;
-- squawk-ignore prefer-robust-stmts -- the migration runner owns the transaction
ALTER TABLE connections VALIDATE CONSTRAINT connections_app_auth_profile_id_fkey;
