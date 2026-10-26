-- squawk-ignore-file prefer-robust-stmts
-- migrate:up
-- lobu:quiesce old replicas Number() a NULL stored endpoint into entity 0 in unlink/update_link audit events and cannot address source endpoints in link/list_links, so they must not serve once source endpoints can be written
-- No source record is materialized. A source endpoint is an immutable type id plus its declared key.
ALTER TABLE entity_relationships
  ADD COLUMN IF NOT EXISTS from_entity_type_id bigint,
  ADD COLUMN IF NOT EXISTS from_source_key text,
  ADD COLUMN IF NOT EXISTS to_entity_type_id bigint,
  ADD COLUMN IF NOT EXISTS to_source_key text;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_from_type_fk;
ALTER TABLE entity_relationships ADD CONSTRAINT entity_relationships_from_type_fk FOREIGN KEY (from_entity_type_id) REFERENCES entity_types(id) NOT VALID;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_to_type_fk;
ALTER TABLE entity_relationships ADD CONSTRAINT entity_relationships_to_type_fk FOREIGN KEY (to_entity_type_id) REFERENCES entity_types(id) NOT VALID;
ALTER TABLE entity_relationships VALIDATE CONSTRAINT entity_relationships_from_type_fk;
ALTER TABLE entity_relationships VALIDATE CONSTRAINT entity_relationships_to_type_fk;
-- squawk-ignore ban-drop-not-null
ALTER TABLE entity_relationships ALTER COLUMN from_entity_id DROP NOT NULL;
-- squawk-ignore ban-drop-not-null
ALTER TABLE entity_relationships ALTER COLUMN to_entity_id DROP NOT NULL;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_from_reference;
ALTER TABLE entity_relationships ADD CONSTRAINT entity_relationships_from_reference CHECK (
  (from_entity_id IS NOT NULL AND from_entity_type_id IS NULL AND from_source_key IS NULL)
  OR (from_entity_id IS NULL AND from_entity_type_id IS NOT NULL AND from_source_key IS NOT NULL
      AND octet_length(from_source_key) BETWEEN 1 AND 1024)
) NOT VALID;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_to_reference;
ALTER TABLE entity_relationships ADD CONSTRAINT entity_relationships_to_reference CHECK (
  (to_entity_id IS NOT NULL AND to_entity_type_id IS NULL AND to_source_key IS NULL)
  OR (to_entity_id IS NULL AND to_entity_type_id IS NOT NULL AND to_source_key IS NOT NULL
      AND octet_length(to_source_key) BETWEEN 1 AND 1024)
) NOT VALID;
ALTER TABLE entity_relationships VALIDATE CONSTRAINT entity_relationships_from_reference;
ALTER TABLE entity_relationships VALIDATE CONSTRAINT entity_relationships_to_reference;

-- Existing stored-only arbiters remain valid for connector and ACL writers.
-- The new subset is empty during migration; the key byte bound keeps this exact btree key bounded.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_relationships_live_source_pair ON entity_relationships (
  organization_id, COALESCE(from_entity_id, 0), COALESCE(from_entity_type_id, 0), COALESCE(from_source_key, ''),
  COALESCE(to_entity_id, 0), COALESCE(to_entity_type_id, 0), COALESCE(to_source_key, ''), relationship_type_id
) WHERE deleted_at IS NULL AND (from_entity_id IS NULL OR to_entity_id IS NULL);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_entity_relationships_from_source ON entity_relationships (from_entity_type_id, from_source_key, organization_id)
  WHERE from_entity_type_id IS NOT NULL AND deleted_at IS NULL;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_entity_relationships_to_source ON entity_relationships (to_entity_type_id, to_source_key, organization_id)
  WHERE to_entity_type_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION lobu_guard_source_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rt entity_relationship_types; source_type entity_types; type_id bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.from_entity_type_id IS NOT NULL OR OLD.to_entity_type_id IS NOT NULL) AND
     (NEW.from_entity_id, NEW.from_entity_type_id, NEW.from_source_key, NEW.to_entity_id, NEW.to_entity_type_id, NEW.to_source_key)
     IS DISTINCT FROM
     (OLD.from_entity_id, OLD.from_entity_type_id, OLD.from_source_key, OLD.to_entity_id, OLD.to_entity_type_id, OLD.to_source_key) THEN
    RAISE EXCEPTION 'Source relationship endpoints are immutable; unlink and create a new relationship';
  END IF;
  IF NEW.from_entity_type_id IS NULL AND NEW.to_entity_type_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO rt FROM entity_relationship_types WHERE id = NEW.relationship_type_id FOR SHARE;
  IF rt.purpose IN ('authorization', 'identity') OR rt.slug = 'member_of' THEN
    RAISE EXCEPTION 'Authorization and identity associations require stored endpoints';
  END IF;
  -- Withdrawals remain possible after a source disconnect or disappearance.
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  FOR type_id IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.from_entity_type_id, NEW.to_entity_type_id]) AS ids(id)
    WHERE id IS NOT NULL ORDER BY id LOOP
    SELECT * INTO source_type FROM entity_types WHERE id = type_id FOR SHARE;
    IF source_type.deleted_at IS NOT NULL OR source_type.backing_sql IS NULL
       OR source_type.organization_id IS DISTINCT FROM NEW.organization_id
       OR source_type.metadata_schema->>'x-lobu-record-key' IS NULL THEN
      RAISE EXCEPTION 'Source endpoints require a live workspace type with a declared stable record key';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lobu_guard_source_relationships ON entity_relationships;
CREATE TRIGGER lobu_guard_source_relationships BEFORE INSERT OR UPDATE ON entity_relationships
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_source_relationships();

CREATE OR REPLACE FUNCTION lobu_guard_source_type_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocking_ids bigint[];
BEGIN
  IF (NEW.deleted_at, NEW.backing_sql, NEW.backing_source, NEW.metadata_schema->>'x-lobu-record-key')
     IS DISTINCT FROM (OLD.deleted_at, OLD.backing_sql, OLD.backing_source, OLD.metadata_schema->>'x-lobu-record-key')
     AND (EXISTS (SELECT 1 FROM entity_relationships WHERE from_entity_type_id = OLD.id AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM entity_relationships WHERE to_entity_type_id = OLD.id AND deleted_at IS NULL)) THEN
    SELECT array_agg(id) INTO blocking_ids FROM (
      SELECT id FROM entity_relationships WHERE organization_id = OLD.organization_id AND deleted_at IS NULL
        AND (from_entity_type_id = OLD.id OR to_entity_type_id = OLD.id) ORDER BY id LIMIT 25
    ) AS blockers;
    RAISE EXCEPTION 'Source record contract has live relationships; unlink relationship IDs % then retry changing backing, key, or deleting the type (at most 25 shown)', blocking_ids
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_types_source_relationship_contract';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lobu_guard_source_type_contract ON entity_types;
CREATE TRIGGER lobu_guard_source_type_contract BEFORE UPDATE ON entity_types
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_source_type_contract();

CREATE OR REPLACE FUNCTION lobu_guard_source_relationship_type() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocking_ids bigint[];
BEGIN
  IF (NEW.purpose IN ('authorization', 'identity') OR NEW.slug = 'member_of')
     AND EXISTS (SELECT 1 FROM entity_relationships WHERE relationship_type_id = OLD.id
       AND deleted_at IS NULL AND (from_entity_type_id IS NOT NULL OR to_entity_type_id IS NOT NULL)) THEN
    SELECT array_agg(id) INTO blocking_ids FROM (
      SELECT id FROM entity_relationships WHERE relationship_type_id = OLD.id AND organization_id = OLD.organization_id
        AND deleted_at IS NULL AND (from_entity_type_id IS NOT NULL OR to_entity_type_id IS NOT NULL) ORDER BY id LIMIT 25
    ) AS blockers;
    RAISE EXCEPTION 'Source relationships cannot become authorization or identity associations; unlink relationship IDs % then retry (at most 25 shown)', blocking_ids
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_relationship_types_source_endpoint_purpose';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lobu_guard_source_relationship_type ON entity_relationship_types;
CREATE TRIGGER lobu_guard_source_relationship_type BEFORE UPDATE ON entity_relationship_types
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_source_relationship_type();

-- migrate:down
-- Refuse rollback while the old binary would misinterpret source endpoints.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM entity_relationships WHERE from_entity_type_id IS NOT NULL OR to_entity_type_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot roll back while source relationship history exists';
  END IF;
END $$;
DROP TRIGGER IF EXISTS lobu_guard_source_relationship_type ON entity_relationship_types;
DROP FUNCTION IF EXISTS lobu_guard_source_relationship_type();
DROP TRIGGER IF EXISTS lobu_guard_source_type_contract ON entity_types;
DROP FUNCTION IF EXISTS lobu_guard_source_type_contract();
DROP TRIGGER IF EXISTS lobu_guard_source_relationships ON entity_relationships;
DROP FUNCTION IF EXISTS lobu_guard_source_relationships();
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS idx_entity_relationships_from_source;
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS idx_entity_relationships_to_source;
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS idx_entity_relationships_live_source_pair;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_from_reference;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_to_reference;
ALTER TABLE entity_relationships ALTER COLUMN from_entity_id SET NOT NULL;
ALTER TABLE entity_relationships ALTER COLUMN to_entity_id SET NOT NULL;
ALTER TABLE entity_relationships DROP COLUMN IF EXISTS from_entity_type_id, DROP COLUMN IF EXISTS from_source_key,
  DROP COLUMN IF EXISTS to_entity_type_id, DROP COLUMN IF EXISTS to_source_key;
