import { describe, expect, it } from 'vitest';
import {
  browserActionContextFromMetadata,
  deriveBrowserActionContext,
  deriveSdkBrowserActionContext,
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
      title: 'Lobu · Automation 7 · Run 42',
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
    expect(first?.title).toMatch(/^Lobu · Check notifications · [a-f0-9]{12}$/);
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
    expect(changed.title).toStartWith('Lobu · A B 😀');
    expect(changed.title).not.toMatch(/[\u0000-\u001f]/);
    expect([...changed.title]).toHaveLength(
      200 + 'Lobu · '.length + ' · '.length + 12
    );
  });

  it('uses a human subject for untitled calls and strips forged ownership', () => {
    const browser = deriveSdkBrowserActionContext(
      context({
        sdkBrowserInvocation: { nonce: invocation.nonce, title: '' },
      })
    )!;
    expect(browser.title).toMatch(/^Lobu · Browser task · [a-f0-9]{12}$/);
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
      title: expect.stringContaining('Lobu · Check notifications · '),
    });
  });
});
