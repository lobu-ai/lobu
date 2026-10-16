/**
 * The device access rule, as a table: who may use a member's pinned device.
 * Pure; operation admission applies organization connector policy separately.
 */

import type { ChatTurnAccess } from '@lobu/core';
import { describe, expect, it } from 'vitest';
import { chatAccessOfToolContext, decideDeviceAccess, type DeviceAccessDecision } from '../device-access.js';

describe('decideDeviceAccess', () => {
  // The signed tier alone decides: the owner and any member acting as
  // themselves arrive as a non-chat call or the `member` tier; the owner
  // writing in a group conversation is `org_shared` like anyone else there.
  const cases: Array<[string, ChatTurnAccess | null, DeviceAccessDecision]> = [
    ['an app or MCP session, owner or another member', null, 'run'],
    ['a headless Automation', null, 'run'],
    ["a member's own direct message, owner or not", 'member', 'run'],
    ['a vouched coworker, or anyone in a group conversation', 'org_shared', 'ask_owner'],
    ['a public visitor', 'public_visitor', 'refuse'],
    ['a reply-only sender', 'reply_only', 'refuse'],
  ];

  it.each(cases)('%s', (_label, chatAccess, expected) => {
    expect(decideDeviceAccess(chatAccess)).toBe(expected);
  });
});

describe('chatAccessOfToolContext', () => {
  it('reads the signed tier off the source context', () => {
    expect(chatAccessOfToolContext({ sourceContext: { chatAccess: 'org_shared' } })).toBe('org_shared');
  });

  it('treats an anonymous caller (the public-read path) as a public visitor', () => {
    expect(chatAccessOfToolContext({ tokenType: 'anonymous', sourceContext: null })).toBe('public_visitor');
  });

  it('is null for a call that is not a chat turn', () => {
    expect(chatAccessOfToolContext({ sourceContext: null })).toBeNull();
    expect(chatAccessOfToolContext({ sourceContext: {} })).toBeNull();
  });
});
