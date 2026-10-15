import { describe, expect, it } from 'vitest';
import {
  collectFeedRequiredScopes,
  selectReconnectOAuthScopes,
} from '../oauth/scopes';

const YOUTUBE = 'https://www.googleapis.com/auth/youtube.readonly';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';

const YOUTUBE_METHOD = {
  loginScopes: ['openid', 'email', 'profile'],
  requiredScopes: [YOUTUBE],
};

describe('selectReconnectOAuthScopes', () => {
  it('drops historical scopes nothing declares anymore', () => {
    const selection = selectReconnectOAuthScopes({
      method: YOUTUBE_METHOD,
      feedsSchema: null,
      historicalScopes: ['openid', 'email', 'profile', YOUTUBE, DRIVE_FILE],
    });
    expect(selection.requestedScopes).toEqual(['openid', 'email', 'profile', YOUTUBE]);
    expect(selection.droppedHistoricalScopes).toEqual([DRIVE_FILE]);
  });

  it('preserves previously granted declared optionals without re-asking', () => {
    const selection = selectReconnectOAuthScopes({
      method: { ...YOUTUBE_METHOD, optionalScopes: [DRIVE_FILE] },
      feedsSchema: null,
      historicalScopes: [YOUTUBE, DRIVE_FILE],
    });
    expect(selection.requestedScopes).toEqual(
      expect.arrayContaining(['openid', 'email', 'profile', YOUTUBE, DRIVE_FILE])
    );
    expect(selection.droppedHistoricalScopes).toEqual([]);
  });

  it('honors explicit asks filtered to current optional scopes', () => {
    const selection = selectReconnectOAuthScopes({
      method: { ...YOUTUBE_METHOD, optionalScopes: [DRIVE_READONLY] },
      feedsSchema: null,
      historicalScopes: [YOUTUBE],
      requestedScopes: [DRIVE_READONLY, 'evil.scope'],
    });
    expect(selection.requestedScopes).toEqual(
      expect.arrayContaining(['openid', 'email', 'profile', YOUTUBE, DRIVE_READONLY])
    );
    expect(selection.requestedScopes).not.toContain('evil.scope');
    expect(selection.droppedHistoricalScopes).toEqual([]);
  });

  it('retains feed-required scopes from history', () => {
    const selection = selectReconnectOAuthScopes({
      method: YOUTUBE_METHOD,
      feedsSchema: { items: { requiredScopes: ['items.read'] } },
      historicalScopes: [YOUTUBE, 'items.read', DRIVE_FILE],
    });
    expect(selection.requestedScopes).toContain('items.read');
    expect(selection.droppedHistoricalScopes).toEqual([DRIVE_FILE]);
  });

  it('always requests the manifest even with empty history', () => {
    const selection = selectReconnectOAuthScopes({
      method: YOUTUBE_METHOD,
      feedsSchema: null,
      historicalScopes: [],
    });
    expect(selection.requestedScopes).toEqual(['openid', 'email', 'profile', YOUTUBE]);
    expect(selection.droppedHistoricalScopes).toEqual([]);
  });

  it('dedupes overlapping scope sources deterministically', () => {
    const selection = selectReconnectOAuthScopes({
      method: { ...YOUTUBE_METHOD, optionalScopes: [DRIVE_READONLY] },
      feedsSchema: { videos: { requiredScopes: [YOUTUBE] } },
      historicalScopes: [YOUTUBE, 'openid', DRIVE_READONLY],
      requestedScopes: [DRIVE_READONLY, YOUTUBE],
    });
    expect(selection.requestedScopes).toEqual(['openid', 'email', 'profile', YOUTUBE, DRIVE_READONLY]);
    expect(selection.droppedHistoricalScopes).toEqual([]);
  });
});

describe('collectFeedRequiredScopes', () => {
  it('unions requiredScopes across keyed feed entries', () => {
    expect(
      collectFeedRequiredScopes({ items: { requiredScopes: ['items.read'] }, media: { requiredScopes: ['media.read', 'items.read'] } })
    ).toEqual(['items.read', 'media.read']);
  });

  it('returns empty for missing or malformed schemas', () => {
    expect(collectFeedRequiredScopes(null)).toEqual([]);
    expect(collectFeedRequiredScopes({})).toEqual([]);
    expect(collectFeedRequiredScopes({ items: {} })).toEqual([]);
  });

  it('unions requiredScopes across list feed entries', () => {
    expect(collectFeedRequiredScopes([
      { key: 'items', requiredScopes: ['items.read'] },
      { key: 'media', requiredScopes: ['media.read', 'items.read'] },
    ])).toEqual(['items.read', 'media.read']);
  });
});
