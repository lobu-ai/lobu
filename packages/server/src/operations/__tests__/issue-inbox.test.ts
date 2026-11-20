import { describe, expect, it } from 'vitest';
import { failedOperationNextAction, issueInbox } from '../issue-inbox';

describe('issue inbox setting', () => {
  it('reads <organization>/<inbox> and ignores anything else', () => {
    expect(issueInbox({ LOBU_ISSUE_INBOX: ' lobu-team/product.issue ' })).toEqual({ organization: 'lobu-team', inbox: 'product.issue' });
    expect(issueInbox({})).toBeNull();
    for (const value of ['lobu-team', 'lobu-team/', '/product.issue', 'a/b/c', 'Lobu Team/product.issue'])
      expect(issueInbox({ LOBU_ISSUE_INBOX: value })).toBeNull();
  });

  it('names the inbox in next_action only when one is configured', () => {
    const plain = failedOperationNextAction({ recorded: true }, null);
    expect(plain).toContain('Retrying the same input rarely helps');
    expect(plain).not.toContain('notifications.submit');
    const configured = failedOperationNextAction({ recorded: true }, { organization: 'lobu-team', inbox: 'product.issue' });
    expect(configured).toContain('notifications.submit({ organization: "lobu-team", inbox: "product.issue"');
    expect(configured).toContain('data.evidence.failure_fingerprint');
    // A cancelled or rejected run is not a Lobu defect.
    expect(failedOperationNextAction({ recorded: false }, { organization: 'lobu-team', inbox: 'product.issue' })).toBe(plain);
  });

  it('lets the agent finish in the browser only after the connector stopped on a page it did not recognize', () => {
    const target = { organization: 'lobu-team', inbox: 'product.issue' };
    const recovery = failedOperationNextAction({ recorded: true, pageUnrecognized: true }, target);
    expect(recovery).toContain('stopped before acting, so nothing changed');
    expect(recovery).toContain("this workspace's chrome connection");
    expect(recovery).toContain('reload and confirm the result');
    expect(recovery).not.toContain('Do not substitute raw browser');
    expect(recovery).toContain('notifications.submit({ organization: "lobu-team", inbox: "product.issue"');
    expect(recovery).toContain('data.diagnosis.checked');
    // An unrecorded run (cancelled, rejected) never unlocks the browser path.
    expect(failedOperationNextAction({ recorded: false, pageUnrecognized: true }, target)).toBe(
      failedOperationNextAction({ recorded: false }, target),
    );
    // Without an inbox the browser path stays, the report pointer goes.
    const unconfigured = failedOperationNextAction({ recorded: true, pageUnrecognized: true }, null);
    expect(unconfigured).toContain("this workspace's chrome connection");
    expect(unconfigured).not.toContain('notifications.submit');
  });
});
