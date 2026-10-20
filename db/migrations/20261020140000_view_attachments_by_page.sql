-- migrate:up
-- lobu:quiesce running code matches and writes the retired type/entity/placement/surface/event_kind attach shapes
-- View attachments name a page by key: { record, id? }, { collection, when? },
-- { workspace: true } and { event, type? }. Placement is gone: a record view
-- renders as a card on the record page and opens fullscreen from there.
--   { type }                    -> { collection } and { record } (it showed on both)
--   { type, surface: record }   -> { record }
--   { type, surface: collection, when? } -> { collection, when? }
--   { entity: <id or top-level slug> }   -> { record: <its type>, id }
--     (a pin whose record no longer exists is dropped: it rendered nowhere)
--   { workspace: true, placement? }      -> { workspace: true }
--   { event_kind, type? }       -> { event, type? }
-- Lock safety: `views` holds one row per authored view, not per render or event.
UPDATE public.views v
SET attach = COALESCE((
  SELECT jsonb_agg(m.entry ORDER BY a.ord, m.sub)
  FROM jsonb_array_elements(v.attach) WITH ORDINALITY AS a(x, ord)
  CROSS JOIN LATERAL (
    SELECT 1 AS sub,
      jsonb_strip_nulls(jsonb_build_object('event', a.x->'event_kind', 'type', a.x->'type')) AS entry
    WHERE a.x ? 'event_kind'
    UNION ALL
    SELECT 1, '{"workspace": true}'::jsonb
    WHERE a.x ? 'workspace'
    UNION ALL
    SELECT 1, jsonb_strip_nulls(jsonb_build_object('collection', a.x->'type', 'when', a.x->'when'))
    WHERE a.x ? 'type' AND NOT a.x ? 'event_kind'
      AND COALESCE(a.x->>'surface', '') <> 'record'
    UNION ALL
    SELECT 2, jsonb_build_object('record', a.x->'type')
    WHERE a.x ? 'type' AND NOT a.x ? 'event_kind'
      AND COALESCE(a.x->>'surface', '') <> 'collection'
    UNION ALL
    SELECT 1, jsonb_build_object('record', et.slug, 'id', e.id)
    FROM public.entities e
    JOIN public.entity_types et ON et.id = e.entity_type_id
    WHERE a.x ? 'entity'
      AND e.organization_id = v.organization_id
      AND e.deleted_at IS NULL
      AND (
        (jsonb_typeof(a.x->'entity') = 'number' AND e.id = (a.x->>'entity')::bigint)
        OR (jsonb_typeof(a.x->'entity') = 'string' AND e.parent_id IS NULL AND e.slug = a.x->>'entity')
      )
  ) m
), '[]'::jsonb)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(v.attach) x
  WHERE x ?| ARRAY['entity', 'event_kind', 'placement', 'surface']
     OR (x ? 'type' AND NOT x ? 'event')
);

-- migrate:down
-- Record views come back as Overview cards; a pinned record keeps its id.
UPDATE public.views v
SET attach = COALESCE((
  SELECT jsonb_agg(
    CASE
      WHEN a.x ? 'event' THEN jsonb_strip_nulls(jsonb_build_object('event_kind', a.x->'event', 'type', a.x->'type'))
      WHEN a.x ? 'collection' THEN jsonb_strip_nulls(jsonb_build_object('type', a.x->'collection', 'surface', 'collection', 'when', a.x->'when'))
      WHEN a.x ? 'id' THEN jsonb_build_object('entity', a.x->'id', 'placement', 'overview')
      WHEN a.x ? 'record' THEN jsonb_build_object('type', a.x->'record', 'surface', 'record', 'placement', 'overview')
      ELSE a.x
    END ORDER BY a.ord)
  FROM jsonb_array_elements(v.attach) WITH ORDINALITY AS a(x, ord)
), '[]'::jsonb)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(v.attach) x
  WHERE x ?| ARRAY['record', 'collection', 'event']
);
