import { getDb, pgTextArray } from '../db/client';
import { classifyRunOutcome } from '../runs/run-outcome';
import logger from '../utils/logger';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY } from './device-feed-read-protocol';

/** Terminalize and scrub atomically, so late claims/completions cannot restore payloads. */
export async function scrubSourceReadRun(
  runId: number,
  organizationId: string,
  feedKey?: string,
  status: 'completed' | 'failed' | 'timeout' = 'timeout',
): Promise<void> {
  const sql = getDb();
  const inFlight = pgTextArray(['pending', 'claimed', 'running']);
  try {
    await sql`
      UPDATE runs
      SET action_output = NULL,
          action_input = CASE WHEN run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} = 'true'
            THEN '{"scrubbed":true}'::jsonb
            ELSE ${sql.json({ scrubbed: true, ...(feedKey ? { feed_key: feedKey } : {}) })} END,
          status = CASE WHEN status = ANY(${inFlight}::text[]) THEN ${status} ELSE status END,
          outcome = CASE WHEN status = ANY(${inFlight}::text[])
            THEN ${classifyRunOutcome({ status })} ELSE outcome END,
          completed_at = CASE WHEN status = ANY(${inFlight}::text[])
            THEN current_timestamp ELSE completed_at END,
          error_message = CASE
            WHEN run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} = 'true' THEN NULL
            WHEN status = ANY(${inFlight}::text[])
              THEN ${`Feed '${feedKey}' source read was abandoned before the device answered.`}
            ELSE error_message END
      WHERE id = ${runId} AND organization_id = ${organizationId} AND run_type = 'action'
        AND (action_key = ${DEVICE_FEED_READ_ACTION_KEY}
          OR run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} = 'true')
    `;
  } catch (err) {
    // Recovery is owned by the stale-run reaper; retrying a successful source
    // read here would only create another transient payload.
    logger.error({ runId, organizationId, err }, '[source-read] failed to scrub run payload');
  }
}
