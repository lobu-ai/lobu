import { describe, expect, it } from 'bun:test';
import { resolveWindowQueryContext } from '../../../automations/window-read-context';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { generateWindowToken } from '../../../utils/jwt';

const env = { JWT_SECRET: 'test-window-query-validation-only' } as Env;
const payload = {
  automation_id: 42,
  run_id: 84,
  window_start: '2026-08-01T10:00:00.000Z',
  window_end: '2026-08-01T11:00:00.000Z',
  content_count: 0,
  content_ids: [],
};

describe('SQL window token input errors', () => {
  it('reports malformed, altered and expired tokens as client errors before reading the database', async () => {
    const token = await generateWindowToken(payload, env);
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...payload, run_id: 85 })).toString('base64url');
    // Expiry is minted by the signer, so issue the token under an old clock.
    const now = Date.now;
    let oldToken: string;
    try {
      Date.now = () => 1_000;
      oldToken = await generateWindowToken(payload, env);
    } finally {
      Date.now = now;
    }
    for (const invalid of ['malformed', parts.join('.'), oldToken]) {
      await expect(resolveWindowQueryContext(invalid, env, {} as ToolContext, {} as DbClient))
        .rejects.toMatchObject({ name: 'ToolUserError', httpStatus: 400 });
    }
  });
});
