import { describe, expect, it } from 'vitest';
import {
  BROWSER_GROUP_TITLE_PREFIX,
  browserActionContextFromMetadata,
  deriveBrowserActionContext,
  deriveSdkBrowserActionContext,
  runScopedBrowserActionContext,
  standaloneBrowserActionContext,
  trustedChromeActionInput,
} from '../../worker-api/browser-action-context';
import type { ToolContext } from '../../tools/registry';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: 'org_browser_context',
    userId: 'user_browser_context',
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'session',
    ...overrides,
  } as ToolContext;
}

describe('deriveBrowserActionContext', () => {
  it('prioritizes the acting Automation execution', () => {
    expect(
      deriveBrowserActionContext(
        context({
          actingAutomationId: 7,
          actingRunId: 42,
          sourceContext: { platform: 'slack', conversationId: 'thread-raw' },
          mcpConversationId: 'mcp-raw',
          mcpSessionId: 'mcp-session-raw',
        })
      )
    ).toEqual({
      id: 'automation:42',
      title: `${BROWSER_GROUP_TITLE_PREFIX} · Automation 7 · Run 42`,
      flow_id: '42',
      kind: 'automation',
    });
  });

  it('derives a stable opaque context from a verified source conversation', () => {
    const first = deriveBrowserActionContext(
      context({
        sourceContext: {
          platform: 'slack',
          connectionId: 'slack-main',
          conversationId: 'C123:thread:1712345.678',
        },
      })
    );
    const second = deriveBrowserActionContext(
      context({
        sourceContext: {
          platform: 'slack',
          connectionId: 'slack-main',
          conversationId: 'C123:thread:1712345.678',
        },
      })
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'conversation' });
    expect(first?.id).toMatch(/^conversation:[a-f0-9]{12}$/);
    expect(first?.flow_id).toBe(first?.id);
    expect(JSON.stringify(first)).not.toContain('C123:thread:1712345.678');
  });

  it('uses host MCP conversation correlation before transport session fallback', () => {
    const rawHostConversationId = 'host-conversation-super-secret';
    const fromHostA = deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'chatgpt',
        mcpConversationId: rawHostConversationId,
        mcpSessionId: 'transport-a',
      })
    );
    const fromHostB = deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'chatgpt',
        mcpConversationId: rawHostConversationId,
        mcpSessionId: 'transport-b',
      })
    );
    const fromTransport = deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'chatgpt',
        mcpSessionId: 'transport-a',
      })
    );

    expect(fromHostA).toEqual(fromHostB);
    expect(fromHostA).toMatchObject({ kind: 'mcp' });
    expect(fromHostA?.id).not.toBe(fromTransport?.id);
    expect(JSON.stringify(fromHostA)).not.toContain(rawHostConversationId);
    expect(fromHostA?.title).not.toContain(rawHostConversationId);
  });
});

describe('SDK browser invocation', () => {
  const invocation = {
    nonce: 'synthetic-invocation-a',
    title: 'Check notifications',
  };

  it('keeps one owner within the invocation and round-trips through stored metadata', () => {
    const ctx = context({ sdkBrowserInvocation: invocation });
    const first = deriveSdkBrowserActionContext(ctx);
    expect(first).not.toBeNull();
    expect(deriveSdkBrowserActionContext({ ...ctx })).toEqual(first);
    expect(first?.id).toMatch(/^run:sdk-[a-f0-9]{64}$/);
    expect(first?.title).toMatch(
      new RegExp(`^${escapeRe(BROWSER_GROUP_TITLE_PREFIX)} · Check notifications · [a-f0-9]{12}$`)
    );
    expect(browserActionContextFromMetadata({ browser_context: first })).toEqual(
      first
    );
    expect(deriveBrowserActionContext(ctx)).toBeNull();
  });

  it('isolates invocations, selected workspaces and users even with the same title', () => {
    const ctx = context({ sdkBrowserInvocation: invocation });
    const owner = deriveSdkBrowserActionContext(ctx)?.flow_id;
    for (const change of [
      {
        sdkBrowserInvocation: {
          ...invocation,
          nonce: 'synthetic-invocation-b',
        },
      },
      { organizationId: 'org_browser_other' },
      { userId: 'user_browser_other' },
    ]) {
      expect(
        deriveSdkBrowserActionContext({ ...ctx, ...change })?.flow_id
      ).not.toBe(owner);
    }
    expect(deriveSdkBrowserActionContext(context())).toBeNull();
    expect(deriveSdkBrowserActionContext({ ...ctx, userId: null })).toBeNull();
  });

  it('normalizes and bounds Unicode subjects without changing ownership', () => {
    const ctx = context({ sdkBrowserInvocation: invocation });
    const original = deriveSdkBrowserActionContext(ctx)!;
    const changed = deriveSdkBrowserActionContext({
      ...ctx,
      sdkBrowserInvocation: {
        ...invocation,
        title: ' A\nB\u0000 ' + '😀'.repeat(250),
      },
    })!;
    expect(changed.flow_id).toBe(original.flow_id);
    expect(changed.title).toStartWith(`${BROWSER_GROUP_TITLE_PREFIX} · A B 😀`);
    expect(changed.title).not.toMatch(/[\u0000-\u001f]/);
    expect([...changed.title]).toHaveLength(
      200 + `${BROWSER_GROUP_TITLE_PREFIX} · `.length + ' · '.length + 12
    );
  });

  it('uses a human subject for untitled calls and strips forged ownership', () => {
    const browser = deriveSdkBrowserActionContext(
      context({
        sdkBrowserInvocation: { nonce: invocation.nonce, title: '' },
      })
    )!;
    expect(browser.title).toMatch(
      new RegExp(`^${escapeRe(BROWSER_GROUP_TITLE_PREFIX)} · Browser task · [a-f0-9]{12}$`)
    );
    expect(
      trustedChromeActionInput(
        {
          tab_id: 123,
          browser_context_id: 'forged',
          browser_context_title: 'forged',
          browser_flow_id: 'forged',
          holder_run_id: 'forged',
          parent_run_id: 999,
        },
        browser
      )
    ).toEqual({
      tab_id: 123,
      browser_context_id: browser.id,
      browser_context_title: browser.title,
      browser_flow_id: browser.flow_id,
      holder_run_id: browser.flow_id,
    });
  });

  it.each([
    { actingAutomationId: 7, actingRunId: 42 },
    { sourceContext: { platform: 'slack', conversationId: 'synthetic-thread' } },
    { mcpSessionId: 'synthetic-mcp-session', clientId: 'synthetic-client' },
  ])('changes the subject without changing attributed ownership: %j', (attribution) => {
    const original = deriveBrowserActionContext(context(attribution))!;
    const titled = deriveBrowserActionContext(
      context({ ...attribution, sdkBrowserInvocation: invocation })
    )!;
    expect(titled).toEqual({
      ...original,
      title: expect.stringContaining(`${BROWSER_GROUP_TITLE_PREFIX} · Check notifications · `),
    });
  });
});

describe('page-activation trust stamp', () => {
  const browser = runScopedBrowserActionContext(4242);

  it('stamps the tab the server resolved and strips the caller\'s copy', () => {
    expect(
      trustedChromeActionInput(
        { tab_id: 23, activation_tab_id: 999 },
        browser,
        23
      )
    ).toMatchObject({ tab_id: 23, activation_tab_id: 23 });
  });

  it('omits the stamp entirely when the run was never page-activated', () => {
    // A caller-supplied id must not survive into a non-activated run — that
    // would be a way to launder any tab into user-owned authority.
    for (const activation of [null, undefined]) {
      const out = trustedChromeActionInput(
        { tab_id: 7, activation_tab_id: 7 },
        browser,
        activation
      );
      expect(out).not.toHaveProperty('activation_tab_id');
    }
  });

  it('refuses a non-positive or non-integer resolved id', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        trustedChromeActionInput({ tab_id: 7 }, browser, bad)
      ).not.toHaveProperty('activation_tab_id');
    }
  });
});

// The extension normalizes titles outside this shape. Keep every fixed server
// fallback within its pass-through contract; user-supplied subjects are
// bounded by the extension.
//
// Pinned as a LITERAL on purpose. This is the cross-side contract with
// GROUP_TITLE_PREFIX in apps/chrome/tab-groups.js, so deriving it from the
// server's own constant would make the assertion tautological and let a
// one-sided rename pass. Changing the prefix must fail here until the
// extension is changed to match.
const EXTENSION_TITLE_PREFIX = 'Lobu · ';
const EXTENSION_MAX_TITLE_POINTS = 64;

describe('extension title pass-through contract', () => {
  const titles = [
    runScopedBrowserActionContext(Number.MAX_SAFE_INTEGER).title,
    deriveSdkBrowserActionContext(
      context({
        sdkBrowserInvocation: { nonce: 'synthetic-default-title', title: '' },
      })
    )!.title,
    deriveBrowserActionContext(
      context({
        actingAutomationId: Number.MAX_SAFE_INTEGER,
        actingRunId: Number.MAX_SAFE_INTEGER,
      })
    )!.title,
    deriveBrowserActionContext(
      context({
        sourceContext: {
          platform: 'slack',
          connectionId: 'conn_1',
          channelId: 'chan_1',
          conversationId: 'conv_1',
        },
      })
    )!.title,
    deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'synthetic-client',
        mcpSessionId: 'synthetic-session',
      })
    )!.title,
  ];

  it('keeps fixed server titles unchanged by the extension', () => {
    for (const title of titles) {
      expect(title).toStartWith(EXTENSION_TITLE_PREFIX);
      expect([...title].length).toBeLessThanOrEqual(
        EXTENSION_MAX_TITLE_POINTS
      );
    }
  });
});

describe('standaloneBrowserActionContext', () => {
  it('shares one group across unrelated actions on the same browser connection', () => {
    const first = standaloneBrowserActionContext('org_1', 432, 1001);
    const second = standaloneBrowserActionContext('org_1', 432, 1002);
    // Same visible container...
    expect(first?.id).toBe(second?.id);
    expect(first?.title).toBe(`${BROWSER_GROUP_TITLE_PREFIX} · Browser actions`);
    // ...but each run keeps its own flow lease, so neither owns the other's tab.
    expect(first?.flow_id).toBe('1001');
    expect(second?.flow_id).toBe('1002');
  });

  it('separates organizations and connections', () => {
    const a = standaloneBrowserActionContext('org_1', 432, 1);
    const b = standaloneBrowserActionContext('org_2', 432, 1);
    const c = standaloneBrowserActionContext('org_1', 999, 1);
    expect(new Set([a?.id, b?.id, c?.id]).size).toBe(3);
  });

  it('carries no raw identifier in the group key', () => {
    const ctxId = standaloneBrowserActionContext('org_secret', 432, 1)?.id ?? '';
    expect(ctxId).not.toContain('org_secret');
    expect(ctxId).toMatch(/^run:standalone-[0-9a-f]{12}$/);
  });

  it('declines when provenance is missing, so the caller falls back to run scope', () => {
    expect(standaloneBrowserActionContext(null, 432, 1)).toBeNull();
    expect(standaloneBrowserActionContext('org_1', null, 1)).toBeNull();
    expect(standaloneBrowserActionContext('org_1', 432, 0)).toBeNull();
  });

  it('stays inside the extension title contract', () => {
    const title = standaloneBrowserActionContext('org_1', 432, 1)?.title ?? '';
    expect(title.startsWith(EXTENSION_TITLE_PREFIX)).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(EXTENSION_MAX_TITLE_POINTS);
  });
});

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
