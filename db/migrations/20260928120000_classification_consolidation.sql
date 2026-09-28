-- migrate:up
-- lobu:no-quiesce  (the pre-deploy engine treats a value with no label vector as unmatchable; nothing else reads these keys)

-- Classification consolidation: a classifier is a label schema and labels are
-- written only by `manage_classifiers classify`. The embedding engine that
-- matched events against per-value label vectors is gone, so the vectors
-- stored inside `classify_facet.attribute_values[value]` (`embedding`, plus the
-- `embedding_model` stamp from 20260731150000) have no reader. Strip both keys
-- from every object-shaped value entry and leave every other key alone.
--
-- Columns the retired engine and Automation extraction used
-- (min_similarity, fallback_value, extraction_config, entities.enabled_classifiers,
-- automation_versions.classifiers, event_classifications threshold/embedding
-- columns) are not dropped here: code stops reading and writing them in this
-- release and a follow-up contract migration drops them. Historical
-- `event_classifications` rows are untouched and stay readable.
--
-- OPERATIONAL COST: O(rows) over classify_facet, a config-scale table (29 rows
-- on prod at 20260731140000; one row per classifier, not per event). Regular row
-- locks on the rows that still carry a vector; well under a second. Not tested
-- on a prod-sized copy — there is no events-scaled data involved.
--
-- Rows whose `attribute_values` root is not an object (the legacy array shape
-- guarded in manage_classifiers.ts) are skipped rather than rewritten.

UPDATE public.classify_facet cf
SET attribute_values = (
  SELECT jsonb_object_agg(
    entry.key,
    CASE
      WHEN jsonb_typeof(entry.value) = 'object'
        THEN entry.value - 'embedding' - 'embedding_model'
      ELSE entry.value
    END
  )
  FROM jsonb_each(cf.attribute_values) AS entry
)
WHERE jsonb_typeof(cf.attribute_values) = 'object'
  AND EXISTS (
    SELECT 1
    FROM jsonb_each(cf.attribute_values) AS entry
    WHERE jsonb_typeof(entry.value) = 'object'
      AND (entry.value ? 'embedding' OR entry.value ? 'embedding_model')
  );

-- migrate:down

-- Irreversible by design: the stripped label vectors were derived data with no
-- remaining reader. Restoring them would mean re-embedding every value, which
-- the code this migration ships with can no longer do. PITR is the alternative.
SELECT 1;
