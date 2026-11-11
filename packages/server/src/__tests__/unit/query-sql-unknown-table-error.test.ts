/**
 * query_sql must NEVER render an unknown/disallowed table as an empty result set.
 *
 * The bug: `validateAndScopeQuery` correctly throws an unknown-table error, and
 * `querySqlImpl` catches it into a soft `{ rows: [], error }` result — but
 * `formatQuerySqlResult` (the ONLY thing an MCP caller sees, since `query_sql`
 * declares no `outputSchema`) destructured just `{ rows, total_count,
 * execution_time_ms }`. The `error` field was dropped on the floor, so
 * `SELECT … FROM conversations` rendered as a clean "Rows: 0" — indistinguishable
 * from "the query ran and there was no data".
 *
 * Contrast: `client.query` (query_sdk) lets the same throw propagate, so it
 * reports `Unknown table 'conversations'` honestly. These two paths must agree.
 */

import { describe, expect, it } from 'bun:test';
import { formatToolResult } from '../../formatting/markdown-formatter';
import { isSoftErrorResult } from '../../tools/execute';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import {
  ADMIN_ONLY_QUERYABLE_TABLES,
  SAFE_COLUMN_DEFS,
  validateTableQuery,
} from '../../utils/table-schema';

describe('query_sql unknown-table errors are never rendered as an empty result', () => {
  it('shared validation seam throws (not returns empty) for an unknown table', () => {
    // This is the contract query_sdk/client.query already exposes verbatim.
    expect(() =>
      validateAndScopeQuery('SELECT platform FROM conversations', 'org_1', {
        safeColumns: SAFE_COLUMN_DEFS,
      })
    ).toThrow(/conversations/);
  });

  it('names the queryable tables so the caller can retry against a real one', () => {
    let message = '';
    try {
      validateAndScopeQuery('SELECT platform FROM conversations', 'org_1', {
        safeColumns: SAFE_COLUMN_DEFS,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/conversations/);
    // A bare rejection is not actionable — the allowlist is a known finite set.
    expect(message).toMatch(/queryable tables/i);
    expect(message).toMatch(/\bevents\b/);
  });

  it('reports multiple unknown tables once without repeating the allowlist', () => {
    const result = validateTableQuery(
      'SELECT * FROM conversations c JOIN messages m ON c.id = m.conversation_id'
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('conversations');
    expect(result.errors[0]).toContain('messages');
    expect(result.errors[0].match(/Queryable tables are:/g)).toHaveLength(1);
  });

  it('formatter surfaces the error instead of a clean "Rows: 0" table', () => {
    const md = formatToolResult('query_sql', {
      rows: [],
      columns: [],
      total_count: 0,
      has_more: false,
      execution_time_ms: 3,
      error: "Unknown table 'conversations'. Queryable tables are: events, entities.",
      error_code: 'VALIDATION',
      retryable: false,
    });

    expect(md).toContain('conversations');
    expect(md).toMatch(/error/i);
    // The failure mode we are fixing: a success-shaped result table.
    expect(md).not.toMatch(/SQL Query Results \(CSV\)/);
  });

  it('formatter still renders a genuinely empty successful result as success', () => {
    const md = formatToolResult('query_sql', {
      rows: [],
      columns: [],
      total_count: 0,
      has_more: false,
      execution_time_ms: 3,
    });

    expect(md).toContain('SQL Query Results');
    expect(md).not.toMatch(/error/i);
  });

  it('flags a soft-error result so the MCP boundary can set isError', () => {
    expect(isSoftErrorResult({ rows: [], error: "Unknown table 'conversations'" })).toBe(true);
    // A successful empty result must NOT be flagged.
    expect(isSoftErrorResult({ rows: [], total_count: 0 })).toBe(false);
    expect(isSoftErrorResult({ rows: [], error: '' })).toBe(false);
    expect(isSoftErrorResult(null)).toBe(false);
  });

  it('the same soft-error guard applies to every tool, not just query_sql', () => {
    expect(isSoftErrorResult({ error: 'boom' })).toBe(true);
    expect(isSoftErrorResult({ success: true, error: { message: 'historical warning' } })).toBe(
      false
    );
  });

  // A run_sdk/query_sdk SCRIPT throw is NOT a tool failure: the tool ran the
  // caller's code and faithfully reported the outcome as data (success=false
  // plus a concise public error, per SdkScriptResultSchema). Flagging it
  // isError makes `mcpToolsCall` throw before a caller can read that payload,
  // and makes interaction-bridge relabel it "Tool error:" to the agent.
  it('does NOT flag an SDK script failure as a tool-level error', () => {
    expect(
      isSoftErrorResult({
        success: false,
        error: {
          name: 'TypeError',
          message: 'client.connections.installConnector is not a function',
          code: 'VALIDATION',
          retryable: false,
        },
        skipped_calls: 0,
        side_effect_preview: [],
        dry_run: false,
      })
    ).toBe(false);
  });

  it('does not drop fields from unrelated error results', () => {
    const md = formatToolResult('manage_connections', {
      error: 'App installation required',
      setup_url: 'https://example.test/install',
    });
    expect(md).toContain('App installation required');
    expect(md).toContain('https://example.test/install');
  });

  it('unknown-COLUMN errors stay specific and name the column', () => {
    const res = validateTableQuery('SELECT platform FROM events');
    expect(res.valid).toBe(false);
    expect(res.errors.join('; ')).toMatch(/Unknown column 'platform'/i);
  });

  it('offers only the caller-supplied safe columns after an unknown-column rejection', () => {
    const columns = new Map([['example_records', [{ name: 'id', type: 'text' }, { name: 'label', type: 'text' }]]]);
    const result = validateTableQuery('SELECT private_token FROM example_records', columns);
    expect(result.valid).toBe(false);
    const guidance = result.errors.find((message) => message.startsWith('Allowed columns'));
    expect(guidance).toContain('example_records');
    expect(guidance).toContain('id, label');
    expect(guidance).not.toContain('private_token');
    expect(guidance).not.toContain('organization_id');
  });

  it.each(['to_jsonb(e)', 'e::text'])('explains the whole-row guard for %s', (projection) => {
    const result = validateTableQuery(`SELECT ${projection} FROM events e`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes('whole-row'))).toBe(true);
    expect(result.errors.some((message) => message.startsWith('Allowed columns'))).toBe(true);
  });

  it('an admin-only table is rejected as an error, never an empty result', () => {
    expect(ADMIN_ONLY_QUERYABLE_TABLES.has('oauth_tokens')).toBe(true);
    let message = '';
    try {
      validateAndScopeQuery('SELECT id FROM oauth_tokens', 'org_1', {
        safeColumns: SAFE_COLUMN_DEFS,
        restrictedTables: ADMIN_ONLY_QUERYABLE_TABLES,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('oauth_tokens');
    expect(message).toMatch(/not an empty result/i);
  });
});
