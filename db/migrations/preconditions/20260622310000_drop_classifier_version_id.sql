-- External prerequisite of the classifier contract. Unlike migrations that
-- backfill/rebuild their own data, this one requires the operator's backfill.
-- On a fresh install the expand migration has not created the column yet.
DO $precondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_classifications'
      AND column_name = 'classifier_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.event_classifications WHERE classifier_id IS NULL) THEN
      RAISE EXCEPTION 'event_classifications.classifier_id contains NULL rows; run scripts/backfill-classifier-stable-id.sh before deploying';
    END IF;
  END IF;
END
$precondition$;
