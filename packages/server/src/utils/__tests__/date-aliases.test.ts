/**
 * Date Alias Parsing Tests
 *
 * A day is a UTC calendar day, whatever the server process's local timezone.
 * Cases run in UTC and on both sides of it; the non-UTC references sit near
 * midnight UTC where their local and UTC calendar dates differ.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foldUnprocessedRanges, parseAutomationWindowDate } from '../window-utils';
import { parseDateAlias, toEndOfDay } from '../date-aliases';

const iso = (d: Date) => d.toISOString();

describe.each(['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'])('in process TZ %s', (tz) => {
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  // Cross a local calendar boundary in both directions while keeping the same
  // UTC day: late UTC in Kiritimati, early UTC in Los Angeles.
  const ref = new Date(
    tz === 'America/Los_Angeles' ? '2025-06-15T00:30:00Z' : '2025-06-15T23:30:00Z'
  );

  describe('parseDateAlias', () => {
    it('named aliases start the UTC day', () => {
      expect(iso(parseDateAlias('today', ref).date)).toBe('2025-06-15T00:00:00.000Z');
      expect(iso(parseDateAlias('yesterday', ref).date)).toBe('2025-06-14T00:00:00.000Z');
      expect(iso(parseDateAlias('last_week', ref).date)).toBe('2025-06-08T00:00:00.000Z');
      expect(iso(parseDateAlias('last_month', ref).date)).toBe('2025-05-15T00:00:00.000Z');
    });

    it('relative aliases count back whole UTC days', () => {
      expect(iso(parseDateAlias('7d', ref).date)).toBe('2025-06-08T00:00:00.000Z');
      expect(iso(parseDateAlias('30d', ref).date)).toBe('2025-05-16T00:00:00.000Z');
      expect(iso(parseDateAlias('2w', ref).date)).toBe('2025-06-01T00:00:00.000Z');
      expect(iso(parseDateAlias('1m', ref).date)).toBe('2025-05-15T00:00:00.000Z');
      expect(iso(parseDateAlias('1q', ref).date)).toBe('2025-03-15T00:00:00.000Z');
      expect(iso(parseDateAlias('1y', ref).date)).toBe('2024-06-15T00:00:00.000Z');
    });

    it('an ISO date is that UTC day', () => {
      expect(iso(parseDateAlias('2025-01-15', ref).date)).toBe('2025-01-15T00:00:00.000Z');
      expect(iso(parseDateAlias('0099-01-15', ref).date)).toBe('0099-01-15T00:00:00.000Z');
    });

    it('an ISO datetime is UTC unless it carries an explicit offset', () => {
      expect(iso(parseDateAlias('2025-01-15T12:30:00Z', ref).date)).toBe(
        '2025-01-15T12:30:00.000Z'
      );
      expect(iso(parseDateAlias('2025-01-15T23:30:00', ref).date)).toBe(
        '2025-01-15T23:30:00.000Z'
      );
      expect(iso(parseDateAlias('2025-01-15T23:30:00-08:00', ref).date)).toBe(
        '2025-01-16T07:30:00.000Z'
      );
      expect(iso(parseDateAlias('"2025-01-15T12:30:00Z"', ref).date)).toBe(
        '2025-01-15T12:30:00.000Z'
      );
    });

    it('reads basic, extended, and hour-only ISO 8601 offsets', () => {
      expect(iso(parseDateAlias('2025-01-15T10:00:00+03', ref).date)).toBe('2025-01-15T07:00:00.000Z');
      expect(iso(parseDateAlias('2025-01-15T10:00:00+0300', ref).date)).toBe('2025-01-15T07:00:00.000Z');
      expect(iso(parseDateAlias('2025-01-15T10:00:00+03:00', ref).date)).toBe('2025-01-15T07:00:00.000Z');
      expect(iso(parseDateAlias('2025-01-15t10:00:00z', ref).date)).toBe('2025-01-15T10:00:00.000Z');
    });

    it('month and year arithmetic clamp to the end of a shorter month', () => {
      const endOfMarch = new Date('2025-03-31T12:00:00Z');
      expect(iso(parseDateAlias('last_month', endOfMarch).date)).toBe('2025-02-28T00:00:00.000Z');
      expect(iso(parseDateAlias('1m', endOfMarch).date)).toBe('2025-02-28T00:00:00.000Z');
      expect(iso(parseDateAlias('1q', new Date('2025-05-31T12:00:00Z')).date)).toBe(
        '2025-02-28T00:00:00.000Z'
      );
      expect(iso(parseDateAlias('1y', new Date('2024-02-29T12:00:00Z')).date)).toBe(
        '2023-02-28T00:00:00.000Z'
      );
    });

    it('rejects invalid input', () => {
      expect(() => parseDateAlias('foobar', ref)).toThrow('Invalid date alias');
      expect(() => parseDateAlias('2025-99-99', ref)).toThrow();
      expect(() => parseDateAlias('2025-02-30', ref)).toThrow();
      expect(() => parseDateAlias('2025-02-30T12:00:00Z', ref)).toThrow();
      expect(() => parseDateAlias('2025-01-15T25:00', ref)).toThrow();
      for (const bad of ['d', '7x', '1.5d', '-3d', ' 7 d']) {
        expect(() => parseDateAlias(bad, ref)).toThrow('Invalid date alias');
      }
    });
  });

  it('toEndOfDay closes the UTC day', () => {
    const d = new Date('2025-06-15T08:00:00Z');
    expect(iso(toEndOfDay(d))).toBe('2025-06-15T23:59:59.999Z');
    expect(iso(d)).toBe('2025-06-15T08:00:00.000Z');
  });

  it('an Automation window boundary uses the parsed UTC day', () => {
    expect(iso(parseAutomationWindowDate('2025-06-15'))).toBe('2025-06-15T00:00:00.000Z');
    expect(iso(parseAutomationWindowDate('0099-01-15'))).toBe('0099-01-15T00:00:00.000Z');
    expect(iso(parseAutomationWindowDate('2025-06-15T23:30:00-08:00'))).toBe(
      '2025-06-16T00:00:00.000Z'
    );
  });

  it('month ranges close on the last millisecond of the UTC month', () => {
    expect(
      foldUnprocessedRanges(
        [{ month: '2025-06-01T00:00:00.000Z', total: 3 }],
        [{ month: '2025-06-01T00:00:00.000Z', linked: 1 }],
        false
      )
    ).toEqual([
      {
        month: '2025-06',
        window_start: '2025-06-01T00:00:00.000Z',
        window_end: '2025-06-30T23:59:59.999Z',
        total_content: 3,
        processed_content: 1,
        unprocessed_content: 2,
        status: 'partial',
      },
    ]);
  });
});
