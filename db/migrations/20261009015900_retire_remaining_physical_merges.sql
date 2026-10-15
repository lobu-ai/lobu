-- migrate:up
-- lobu:quiesce 21.2.1 code reads entities.merged_into and still executes merges; it must stop before redirects are retired and the column drops
--
-- Retire every physical entity merge that is still stored as a redirect, so a
-- 21.2.1 database upgrades straight through the retirement migrations that
-- follow (20261009020000 fences entities.merged_into, 20261009030001 drops
-- it). The operator maintenance tool those migrations were written around
-- shipped in no release, so the upgrade itself does the work.
--
-- Skip databases where entities.merged_into has already been dropped. Fresh
-- installs replay the earlier migrations and reach this body with no redirects.
--
-- A retired redirect is a tombstoned row (deleted_at set) whose merged_into
-- points at a survivor, resolved through any chain to the final survivor.
-- For each one, in the order the statements below run:
--   * entity-id arrays (events, automations, connections, feeds,
--     classify_facet) are remapped loser -> survivor, preserving order and
--     deduplicating by first appearance; no other column changes.
--   * channel_messages.author_entity_id and child entities.parent_id are
--     retargeted to the survivor.
--   * live identities still on the loser move to the survivor with
--     merged_from_entity_id provenance, and live ordinary relationships are
--     repointed unless that would make a self-loop or a duplicate edge --
--     exactly what the 21.2.1 merge executor did at merge time. Soft-deleted
--     identities and relationships, authorization edges, write_approval_policies
--     keyed on the loser cascade away with it.
--     classify_facet.entity_id and automation_reactions.entity_id have no
--     foreign keys and keep the historical id.
--   * active entity_merge_operations rows are deleted. The ledger's two entity
--     foreign keys are dropped here (20261009020000 drops them IF EXISTS as well) so undone rows
--     survive as audit history once the loser is gone.
--   * the tombstone is hard-deleted; a redirect left on a live row is cleared.
-- Also renames entity_types resolution rules onMatch auto_merge -> auto_link.
--
-- Cost: scans entity types, redirects and active ledgers even without redirects.
-- With redirects, also scans referencing rows to remap them. Upgrade timing on
-- populated installations has not been measured here.
DO $retire$
DECLARE
  loser_ids bigint[];
  array_table text;
  reference record;
  referenced boolean;
  removed bigint;
  previous_acl_write text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'entities' AND column_name = 'merged_into') THEN
    RETURN;
  END IF;

  -- Explicit automatic identity rules keep their fields and normalizer; only
  -- the retired action name changes.
  UPDATE public.entity_types et
  SET metadata_schema = jsonb_set(et.metadata_schema, '{x-lobu-resolution,rules}', (
    SELECT jsonb_agg(CASE WHEN rule->>'onMatch' = 'auto_merge'
      THEN rule || '{"onMatch":"auto_link"}'::jsonb ELSE rule END ORDER BY ordinality)
    FROM jsonb_array_elements(et.metadata_schema->'x-lobu-resolution'->'rules') WITH ORDINALITY AS r(rule, ordinality)))
  WHERE jsonb_typeof(et.metadata_schema->'x-lobu-resolution'->'rules') = 'array'
    AND et.metadata_schema->'x-lobu-resolution' @> '{"rules":[{"onMatch":"auto_merge"}]}'::jsonb;

  -- The executor flattened chains at merge time, so one hop is the norm; a
  -- longer chain still resolves to its last tombstoned hop's target.
  CREATE TEMP TABLE IF NOT EXISTS retired_physical_merge (
    loser_id bigint PRIMARY KEY, survivor_id bigint NOT NULL) ON COMMIT DROP;
  TRUNCATE retired_physical_merge;
  INSERT INTO retired_physical_merge (loser_id, survivor_id)
  WITH RECURSIVE hop AS (
    SELECT e.id AS loser_id, e.merged_into AS target_id, 1 AS depth
    FROM public.entities e
    WHERE e.deleted_at IS NOT NULL AND e.merged_into IS NOT NULL
    UNION ALL
    SELECT hop.loser_id, t.merged_into, hop.depth + 1
    FROM hop JOIN public.entities t ON t.id = hop.target_id
    WHERE t.deleted_at IS NOT NULL AND t.merged_into IS NOT NULL AND hop.depth < 16
  )
  SELECT DISTINCT ON (loser_id) loser_id, target_id FROM hop ORDER BY loser_id, depth DESC;

  SELECT array_agg(loser_id) INTO loser_ids FROM retired_physical_merge;
  IF loser_ids IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM retired_physical_merge m
        LEFT JOIN public.entities s ON s.id = m.survivor_id
        WHERE s.id IS NULL OR m.survivor_id = ANY(loser_ids)) THEN
      RAISE EXCEPTION 'Physical merge redirects point at a missing survivor or form a cycle; point each at its final live survivor before upgrading. List them with: SELECT e.id, e.merged_into FROM entities e LEFT JOIN entities s ON s.id = e.merged_into WHERE e.merged_into IS NOT NULL AND (s.id IS NULL OR s.merged_into IS NOT NULL)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.entities child
        JOIN retired_physical_merge m ON m.loser_id = child.parent_id
        JOIN public.entities other ON other.id <> child.id
          AND other.organization_id = child.organization_id AND other.slug = child.slug
        LEFT JOIN retired_physical_merge om ON om.loser_id = other.parent_id
        WHERE COALESCE(om.survivor_id, other.parent_id) = m.survivor_id) THEN
      RAISE EXCEPTION 'Child records of a merged record share a slug with the survivor''s children; rename or delete one of each pair before upgrading. List them with: SELECT child.id, child.slug, child.parent_id AS merged_parent, parent.merged_into AS survivor FROM entities child JOIN entities parent ON parent.id = child.parent_id JOIN entities sibling ON sibling.parent_id = parent.merged_into AND sibling.slug = child.slug WHERE parent.merged_into IS NOT NULL';
    END IF;

    -- Reference lists: the redirect made a loser read as its survivor, so the
    -- survivor takes the loser's place, once, where the loser first appeared.
    FOREACH array_table IN ARRAY ARRAY['events', 'automations', 'connections', 'feeds', 'classify_facet'] LOOP
      EXECUTE format($remap$
        UPDATE public.%I t SET entity_ids = ARRAY(
          SELECT mapped.id FROM (
            SELECT COALESCE(m.survivor_id, link.id) AS id, min(link.ordinality) AS first_seen
            FROM unnest(t.entity_ids) WITH ORDINALITY AS link(id, ordinality)
            LEFT JOIN retired_physical_merge m ON m.loser_id = link.id
            GROUP BY COALESCE(m.survivor_id, link.id)
          ) mapped ORDER BY mapped.first_seen)
        WHERE t.entity_ids && $1
      $remap$, array_table) USING loser_ids;
    END LOOP;
    UPDATE public.channel_messages c SET author_entity_id = m.survivor_id
    FROM retired_physical_merge m WHERE c.author_entity_id = m.loser_id;
    UPDATE public.entities child SET parent_id = m.survivor_id
    FROM retired_physical_merge m WHERE child.parent_id = m.loser_id;

    UPDATE public.entity_identities i
    SET entity_id = m.survivor_id,
        merged_from_entity_id = COALESCE(i.merged_from_entity_id, m.loser_id),
        updated_at = current_timestamp
    FROM retired_physical_merge m
    WHERE i.entity_id = m.loser_id AND i.deleted_at IS NULL;

    UPDATE public.entity_relationships r
    SET from_entity_id = c.new_from, to_entity_id = c.new_to, updated_at = current_timestamp
    FROM (
      SELECT r.id, r.relationship_type_id,
        COALESCE(mf.survivor_id, r.from_entity_id) AS new_from,
        COALESCE(mt.survivor_id, r.to_entity_id) AS new_to
      FROM public.entity_relationships r
      LEFT JOIN retired_physical_merge mf ON mf.loser_id = r.from_entity_id
      LEFT JOIN retired_physical_merge mt ON mt.loser_id = r.to_entity_id
      WHERE r.deleted_at IS NULL AND (mf.loser_id IS NOT NULL OR mt.loser_id IS NOT NULL)
    ) c
    WHERE r.id = c.id AND c.new_from <> c.new_to
      AND NOT EXISTS (SELECT 1 FROM public.entity_relationship_types t
        WHERE t.id = c.relationship_type_id AND t.purpose IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM public.entity_relationships o
        LEFT JOIN retired_physical_merge mof ON mof.loser_id = o.from_entity_id
        LEFT JOIN retired_physical_merge mot ON mot.loser_id = o.to_entity_id
        WHERE o.deleted_at IS NULL AND o.id <> c.id AND o.relationship_type_id = c.relationship_type_id
          AND COALESCE(mof.survivor_id, o.from_entity_id) = c.new_from
          AND COALESCE(mot.survivor_id, o.to_entity_id) = c.new_to
          AND ((mof.loser_id IS NULL AND mot.loser_id IS NULL) OR o.id < c.id));

    -- Any other foreign key onto entities would cascade or null silently.
    FOR reference IN
      SELECT DISTINCT k.conrelid::regclass AS table_name, a.attname AS column_name
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
      WHERE k.contype = 'f' AND k.confrelid = 'public.entities'::regclass
        AND format('%s.%s', k.conrelid::regclass, a.attname) NOT IN (
          'entities.merged_into', 'entities.parent_id', 'entity_identities.entity_id',
          'entity_relationships.from_entity_id', 'entity_relationships.to_entity_id',
          'channel_messages.author_entity_id', 'write_approval_policies.entity_id',
          'entity_merge_operations.loser_entity_id', 'entity_merge_operations.winner_entity_id')
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = ANY($1))',
        reference.table_name, reference.column_name) INTO referenced USING loser_ids;
      IF referenced THEN
        RAISE EXCEPTION 'Column %.% still references a merged record and this migration does not retarget it; retarget or delete those rows before upgrading',
          reference.table_name, reference.column_name;
      END IF;
    END LOOP;
  END IF;

  -- Undo is retired, so no active ledger may remain for any record; undone
  -- rows stay as audit history once their foreign keys stop pinning entities.
  DELETE FROM public.entity_merge_operations WHERE status = 'active';
  ALTER TABLE public.entity_merge_operations
    DROP CONSTRAINT IF EXISTS entity_merge_operations_winner_entity_id_fkey,
    DROP CONSTRAINT IF EXISTS entity_merge_operations_loser_entity_id_fkey;

  -- A live row carrying a redirect keeps its record; only the pointer goes.
  -- This precedes the delete because entities_merged_into_fkey is NO ACTION.
  UPDATE public.entities SET merged_into = NULL WHERE merged_into IS NOT NULL AND deleted_at IS NULL;

  IF loser_ids IS NOT NULL THEN
    -- Cascades delete authorization edges, including already-tombstoned ones.
    -- Limit the ACL privilege to that deletion; never grant it while repointing.
    previous_acl_write := current_setting('lobu.acl_write', true);
    PERFORM set_config('lobu.acl_write', 'on', true);
    DELETE FROM public.entities WHERE id = ANY(loser_ids) AND deleted_at IS NOT NULL AND merged_into IS NOT NULL;
    GET DIAGNOSTICS removed = ROW_COUNT;
    PERFORM set_config('lobu.acl_write', COALESCE(previous_acl_write, ''), true);
    IF removed <> cardinality(loser_ids) THEN
      RAISE EXCEPTION 'Expected to retire % merged records but removed %', cardinality(loser_ids), removed;
    END IF;
  END IF;

  UPDATE public.entities SET merged_into = NULL WHERE merged_into IS NOT NULL;
END
$retire$;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Physical merge retirement is irreversible; restore a reviewed backup to roll back';
END $$;
