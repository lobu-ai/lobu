import { describe, expect, it } from 'bun:test';
import { deleteContent } from '../../tools/delete_content';
import type { ToolContext } from '../../tools/registry';

const args = { content_id: 1 } as never;
const baseCtx: ToolContext = {
  organizationId: 'org_test',
  userId: 'user_visitor',
  memberRole: null,
  isAuthenticated: true,
  tokenType: 'oauth',
  scopedToOrg: false,
  allowCrossOrg: true,
  scopes: ['mcp:write'],
};
const ctx = (overrides: Partial<ToolContext>): ToolContext => ({ ...baseCtx, ...overrides });

const isAuthGateError = (err: unknown): boolean =>
  /workspace membership|MCP session with write access/i.test(String(err));

describe('deleteContent auth gate', () => {
  it('rejects an authenticated non-member', async () => {
    await expect(deleteContent(args, {} as never, ctx({}))).rejects.toThrow(
      /workspace membership with write access/i
    );
  });

  it('rejects a member without mcp:write scope', async () => {
    await expect(
      deleteContent(args, {} as never, ctx({ memberRole: 'member', scopes: ['mcp:read'] }))
    ).rejects.toThrow(/delete_knowledge needs write access.*approved read-only/i);
  });

  it('accepts a member with mcp:write and gets past the gate', async () => {
    // Depending on local env, DATABASE_URL may point at a reachable DB. Success
    // and deeper non-auth failures both mean the auth gate was bypassed.
    let bypassedGate = true;
    try {
      await deleteContent(args, {} as never, ctx({ memberRole: 'member' }));
    } catch (err) {
      bypassedGate = !isAuthGateError(err);
    }
    expect(bypassedGate).toBe(true);
  });

  it('mcp:admin scope satisfies the write requirement', async () => {
    let bypassedGate = true;
    try {
      await deleteContent(args, {} as never, ctx({ memberRole: 'admin', scopes: ['mcp:admin'] }));
    } catch (err) {
      bypassedGate = !isAuthGateError(err);
    }
    expect(bypassedGate).toBe(true);
  });

  it('system contexts (userId=null + auth=true) bypass the gate', async () => {
    let bypassedGate = true;
    try {
      await deleteContent(args, {} as never, ctx({ userId: null }));
    } catch (err) {
      bypassedGate = !isAuthGateError(err);
    }
    expect(bypassedGate).toBe(true);
  });
});

describe('deleteContent input validation', () => {
  const writingCtx = ctx({ memberRole: 'member', scopes: ['mcp:write'] });

  it('rejects when neither content_id nor content_ids is provided', async () => {
    await expect(
      deleteContent({} as never, {} as never, writingCtx)
    ).rejects.toThrow(/content_id or a non-empty content_ids/i);
  });

  it('rejects when content_ids is empty', async () => {
    await expect(
      deleteContent({ content_ids: [] } as never, {} as never, writingCtx)
    ).rejects.toThrow(/content_id or a non-empty content_ids/i);
  });

  it('rejects when ids are non-positive', async () => {
    await expect(
      deleteContent({ content_ids: [0, -3] } as never, {} as never, writingCtx)
    ).rejects.toThrow(/content_id or a non-empty content_ids/i);
  });
});
