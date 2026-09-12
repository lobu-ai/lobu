/**
 * Feedback action handlers for manage_automations:
 *   submit_feedback, get_feedback, list_promoted
 */

import { getDb } from '../../../db/client';
import { parseJsonObject } from '@lobu/core';
import { ToolUserError } from '../../../utils/errors';
import type { ToolContext } from '../../registry';
import type { ManageAutomationsArgs, ManageAutomationsResult } from '../manage_automations';

type CorrectionInput = {
  field_path: string;
  mutation?: 'set' | 'remove' | 'add';
  value?: unknown;
  note?: string;
};

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parseFieldPath(path: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  for (const part of path.split('.')) {
    const match = part.match(/^([^\[\]]*)((?:\[\d+\])*)$/);
    if (!match) return null;
    if (match[1]) segments.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      segments.push(Number(index[1]));
    }
  }
  return segments.length > 0 && !segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(String(segment)))
    ? segments
    : null;
}

function applyCorrection(
  data: Record<string, unknown>,
  correction: CorrectionInput
): void {
  const path = parseFieldPath(correction.field_path);
  if (!path) return;

  let current: unknown = data;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const next = path[index + 1];
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || segment < 0) return;
      if (current[segment] == null) current[segment] = typeof next === 'number' ? [] : {};
      current = current[segment];
    } else if (current && typeof current === 'object') {
      const object = current as Record<string, unknown>;
      const key = String(segment);
      if (object[key] == null) object[key] = typeof next === 'number' ? [] : {};
      current = object[key];
    } else {
      return;
    }
  }

  const leaf = path[path.length - 1];
  const mutation = correction.mutation ?? 'set';
  if (Array.isArray(current)) {
    if (typeof leaf !== 'number' || leaf < 0) return;
    if (mutation === 'remove') current.splice(leaf, 1);
    else if (mutation === 'add') {
      const prior = current[leaf];
      current[leaf] = Array.isArray(prior)
        ? [...prior, correction.value]
        : prior == null
          ? [correction.value]
          : [prior, correction.value];
    } else current[leaf] = correction.value;
    return;
  }
  if (!current || typeof current !== 'object') return;
  const object = current as Record<string, unknown>;
  const key = String(leaf);
  if (mutation === 'remove') delete object[key];
  else if (mutation === 'add') {
    const prior = object[key];
    object[key] = Array.isArray(prior)
      ? [...prior, correction.value]
      : prior == null
        ? [correction.value]
        : [prior, correction.value];
  } else object[key] = correction.value;
}

// ============================================
// handleSubmitFeedback
// ============================================

export async function handleSubmitFeedback(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<ManageAutomationsResult> {
  if (!args.automation_id) throw new ToolUserError('automation_id is required', 400);
  if (!args.run_id) throw new ToolUserError('run_id is required', 400);
  if (!ctx.userId) {
    throw new ToolUserError('Authentication required to submit feedback', 403);
  }
  const corrections = args.corrections as CorrectionInput[] | undefined;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    throw new ToolUserError(
      'corrections must be a non-empty array of {field_path, ...} entries',
      400
    );
  }

  for (const c of corrections) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new ToolUserError(
        'each correction must be an object with a string field_path',
        400
      );
    }
    if (!c.field_path || typeof c.field_path !== 'string') {
      throw new ToolUserError('each correction requires a string field_path', 400);
    }
    const m = c.mutation ?? 'set';
    if (m !== 'set' && m !== 'remove' && m !== 'add') {
      throw new ToolUserError(`unsupported mutation "${m}" for ${c.field_path}`, 400);
    }
    if ((m === 'set' || m === 'add') && c.value === undefined) {
      throw new ToolUserError(`${m} correction for ${c.field_path} requires a value`, 400);
    }
  }

  const sql = getDb();
  const automationId = Number(args.automation_id);

  const organizationId = ctx.organizationId;

  // Correction-events (P1): every submit emits a correction event directly to the events spine
  // (semantic_type='correction'). The correction EVENT's id is the feedback id
  // (origin_id stays NULL); historical rows carry origin_id 'wwff_<seq>' from the
  // retired sequence and readers still parse those.
  // One transaction so a partial failure never leaks half-applied corrections.
  const feedbackIds = await sql.begin(async (tx) => {
    const [run] = await tx`
      SELECT action_output
      FROM runs
      WHERE id = ${args.run_id}
        AND automation_id = ${automationId}
        AND organization_id = ${organizationId}
        AND run_type = 'automation'
        AND status = 'completed'
        AND action_output IS NOT NULL
      FOR UPDATE
    `;
    if (!run) {
      throw new ToolUserError(
        `Result run ${args.run_id} not found for Automation ${automationId}`,
        404
      );
    }
    const correctedOutput = structuredClone(parseJsonObject(run.action_output));
    for (const correction of corrections) applyCorrection(correctedOutput, correction);

    const ids: number[] = [];
    for (const c of corrections) {
      const mutation = c.mutation ?? 'set';
      const correctedValueJson =
        mutation === 'remove' || c.value === undefined ? null : tx.json(c.value);
      const [row] = await tx`
        INSERT INTO events (
          organization_id, semantic_type, entity_ids, run_id, metadata,
          created_by, occurred_at, created_at
        )
        SELECT
          ${organizationId}, 'correction', '{}'::bigint[], ${args.run_id}::bigint,
          jsonb_build_object(
            'automation_id', ${automationId}::bigint,
            'field_path', ${c.field_path}::text,
            'mutation', ${mutation}::text,
            'corrected_value', ${correctedValueJson}::jsonb,
            'note', ${c.note ?? null}::text
          ),
          (SELECT u.id FROM "user" u WHERE u.id = ${ctx.userId}),
          NOW(), NOW()
        RETURNING id
      `;
      ids.push(Number(row.id));
    }

    await tx`
      UPDATE runs
      SET action_output = ${tx.json(correctedOutput)}
      WHERE id = ${args.run_id}
    `;

    return ids;
  });

  return {
    action: 'submit_feedback',
    automation_id: args.automation_id,
    run_id: args.run_id,
    feedback_ids: feedbackIds,
  };
}

// ============================================
// handleGetFeedback
// ============================================

export async function handleGetFeedback(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<ManageAutomationsResult> {
  if (!args.automation_id) throw new ToolUserError('automation_id is required', 400);

  const sql = getDb();
  const automationId = Number(args.automation_id);
  const limit = args.limit ?? 50;

  // Scope to the caller's current org so a member of org A can't enumerate feedback for an automation
  // in org B by passing its automation_id. Correction-events (P1): read from the events spine
  // (semantic_type='correction'); the feedback id is the event id for current rows,
  // or recovered from origin_id 'wwff_<id>' for historical (pre-3b) rows.
  // created_by is the author user id, or NULL once that user is deleted (events.created_by FK
  // SET NULL) — the dangling-id automation the retired table had is intentionally not reproduced.
  const feedback = args.run_id
    ? await sql`
        SELECT COALESCE((substring(e.origin_id from 6))::bigint, e.id) AS id,
               e.run_id,
               e.metadata->>'field_path' AS field_path, e.metadata->>'mutation' AS mutation,
               e.metadata->'corrected_value' AS corrected_value, e.metadata->>'note' AS note,
               e.created_by, e.created_at,
               (w.approved_input->>'window_start')::timestamptz AS window_start,
               (w.approved_input->>'window_end')::timestamptz AS window_end
        FROM events e
        LEFT JOIN runs w ON w.id = e.run_id
        WHERE e.semantic_type = 'correction'
          AND (e.metadata->>'automation_id')::bigint = ${automationId}
          AND e.run_id = ${args.run_id}
          AND e.organization_id = ${ctx.organizationId}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT COALESCE((substring(e.origin_id from 6))::bigint, e.id) AS id,
               e.run_id,
               e.metadata->>'field_path' AS field_path, e.metadata->>'mutation' AS mutation,
               e.metadata->'corrected_value' AS corrected_value, e.metadata->>'note' AS note,
               e.created_by, e.created_at,
               (w.approved_input->>'window_start')::timestamptz AS window_start,
               (w.approved_input->>'window_end')::timestamptz AS window_end
        FROM events e
        LEFT JOIN runs w ON w.id = e.run_id
        WHERE e.semantic_type = 'correction'
          AND (e.metadata->>'automation_id')::bigint = ${automationId}
          AND e.organization_id = ${ctx.organizationId}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `;

  return {
    action: 'get_feedback',
    automation_id: args.automation_id,
    feedback: feedback.map((row) => ({
      id: Number(row.id),
      run_id: Number(row.run_id),
      field_path: row.field_path as string,
      mutation: row.mutation as 'set' | 'remove' | 'add',
      corrected_value: row.corrected_value as unknown,
      note: row.note as string | null,
      created_by: row.created_by as string,
      created_at: (row.created_at as Date).toISOString(),
      window_start: row.window_start ? (row.window_start as Date).toISOString() : undefined,
      window_end: row.window_end ? (row.window_end as Date).toISOString() : undefined,
    })),
  };
}

// ============================================
// handleListPromoted
// ============================================

/**
 * List the entities an automation promoted (its keyed children) — the automation's
 * durable product. Each row carries the entity's metadata (the extracted
 * field values) plus `field_controls` (which fields a human already owns).
 * The web activity view uses only the count + entity_type for its outputs
 * strip; field ownership/corrections live on the entity page. Promoted
 * children stamp `metadata.automation_id` and hold an `automation_key` identity.
 * `source` is a domain field and can contain the original evidence URL.
 *
 * Org-scoped so a member of org A can't enumerate org B's promoted entities by
 * passing an automation_id (auth also gates on requireAutomationAccess 'read').
 */
export async function handleListPromoted(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<ManageAutomationsResult> {
  if (!args.automation_id) throw new ToolUserError('automation_id is required', 400);

  const sql = getDb();
  const automationId = String(Number(args.automation_id));
  const limit = args.limit ?? 200;

  const rows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.metadata, e.field_controls
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${ctx.organizationId}
      AND e.deleted_at IS NULL
      AND e.metadata->>'automation_id' = ${automationId}
      AND EXISTS (
        SELECT 1 FROM entity_identities ei
        WHERE ei.organization_id = e.organization_id
          AND ei.entity_id = e.id
          AND ei.namespace = 'automation_key'
          AND ei.deleted_at IS NULL
      )
    ORDER BY e.name
    LIMIT ${limit}
  `;

  return {
    action: 'list_promoted',
    automation_id: args.automation_id,
    entities: rows.map((row) => {
      const metadata = parseJsonObject(row.metadata);
      const fieldControls = parseJsonObject(row.field_controls);
      const runIdRaw = metadata.run_id;
      const stableKeyRaw = metadata.stable_key;
      return {
        id: Number(row.id),
        name: row.name as string,
        entity_type: row.entity_type as string,
        metadata,
        field_controls: fieldControls,
        run_id: runIdRaw == null || runIdRaw === '' ? null : Number(runIdRaw),
        stable_key: stableKeyRaw == null ? null : String(stableKeyRaw),
      };
    }),
  };
}
