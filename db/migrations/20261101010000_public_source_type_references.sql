-- squawk-ignore-file prefer-robust-stmts
-- migrate:up
-- lobu:quiesce old readers resolve saved source type IDs by local slug and must not serve cross-workspace endpoints
-- Trigger bodies only: immutable type IDs and verbatim keys are reused; no data rewrite, tables, columns or indexes.
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
       OR source_type.metadata_schema->>'x-lobu-record-key' IS NULL THEN
      RAISE EXCEPTION 'Source endpoints require a live workspace type with a declared stable record key';
    END IF;
    -- The authoring side is always local. The target may name a type owned by
    -- a public workspace; source ACLs are additionally enforced at read/write.
    IF source_type.organization_id IS DISTINCT FROM NEW.organization_id
       AND (NEW.from_entity_type_id = type_id OR NOT EXISTS (
         SELECT 1 FROM organization WHERE id = source_type.organization_id AND visibility = 'public'
       )) THEN
      RAISE EXCEPTION 'Source relationship requires a local source and a local or public target';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION lobu_guard_source_type_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocking_ids bigint[];
BEGIN
  -- The publisher's own live edges block deletion and every contract change.
  IF (NEW.deleted_at, NEW.backing_sql, NEW.backing_source, NEW.metadata_schema->>'x-lobu-record-key')
     IS DISTINCT FROM (OLD.deleted_at, OLD.backing_sql, OLD.backing_source, OLD.metadata_schema->>'x-lobu-record-key') THEN
    SELECT array_agg(id) INTO blocking_ids FROM (
      SELECT id FROM entity_relationships WHERE organization_id = OLD.organization_id AND deleted_at IS NULL
        AND (from_entity_type_id = OLD.id OR to_entity_type_id = OLD.id) ORDER BY id LIMIT 25
    ) AS blockers;
    IF blocking_ids IS NOT NULL THEN
      RAISE EXCEPTION 'Source record contract has live relationships; unlink relationship IDs % then retry changing backing, key, or deleting the type (at most 25 shown)', blocking_ids
        USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_types_source_relationship_contract';
    END IF;
  END IF;
  -- Other workspaces' edges never veto deletion or a backing edit: a retired
  -- type withholds them. The key column is what every stored key means, so it
  -- cannot change in place while any workspace holds a live edge; a new type
  -- (new ID) replaces it instead. Other workspaces' relationship IDs stay private.
  IF NEW.metadata_schema->>'x-lobu-record-key' IS DISTINCT FROM OLD.metadata_schema->>'x-lobu-record-key'
     AND (EXISTS (SELECT 1 FROM entity_relationships WHERE to_entity_type_id = OLD.id AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM entity_relationships WHERE from_entity_type_id = OLD.id AND deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Other workspaces link to records by this key; delete this type and create a new one to change its record key'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_types_source_relationship_contract';
  END IF;
  RETURN NEW;
END $$;

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
    IF blocking_ids IS NULL THEN
      RAISE EXCEPTION 'Source relationships in other workspaces use this relationship type, so it cannot become an authorization or identity association'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_relationship_types_source_endpoint_purpose';
    END IF;
    RAISE EXCEPTION 'Source relationships cannot become authorization or identity associations; unlink relationship IDs % then retry (at most 25 shown)', blocking_ids
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_relationship_types_source_endpoint_purpose';
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
-- Refuse rollback while the old binary would resolve a foreign type ID by local slug.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM entity_relationships r JOIN entity_types t ON t.id = r.to_entity_type_id
    WHERE t.organization_id IS DISTINCT FROM r.organization_id
  ) THEN
    RAISE EXCEPTION 'Cannot roll back while cross-workspace source relationships exist';
  END IF;
END $$;
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
