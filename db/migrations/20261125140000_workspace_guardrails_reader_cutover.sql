-- migrate:up
-- lobu:quiesce old replicas read and write agents.guardrails and agents.guardrails_inline as the source of agent guardrails; one serving after the backfill could change a guardrail the library never sees

-- Guardrails reader cutover (P5a). Agent guardrails move from agents.guardrails
-- (built-in names) and agents.guardrails_inline (custom checks) to the
-- workspace library (workspace_guardrails + workspace_guardrail_subjects).
-- The deploy quiesces (see the declaration above), so no old replica writes
-- either column after the backfill reads it. The columns stay until a later
-- cleanup drops them, so a code rollback still finds the data it reads.
--
-- Library config shapes:
--   built-in: {"builtin": "<secret-scan|pii-scan|forbidden-tools>"}
--   custom:   the inline entry without name/enabled, kind defaulted to judge:
--             {"kind", "stage", "policy"?, "model"?, "tools"?, "domains"?}
--
-- Only organizations with no library rows are processed, so a re-run is a
-- no-op. Agents are ordered by id (byte order) and inline checks by their array
-- index; every name and id is a function of that input.
DO $backfill$
DECLARE
  offenders text;
  pending record;
  taken text[];
  candidate text;
  n integer;
  current_org text := NULL;
  report record;
BEGIN
  CREATE TEMP TABLE guardrail_backfill_agents AS
  SELECT a.organization_id AS org, a.id AS agent_id, a.guardrails, a.guardrails_inline
  FROM agents a
  WHERE NOT EXISTS (
    SELECT 1 FROM workspace_guardrails wg WHERE wg.organization_id = a.organization_id
  );

  CREATE TEMP TABLE guardrail_backfill_builtins AS
  SELECT org, agent_id, (e.ord - 1)::integer AS idx, e.item
  FROM guardrail_backfill_agents
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(guardrails) = 'array' THEN guardrails ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS e(item, ord);

  CREATE TEMP TABLE guardrail_backfill_items AS
  SELECT org, agent_id, (e.ord - 1)::integer AS idx, e.item
  FROM guardrail_backfill_agents
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(guardrails_inline) = 'array' THEN guardrails_inline ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS e(item, ord);

  -- Preflight: abort with every offender rather than drop data silently. The
  -- checks mirror the retired settings write validator, plus the built-in
  -- registry's names.
  SELECT string_agg(format('org=%s agent=%s %s', org, agent_id, problem), E'\n' ORDER BY org, agent_id, problem)
  INTO offenders
  FROM (
    SELECT org, agent_id, 'guardrails is not an array' AS problem
    FROM guardrail_backfill_agents
    WHERE guardrails IS NOT NULL AND jsonb_typeof(guardrails) NOT IN ('array', 'null')
    UNION ALL
    SELECT org, agent_id, 'guardrails_inline is not an array'
    FROM guardrail_backfill_agents
    WHERE guardrails_inline IS NOT NULL AND jsonb_typeof(guardrails_inline) NOT IN ('array', 'null')
    UNION ALL
    SELECT org, agent_id, format('guardrails[%s] is not a built-in guardrail name (secret-scan, pii-scan, forbidden-tools)', idx)
    FROM guardrail_backfill_builtins
    WHERE jsonb_typeof(item) <> 'string'
       OR item #>> '{}' NOT IN ('secret-scan', 'pii-scan', 'forbidden-tools')
    UNION ALL
    SELECT org, agent_id, format('guardrails_inline[%s] is not an object', idx)
    FROM guardrail_backfill_items WHERE jsonb_typeof(item) <> 'object'
    UNION ALL
    SELECT org, agent_id, format('guardrails_inline[%s].%s', idx, problem)
    FROM guardrail_backfill_items
    CROSS JOIN LATERAL (
      SELECT CASE WHEN item ? 'kind' THEN item ->> 'kind' ELSE 'judge' END AS kind
    ) k
    CROSS JOIN LATERAL (
      VALUES
        (CASE WHEN NOT COALESCE(jsonb_typeof(item -> 'name') = 'string' AND item ->> 'name' ~ '[^[:space:]]', false)
              THEN 'name must be a non-empty string' END),
        (CASE WHEN COALESCE(jsonb_typeof(item -> 'enabled'), '') <> 'boolean'
              THEN 'enabled must be a boolean' END),
        (CASE WHEN COALESCE(item ->> 'stage', '') NOT IN ('input', 'output', 'pre-tool', 'egress')
                OR jsonb_typeof(item -> 'stage') <> 'string'
              THEN 'stage must be one of: input, output, pre-tool, egress' END),
        (CASE WHEN item ? 'kind' AND (jsonb_typeof(item -> 'kind') <> 'string' OR k.kind NOT IN ('judge', 'require-tool'))
              THEN 'kind must be "judge" or "require-tool"' END),
        (CASE WHEN item ? 'model' AND jsonb_typeof(item -> 'model') <> 'string'
              THEN 'model must be a string' END),
        (CASE WHEN item ? 'domains' AND (jsonb_typeof(item -> 'domains') <> 'array'
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item -> 'domains') = 'array' THEN item -> 'domains' ELSE '[]'::jsonb END) d WHERE jsonb_typeof(d) <> 'string'))
              THEN 'domains must be an array of strings' END),
        (CASE WHEN item ? 'policy' AND jsonb_typeof(item -> 'policy') <> 'string'
              THEN 'policy must be a string' END),
        (CASE WHEN k.kind = 'require-tool' AND item ->> 'stage' <> 'output'
              THEN 'stage: require-tool only supports stage "output"' END),
        (CASE WHEN k.kind = 'require-tool' AND (jsonb_typeof(item -> 'tools') IS DISTINCT FROM 'array'
                OR jsonb_array_length(CASE WHEN jsonb_typeof(item -> 'tools') = 'array' THEN item -> 'tools' ELSE '[]'::jsonb END) = 0
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item -> 'tools') = 'array' THEN item -> 'tools' ELSE '[]'::jsonb END) t
                           WHERE jsonb_typeof(t) <> 'string' OR NOT (t #>> '{}') ~ '[^[:space:]]'))
              THEN 'tools must be a non-empty array of tool names for require-tool' END),
        (CASE WHEN k.kind = 'judge' AND NOT COALESCE(jsonb_typeof(item -> 'policy') = 'string' AND item ->> 'policy' ~ '[^[:space:]]', false)
              THEN 'policy must be a non-empty string' END),
        (CASE WHEN k.kind = 'judge' AND item ? 'tools' AND (jsonb_typeof(item -> 'tools') <> 'array'
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item -> 'tools') = 'array' THEN item -> 'tools' ELSE '[]'::jsonb END) t WHERE jsonb_typeof(t) <> 'string'))
              THEN 'tools must be an array of strings' END)
    ) AS v(problem)
    WHERE jsonb_typeof(item) = 'object' AND v.problem IS NOT NULL
  ) problems;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION E'workspace guardrail backfill aborted; fix these agent guardrails and re-run:\n%', offenders
      USING ERRCODE = 'check_violation';
  END IF;

  -- Normalize each custom check: name, config, enabled.
  CREATE TEMP TABLE guardrail_backfill_norm AS
  SELECT org, agent_id, idx,
         item ->> 'name' AS raw_name,
         rtrim(left(CASE WHEN slug = '' THEN 'guardrail' ELSE slug END, 64), '-') AS norm_name,
         (item - 'name' - 'enabled')
           || jsonb_build_object('kind', CASE WHEN item ? 'kind' THEN item ->> 'kind' ELSE 'judge' END) AS config,
         (item -> 'enabled') = 'true'::jsonb AS enabled
  FROM guardrail_backfill_items
  CROSS JOIN LATERAL (
    SELECT btrim(regexp_replace(lower(item ->> 'name'), '[^a-z0-9]+', '-', 'g'), '-') AS slug
  ) s;

  -- One library row per distinct (name, config, enabled) tuple, ranked by its
  -- first occurrence in (agent id, array index) order.
  CREATE TEMP TABLE guardrail_backfill_tuples AS
  SELECT org, norm_name, config, enabled,
         (array_agg(agent_id ORDER BY agent_id COLLATE "C", idx))[1] AS first_agent,
         (array_agg(idx ORDER BY agent_id COLLATE "C", idx))[1] AS first_idx,
         NULL::text AS final_name
  FROM guardrail_backfill_norm
  GROUP BY org, norm_name, config, enabled;

  -- Built-ins keep their own names; the first custom tuple for any other
  -- normalized name keeps it.
  UPDATE guardrail_backfill_tuples t
  SET final_name = t.norm_name
  WHERE NOT EXISTS (
    SELECT 1 FROM guardrail_backfill_builtins b
    WHERE b.org = t.org AND b.item #>> '{}' = t.norm_name
  )
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_backfill_tuples o
    WHERE o.org = t.org AND o.norm_name = t.norm_name
      AND (o.first_agent COLLATE "C", o.first_idx) < (t.first_agent COLLATE "C", t.first_idx)
  );

  -- Every later tuple takes the first free <base>-<n>, checked against the
  -- org's whole set of taken names (built-ins included) so a suffix never
  -- collides with a natural name.
  FOR pending IN
    SELECT ctid AS row_ref, org, norm_name
    FROM guardrail_backfill_tuples
    WHERE final_name IS NULL
    ORDER BY org COLLATE "C", first_agent COLLATE "C", first_idx
  LOOP
    IF current_org IS DISTINCT FROM pending.org THEN
      current_org := pending.org;
      SELECT COALESCE(array_agg(name), ARRAY[]::text[]) INTO taken
      FROM (
        SELECT final_name AS name FROM guardrail_backfill_tuples
        WHERE org = pending.org AND final_name IS NOT NULL
        UNION
        SELECT item #>> '{}' FROM guardrail_backfill_builtins WHERE org = pending.org
      ) names;
    END IF;
    n := 2;
    LOOP
      candidate := rtrim(left(pending.norm_name, 64 - length('-' || n)), '-') || '-' || n;
      EXIT WHEN NOT (candidate = ANY (taken));
      n := n + 1;
    END LOOP;
    taken := taken || candidate;
    UPDATE guardrail_backfill_tuples SET final_name = candidate WHERE ctid = pending.row_ref;
  END LOOP;

  -- Built-ins: one row per built-in an org's agents enable, applying to
  -- exactly those agents.
  INSERT INTO workspace_guardrails (id, organization_id, name, config, enabled)
  SELECT DISTINCT 'guardrail_' || md5(org || '/' || (item #>> '{}')), org, item #>> '{}',
         jsonb_build_object('builtin', item #>> '{}'), true
  FROM guardrail_backfill_builtins
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO workspace_guardrail_subjects (guardrail_id, organization_id, principal_kind, principal_id)
  SELECT DISTINCT 'guardrail_' || md5(org || '/' || (item #>> '{}')), org, 'agent', agent_id
  FROM guardrail_backfill_builtins
  ON CONFLICT DO NOTHING;

  INSERT INTO workspace_guardrails (id, organization_id, name, config, enabled)
  SELECT 'guardrail_' || md5(org || '/' || final_name), org, final_name, config, enabled
  FROM guardrail_backfill_tuples
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO workspace_guardrail_subjects (guardrail_id, organization_id, principal_kind, principal_id)
  SELECT DISTINCT 'guardrail_' || md5(t.org || '/' || t.final_name), t.org, 'agent', n.agent_id
  FROM guardrail_backfill_norm n
  JOIN guardrail_backfill_tuples t
    ON t.org = n.org AND t.norm_name = n.norm_name AND t.config = n.config AND t.enabled = n.enabled
  ON CONFLICT DO NOTHING;

  -- Report: renamed checks and split names. A check renamed off a built-in's
  -- name, or off a name another check on the same agent already held, was
  -- shadowed before and now runs alongside it (guardrails accumulate).
  FOR report IN
    SELECT DISTINCT n.org, n.agent_id, n.idx, n.raw_name, t.final_name,
           EXISTS (
             SELECT 1 FROM guardrail_backfill_builtins b
             WHERE b.org = n.org AND b.item #>> '{}' = n.norm_name
           ) AS builtin_name
    FROM guardrail_backfill_norm n
    JOIN guardrail_backfill_tuples t
      ON t.org = n.org AND t.norm_name = n.norm_name AND t.config = n.config AND t.enabled = n.enabled
    WHERE n.raw_name IS DISTINCT FROM t.final_name
    ORDER BY n.org, n.agent_id, n.idx
  LOOP
    RAISE NOTICE 'workspace guardrail backfill: renamed org=% agent=% guardrails_inline[%] % -> %',
      report.org, report.agent_id, report.idx, report.raw_name,
      report.final_name || CASE WHEN report.builtin_name THEN ' (the built-in keeps the name)' ELSE '' END;
  END LOOP;

  FOR report IN
    SELECT org, norm_name, string_agg(final_name, ', ' ORDER BY first_agent COLLATE "C", first_idx) AS names
    FROM guardrail_backfill_tuples
    GROUP BY org, norm_name
    HAVING count(*) > 1
    ORDER BY org, norm_name
  LOOP
    RAISE NOTICE 'workspace guardrail backfill: split org=% name=% into %',
      report.org, report.norm_name, report.names;
  END LOOP;

  DROP TABLE guardrail_backfill_agents, guardrail_backfill_builtins, guardrail_backfill_items,
    guardrail_backfill_norm, guardrail_backfill_tuples;
END
$backfill$;

-- migrate:down

-- The backfill's rows carry its deterministic ids; P5a adds no library writers.
DELETE FROM workspace_guardrails WHERE id ~ '^guardrail_[0-9a-f]{32}$';
