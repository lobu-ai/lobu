-- migrate:up
-- lobu:no-quiesce  (additive: a defaulted column and a widened CHECK; pre-deploy code neither reads the column nor writes the new source)

-- A classifier picks how `apply` labels content: 'embedding' (label-vector cosine match, the
-- existing behaviour and the default) or 'service' (an external classification service speaking
-- the POST /v1/classify contract, configured by CLASSIFIER_SERVICE_URL).
--
-- OPERATIONAL COST: classify_facet is config-scale (one row per classifier). ADD COLUMN with a
-- constant DEFAULT is a metadata-only change on PG11+.
ALTER TABLE public.classify_facet
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'embedding';

ALTER TABLE public.classify_facet DROP CONSTRAINT IF EXISTS classify_facet_engine_check;
-- squawk-ignore constraint-missing-not-valid -- config-scale table; the validating scan is trivial
ALTER TABLE public.classify_facet ADD CONSTRAINT classify_facet_engine_check CHECK (engine IN ('embedding', 'service'));

-- Rows written by the service engine carry source 'service'.
--
-- OPERATIONAL COST: event_classifications is events-scaled. The replacement CHECK is added
-- NOT VALID, so it is an O(1) catalog change that enforces new writes only. Every existing row
-- already satisfied the narrower predicate, so skipping VALIDATE loses nothing.
ALTER TABLE public.event_classifications DROP CONSTRAINT IF EXISTS event_classifications_source_check;
ALTER TABLE public.event_classifications
  ADD CONSTRAINT event_classifications_source_check
  CHECK (source IN ('embedding', 'llm', 'user', 'service')) NOT VALID;

-- migrate:down
DELETE FROM public.event_classifications WHERE source = 'service';
ALTER TABLE public.event_classifications DROP CONSTRAINT IF EXISTS event_classifications_source_check;
ALTER TABLE public.event_classifications
  ADD CONSTRAINT event_classifications_source_check
  CHECK (source IN ('embedding', 'llm', 'user')) NOT VALID;
ALTER TABLE public.classify_facet DROP CONSTRAINT IF EXISTS classify_facet_engine_check;
ALTER TABLE public.classify_facet DROP COLUMN IF EXISTS engine;
