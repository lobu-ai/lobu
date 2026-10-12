/**
 * The platform event catalog is COMPUTED from the audit writers' own
 * vocabularies, so these assertions are about the derivation rules rather than
 * a hand-kept list: which subjects contribute, which ops each one reports, and
 * what must never appear.
 */

import { describe, expect, test } from 'bun:test';
import {
  AUDIT_LIFECYCLE_SUBJECTS,
  isPlatformEventType,
  platformEventKinds,
} from '../../automations/platform-event-catalog';

describe('platform event catalog', () => {
  test('derives config, workspace-identity, and lifecycle subjects', () => {
    // Keys are dotted, so `toHaveProperty` would read them as nested paths.
    const keys = Object.keys(platformEventKinds());
    // From CONFIG_RESOURCE_KINDS, which exists for redaction — no second list.
    expect(keys).toContain('connection.deleted');
    expect(keys).toContain('feed.created');
    expect(keys).toContain('provider-key.updated');
    // From WORKSPACE_AUDIT_RESOURCE_KINDS.
    expect(keys).toContain('invitation.created');
    // From AUDIT_LIFECYCLE_SUBJECTS.
    expect(keys).toContain('device.deleted');
    expect(keys).toContain('client.created');
    for (const subject of AUDIT_LIFECYCLE_SUBJECTS) {
      expect(isPlatformEventType(`${subject}.created`)).toBe(true);
    }
  });

  test('lists only ops a writer actually emits', () => {
    // Edges report past-tense link verbs and are never "created".
    expect(isPlatformEventType('relationship.linked')).toBe(true);
    expect(isPlatformEventType('relationship.unlinked')).toBe(true);
    expect(isPlatformEventType('relationship.created')).toBe(false);
    // Entity rows report one op: the writer stamps only updates, and entity
    // creates and deletes carry no `<subject>.<op>` audit event at all.
    expect(isPlatformEventType('entity.updated')).toBe(true);
    expect(isPlatformEventType('entity.created')).toBe(false);
  });

  test('never offers `change`, the storage classification', () => {
    // Subscribing to `change` would mean "a row was written" — every audit row
    // carries it, so it is not something that happened.
    expect(isPlatformEventType('change')).toBe(false);
    expect(Object.keys(platformEventKinds())).not.toContain('change');
  });

  test('offers token creation and revocation without an unimplemented update event', () => {
    expect(isPlatformEventType('access_token.created')).toBe(true);
    expect(isPlatformEventType('access_token.deleted')).toBe(true);
    expect(isPlatformEventType('access_token.updated')).toBe(false);
  });

  test('rejects malformed and unknown names', () => {
    expect(isPlatformEventType('device.onlien')).toBe(false);
    expect(isPlatformEventType('device')).toBe(false);
    expect(isPlatformEventType('')).toBe(false);
    expect(isPlatformEventType('observation')).toBe(false);
  });

  test('every entry carries a description for the trigger picker', () => {
    const kinds = platformEventKinds();
    const entries = Object.entries(kinds);
    expect(entries.length).toBeGreaterThan(20);
    expect(
      entries.every(([, definition]) => definition.description.length > 0)
    ).toBe(true);
  });
});
