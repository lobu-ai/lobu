/**
 * The device access rule, as a table: who may use a member's pinned device.
 * Pure; operation admission applies organization connector policy separately.
 */

import type { ChatTurnAccess } from '@lobu/core';
import { describe, expect, it } from 'vitest';
import { chatAccessOfToolContext, decideDeviceAccess, type DeviceAccessDecision } from '../device-access.js';

const OWNER = 'user-device-owner';
const OTHER = 'user-other-member';

describe('decideDeviceAccess', () => {
  const cases: Array<[string, ChatTurnAccess | null, string | null, DeviceAccessDecision]> = [
    ['the owner in an app or MCP session', null, OWNER, 'run'],
    ["the owner's own direct message", 'member', OWNER, 'run'],
    ['another member in an app or MCP session', null, OTHER, 'run'],
    ["another member's own direct message", 'member', OTHER, 'run'],
    ['a headless call with no user (Automation)', null, null, 'run'],
    ['a vouched coworker or a group conversation', 'org_shared', null, 'ask_owner'],
    ['a public visitor', 'public_visitor', null, 'refuse'],
    ['a reply-only sender', 'reply_only', null, 'refuse'],
    ['a reply-only token that names the owner', 'reply_only', OWNER, 'refuse'],
  ];

  it.each(cases)('%s', (_label, chatAccess, callerUserId, expected) => {
    expect(decideDeviceAccess({ chatAccess, callerUserId, deviceOwnerUserId: OWNER })).toBe(expected);
  });
});

describe('chatAccessOfToolContext', () => {
  it('reads the signed tier off the source context', () => {
    expect(chatAccessOfToolContext({ sourceContext: { chatAccess: 'org_shared' } })).toBe('org_shared');
  });

  it('is null for a call that is not a chat turn', () => {
    expect(chatAccessOfToolContext({ sourceContext: null })).toBeNull();
    expect(chatAccessOfToolContext({ sourceContext: {} })).toBeNull();
  });
});
