import { describe, expect, it } from 'vitest';
import { directMcpInstructions } from '../workspace-instructions';

// Claude Code keeps only the first 4096 characters of a server's instructions.
const CLAUDE_CODE_INSTRUCTION_LIMIT = 4096;

describe('direct MCP issue reporting instructions', () => {
  const inbox = { organization: 'lobu-team', inbox: 'product.issue' };

  it.each([
    ['configured', inbox],
    ['unset', null],
  ])('keeps writes, approvals and issue reporting inside the limit when the inbox is %s', (_, target) => {
    const text = directMcpInstructions(target);
    const reporting = text.indexOf('### Reporting Lobu issues');
    const end = text.indexOf('\n\n', reporting);
    expect(text.indexOf('### Writes and approvals')).toBeLessThan(reporting);
    expect(reporting).toBeGreaterThan(0);
    expect(end).toBeLessThan(CLAUDE_CODE_INSTRUCTION_LIMIT);
  });

  it('names the configured inbox, and only discovery when there is none', () => {
    const configured = directMcpInstructions(inbox);
    expect(configured).toContain(
      'client.notifications.submit({ organization: "lobu-team", inbox: "product.issue", ... })'
    );
    expect(configured).toContain('failure_fingerprint');

    const unset = directMcpInstructions(null);
    expect(unset).not.toContain('lobu-team');
    expect(unset).toContain('notifications.listInboxes({ organization: "<recipient-workspace>" })');
  });
});
