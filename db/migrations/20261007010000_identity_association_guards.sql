-- migrate:up
-- Classification is opt-in AFTER all replicas run this release. No tenant
-- vocabulary is installed or reclassified by this migration.
ALTER TABLE entity_relationship_types DROP CONSTRAINT IF EXISTS entity_relationship_types_purpose_check;
ALTER TABLE entity_relationship_types ADD CONSTRAINT entity_relationship_types_purpose_check
  CHECK (purpose IS NULL OR purpose IN ('authorization', 'identity')) NOT VALID;
ALTER TABLE entity_relationship_types VALIDATE CONSTRAINT entity_relationship_types_purpose_check;

-- The writer and guard call this one generator. Never acquire this lock from a
-- row trigger: PostgreSQL has already taken the row lock by then.
CREATE OR REPLACE FUNCTION lobu_identity_lock_key(org text) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT hashtextextended('identity:' || org, 0) $$;

CREATE OR REPLACE FUNCTION lobu_require_identity_lock(org text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k bigint := lobu_identity_lock_key(org);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
    AND pid = pg_backend_pid() AND mode = 'ExclusiveLock' AND granted
    AND classid::bigint = ((k >> 32) & 4294967295)
    AND objid::bigint = (k & 4294967295) AND objsubid = 1) THEN
    RAISE EXCEPTION 'Identity association requires the organization lock before row locks'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION lobu_guard_identity_edges() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rt entity_relationship_types; old_purpose text; endpoint_count integer; member_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT purpose INTO old_purpose FROM entity_relationship_types WHERE id = OLD.relationship_type_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    -- Also orders ordinary insert versus classification of an empty type.
    SELECT * INTO rt FROM entity_relationship_types WHERE id = NEW.relationship_type_id FOR SHARE;
  END IF;
  IF old_purpose IS DISTINCT FROM 'identity' AND rt.purpose IS DISTINCT FROM 'identity' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Existing endpoint/org deletion cascades may clear a retired edge. A live
    -- pair cannot erase its withdrawal record to bypass suppression.
    IF OLD.deleted_at IS NOT NULL AND
      (NOT EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id)
       OR NOT EXISTS (SELECT 1 FROM entities WHERE id = OLD.from_entity_id)
       OR NOT EXISTS (SELECT 1 FROM entities WHERE id = OLD.to_entity_id)) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Identity decision history cannot be deleted; unlink the association';
  END IF;
  PERFORM lobu_require_identity_lock(NEW.organization_id::text);
  IF COALESCE(current_setting('lobu.identity_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Identity edges require the governed link/unlink decision path'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id, NEW.from_entity_id, NEW.to_entity_id, NEW.relationship_type_id)
       IS DISTINCT FROM (OLD.organization_id, OLD.from_entity_id, OLD.to_entity_id, OLD.relationship_type_id)
       OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'Identity endpoints are immutable; only unlink is supported';
    END IF;
    IF COALESCE(NEW.metadata->'_lobu_identity_decision'->>'outcome', '') NOT IN ('withdrawn', 'member_deleted')
       OR NEW.metadata->'_lobu_identity_decision' IS NULL THEN
      RAISE EXCEPTION 'Identity unlink requires a durable withdrawal decision';
    END IF;
    RETURN NEW;
  END IF;
  IF rt.is_symmetric OR rt.inverse_type_id IS NOT NULL OR rt.deleted_at IS NOT NULL
     OR rt.status <> 'active' OR rt.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'Identity relationships require an active directional workspace type';
  END IF;
  IF EXISTS (SELECT 1 FROM entity_relationship_type_rules WHERE relationship_type_id = rt.id AND deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM entity_relationship_type_rules rule JOIN entities e ON e.id = NEW.from_entity_id
       JOIN entity_types et ON et.id = e.entity_type_id
       WHERE rule.relationship_type_id = rt.id AND rule.deleted_at IS NULL
         AND rule.source_entity_type_slug = et.slug AND rule.target_entity_type_slug = et.slug) THEN
    RAISE EXCEPTION 'Identity endpoints are not allowed by the relationship type rules';
  END IF;
  IF NEW.from_entity_id = NEW.to_entity_id OR NEW.deleted_at IS NOT NULL
     OR NEW.metadata->'_lobu_claims' IS DISTINCT FROM '{"manual":{}}'::jsonb
     OR NEW.metadata->'_lobu_identity_decision'->>'outcome' IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'Identity edges require one accepted manual decision';
  END IF;
  SELECT count(*) INTO endpoint_count FROM entities a JOIN entities b ON a.entity_type_id = b.entity_type_id
    JOIN entity_types et ON et.id = a.entity_type_id
    WHERE a.id = NEW.from_entity_id AND b.id = NEW.to_entity_id
      AND a.organization_id = NEW.organization_id AND b.organization_id = NEW.organization_id
      AND a.deleted_at IS NULL AND b.deleted_at IS NULL AND et.deleted_at IS NULL
      AND left(et.slug, 1) <> '$' AND et.backing_sql IS NULL AND et.backing_source IS NULL;
  IF endpoint_count <> 1 THEN
    RAISE EXCEPTION 'Identity endpoints must be live stored records of the same non-reserved type and organization';
  END IF;
  IF EXISTS (SELECT 1 FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.deleted_at IS NULL AND t.purpose = 'identity'
      AND r.from_entity_id IN (NEW.from_entity_id, NEW.to_entity_id)) THEN
    RAISE EXCEPTION 'Identity joins must be directed root-to-root; a root already has a parent';
  END IF;
  WITH RECURSIVE members(id) AS (
    SELECT NEW.from_entity_id UNION SELECT NEW.to_entity_id
    UNION
    SELECT CASE WHEN r.from_entity_id = m.id THEN r.to_entity_id ELSE r.from_entity_id END
    FROM members m JOIN entity_relationships r ON m.id IN (r.from_entity_id, r.to_entity_id)
      JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.organization_id = NEW.organization_id AND r.deleted_at IS NULL AND t.purpose = 'identity'
  ) SELECT count(*) INTO member_count FROM (SELECT id FROM members LIMIT 27) bounded;
  IF member_count > 26 THEN RAISE EXCEPTION 'Identity components may have at most 26 members'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER lobu_guard_identity_edges BEFORE INSERT OR UPDATE OR DELETE ON entity_relationships
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_identity_edges();

CREATE OR REPLACE FUNCTION lobu_guard_identity_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.merged_into IS NOT NULL AND NEW.merged_into IS DISTINCT FROM OLD.merged_into THEN
    IF EXISTS (SELECT 1 FROM entity_relationship_types t
      WHERE t.organization_id = OLD.organization_id AND t.purpose = 'identity' AND t.deleted_at IS NULL AND t.status = 'active'
        AND (NOT EXISTS (SELECT 1 FROM entity_relationship_type_rules WHERE relationship_type_id = t.id AND deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM entity_relationship_type_rules rule JOIN entity_types et ON et.id = OLD.entity_type_id
            WHERE rule.relationship_type_id = t.id AND rule.deleted_at IS NULL AND rule.source_entity_type_slug = et.slug
              AND rule.target_entity_type_slug = et.slug))) THEN
      RAISE EXCEPTION 'Physical merge is disabled for types using identity associations';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.entity_type_id, NEW.deleted_at, NEW.merged_into)
     IS NOT DISTINCT FROM (OLD.organization_id, OLD.entity_type_id, OLD.deleted_at, OLD.merged_into) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.deleted_at IS NULL AND t.purpose = 'identity' AND OLD.id IN (r.from_entity_id, r.to_entity_id)) THEN
    RAISE EXCEPTION 'Unlink identity associations before deleting or changing a member type or organization';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER lobu_guard_identity_members BEFORE UPDATE OR DELETE ON entities
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_identity_members();

CREATE OR REPLACE FUNCTION lobu_guard_identity_types() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_type boolean; populated boolean; type_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'entity_relationship_types' THEN
    identity_type := CASE WHEN TG_OP = 'DELETE' THEN OLD.purpose = 'identity'
      ELSE NEW.purpose = 'identity' OR (TG_OP = 'UPDATE' AND OLD.purpose = 'identity') END;
    IF NOT COALESCE(identity_type, false) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.purpose = 'identity'
       AND (NEW.is_symmetric OR NEW.inverse_type_id IS NOT NULL OR NEW.slug = 'member_of') THEN
      RAISE EXCEPTION 'Identity types must be directional and cannot grant authorization';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM lobu_require_identity_lock(NEW.organization_id::text);
      IF NEW.purpose = 'identity' AND EXISTS (SELECT 1 FROM entity_relationship_type_rules
        WHERE relationship_type_id = NEW.id AND deleted_at IS NULL
          AND (source_entity_type_slug <> target_entity_type_slug OR left(source_entity_type_slug, 1) = '$')) THEN
        RAISE EXCEPTION 'Identity rules require the same non-reserved entity type';
      END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id) THEN RETURN OLD; END IF;
    SELECT EXISTS (SELECT 1 FROM entity_relationships WHERE relationship_type_id = OLD.id) INTO populated;
    IF populated AND (TG_OP = 'DELETE' OR
      (NEW.purpose, NEW.is_symmetric, NEW.inverse_type_id, NEW.organization_id)
      IS DISTINCT FROM (OLD.purpose, OLD.is_symmetric, OLD.inverse_type_id, OLD.organization_id)) THEN
      RAISE EXCEPTION 'A populated identity relationship type is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.deleted_at, NEW.status) IS DISTINCT FROM (OLD.deleted_at, OLD.status)
      AND EXISTS (SELECT 1 FROM entity_relationships WHERE relationship_type_id = OLD.id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Unlink identity associations before retiring their relationship type';
    END IF;
  ELSIF TG_TABLE_NAME = 'entity_relationship_type_rules' THEN
    type_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.relationship_type_id ELSE NEW.relationship_type_id END;
    -- Serialize an ordinary rule edit with classification of its empty type.
    PERFORM 1 FROM entity_relationship_types
      WHERE id IN (type_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.relationship_type_id ELSE type_id END)
      ORDER BY id FOR SHARE;
    PERFORM lobu_require_identity_lock(organization_id::text) FROM entity_relationship_types
      WHERE purpose = 'identity' AND id IN (type_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.relationship_type_id ELSE type_id END);
    IF EXISTS (SELECT 1 FROM entity_relationship_types t JOIN entity_relationships r ON r.relationship_type_id = t.id
      WHERE t.purpose = 'identity' AND t.id IN (type_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.relationship_type_id ELSE type_id END)) THEN
      RAISE EXCEPTION 'Rules of a populated identity relationship type are immutable';
    END IF;
    IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM entity_relationship_types WHERE id = type_id AND purpose = 'identity')
      AND (NEW.source_entity_type_slug <> NEW.target_entity_type_slug OR left(NEW.source_entity_type_slug, 1) = '$') THEN
      RAISE EXCEPTION 'Identity rules require the same non-reserved entity type';
    END IF;
  ELSIF TG_TABLE_NAME = 'entity_types' THEN
    IF TG_OP = 'UPDATE' AND (NEW.slug, NEW.organization_id, NEW.deleted_at, NEW.backing_sql, NEW.backing_source)
      IS NOT DISTINCT FROM (OLD.slug, OLD.organization_id, OLD.deleted_at, OLD.backing_sql, OLD.backing_source) THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM entities e JOIN entity_relationships r ON e.id IN (r.from_entity_id, r.to_entity_id)
      JOIN entity_relationship_types t ON t.id = r.relationship_type_id
      WHERE e.entity_type_id = OLD.id AND r.deleted_at IS NULL AND t.purpose = 'identity') THEN
      RAISE EXCEPTION 'Unlink identity associations before changing their entity type';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id
      WHERE r.organization_id = OLD.id AND r.deleted_at IS NULL AND t.purpose = 'identity') THEN
      RAISE EXCEPTION 'Unlink identity associations before deleting their organization';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER lobu_guard_identity_types BEFORE INSERT OR UPDATE OR DELETE ON entity_relationship_types
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_identity_types();
CREATE OR REPLACE TRIGGER lobu_guard_identity_rules BEFORE INSERT OR UPDATE OR DELETE ON entity_relationship_type_rules
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_identity_types();
CREATE OR REPLACE TRIGGER lobu_guard_identity_entity_types BEFORE UPDATE OR DELETE ON entity_types
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_identity_types();
CREATE OR REPLACE TRIGGER lobu_guard_identity_organizations BEFORE DELETE ON organization
  FOR EACH ROW EXECUTE FUNCTION lobu_guard_identity_types();

-- Pair lookup reads current decision records by index, never aggregates events.
CREATE INDEX IF NOT EXISTS idx_identity_withdrawal_pair ON entity_relationships
  (organization_id, LEAST(from_entity_id, to_entity_id), GREATEST(from_entity_id, to_entity_id), updated_at DESC)
  WHERE metadata ? '_lobu_identity_decision' AND deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_identity_rejected_pair ON runs (organization_id, (action_input->>'identity_pair'), id DESC)
  WHERE approval_status = 'rejected' AND action_key = 'entity_change';
CREATE OR REPLACE FUNCTION lobu_resolution_members(proposal jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(proposal->'entity_ids', jsonb_build_array(proposal->'entity_id')) || jsonb_build_array(proposal->'winner_entity_id')
$$;
CREATE INDEX IF NOT EXISTS idx_merge_rejected_members ON runs USING gin (lobu_resolution_members(action_input))
  WHERE approval_status = 'rejected' AND action_key = 'entity_change' AND action_input->>'operation' = 'merge';

-- migrate:down
-- Refuse rollback while classified types exist; first withdraw and declassify
-- through an explicitly reviewed migration rather than discarding decisions.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM entity_relationship_types WHERE purpose = 'identity') THEN
    RAISE EXCEPTION 'Identity association types must be migrated before rollback';
  END IF;
END $$;
DROP INDEX IF EXISTS idx_merge_rejected_members;
DROP FUNCTION IF EXISTS lobu_resolution_members(jsonb);
DROP INDEX IF EXISTS idx_identity_rejected_pair;
DROP INDEX IF EXISTS idx_identity_withdrawal_pair;
DROP TRIGGER IF EXISTS lobu_guard_identity_organizations ON organization;
DROP TRIGGER IF EXISTS lobu_guard_identity_entity_types ON entity_types;
DROP TRIGGER IF EXISTS lobu_guard_identity_rules ON entity_relationship_type_rules;
DROP TRIGGER IF EXISTS lobu_guard_identity_types ON entity_relationship_types;
DROP TRIGGER IF EXISTS lobu_guard_identity_members ON entities;
DROP TRIGGER IF EXISTS lobu_guard_identity_edges ON entity_relationships;
DROP FUNCTION IF EXISTS lobu_guard_identity_types();
DROP FUNCTION IF EXISTS lobu_guard_identity_members();
DROP FUNCTION IF EXISTS lobu_guard_identity_edges();
DROP FUNCTION IF EXISTS lobu_require_identity_lock(text);
DROP FUNCTION IF EXISTS lobu_identity_lock_key(text);
ALTER TABLE entity_relationship_types DROP CONSTRAINT IF EXISTS entity_relationship_types_purpose_check;
ALTER TABLE entity_relationship_types ADD CONSTRAINT entity_relationship_types_purpose_check
  CHECK (purpose IS NULL OR purpose = 'authorization');
