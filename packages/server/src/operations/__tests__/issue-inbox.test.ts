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
    const plain = failedOperationNextAction(null);
    expect(plain).toContain('Retrying the same input rarely helps');
    expect(plain).not.toContain('notifications.submit');
    const configured = failedOperationNextAction({ organization: 'lobu-team', inbox: 'product.issue' });
    expect(configured).toContain('notifications.submit({ organization: "lobu-team", inbox: "product.issue"');
    expect(configured).toContain('data.evidence.failure_fingerprint');
  });
});
