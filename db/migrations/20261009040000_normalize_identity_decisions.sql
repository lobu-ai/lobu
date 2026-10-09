-- migrate:up
-- lobu:no-quiesce
-- Add the original pair to the canonical member map without changing evidence,
-- decisions, timestamps, or deleted state.
-- Historical decisions can be withdrawn; their guard intentionally
-- forbids edits, even for privileged identity writes. Disable only that guard
-- under the transaction's table lock, then restore it before commit. A failure
-- rolls back both data and trigger state. Bound lock acquisition to 5 seconds.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION pg_temp.normalize_identity_decision(decision jsonb, pair_key text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE members jsonb := decision->'member_support';
BEGIN
  IF jsonb_typeof(decision) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid identity decision object; inspect history before upgrading';
  END IF;
  IF members IS NOT NULL AND jsonb_typeof(members) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid identity member support map; inspect history before upgrading';
  END IF;
  IF members ? pair_key THEN RETURN decision; END IF;
  RETURN jsonb_set(decision, '{member_support}', COALESCE(members, '{}'::jsonb) ||
    jsonb_build_object(pair_key, COALESCE(decision->'suppression_support', decision->'support', 'null'::jsonb)));
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.entity_relationships'::regclass
    AND tgname = 'lobu_guard_identity_edges' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Expected enabled identity edge guard before normalizing history';
  END IF;
END $$;
ALTER TABLE public.entity_relationships DISABLE TRIGGER lobu_guard_identity_edges;
UPDATE public.entity_relationships
SET metadata = jsonb_set(metadata, '{_lobu_identity_decision}', pg_temp.normalize_identity_decision(
  metadata->'_lobu_identity_decision', format('[%s,%s]', LEAST(from_entity_id, to_entity_id), GREATEST(from_entity_id, to_entity_id))))
WHERE metadata ? '_lobu_identity_decision'
  AND metadata->'_lobu_identity_decision' IS DISTINCT FROM pg_temp.normalize_identity_decision(
    metadata->'_lobu_identity_decision', format('[%s,%s]', LEAST(from_entity_id, to_entity_id), GREATEST(from_entity_id, to_entity_id)));
ALTER TABLE public.entity_relationships ENABLE TRIGGER lobu_guard_identity_edges;

-- Old pending proposals remain stale: do not invent evidence fingerprints or
-- prior-decision references. Rejection must still retain their original support.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM runs WHERE action_key = 'entity_change'
    AND action_input->>'operation' IN ('link', 'unlink') AND action_input ? 'identity_pair'
    AND (action_input->>'identity_pair' IS NULL
      OR action_input->>'identity_pair' !~ '^\[[1-9][0-9]*,[1-9][0-9]*\]$')) THEN
    RAISE EXCEPTION 'Invalid identity pair key; inspect history before upgrading';
  END IF;
END $$;
UPDATE public.runs SET action_input = pg_temp.normalize_identity_decision(action_input, action_input->>'identity_pair')
WHERE action_key = 'entity_change' AND action_input->>'operation' IN ('link', 'unlink') AND action_input ? 'identity_pair'
  AND action_input IS DISTINCT FROM pg_temp.normalize_identity_decision(action_input, action_input->>'identity_pair');
DROP FUNCTION pg_temp.normalize_identity_decision(jsonb, text);

-- migrate:down
-- Additive history normalization is safe to retain with older readers.
SELECT 1;
