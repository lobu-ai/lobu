/**
 * Date Alias Parsing Utility
 *
 * Supports human-friendly date shortcuts:
 * - Named: 'today', 'yesterday', 'last_week', 'last_month'
 * - Relative: '7d', '30d', '90d', '1m', '3m', '6m', '1y'
 * - ISO 8601: '2025-01-01', '2025-01-01T12:00:00Z', '2025-01-01T12:00:00+03'
 *
 * Calendar-day aliases and date-only inputs use UTC. A datetime without an
 * offset is also interpreted as UTC, while an explicit offset is respected.
 * The server process's local timezone is an accident of where it runs and must
 * not change what the same input means on a laptop versus production.
 *
 * Parsing and calendar arithmetic are Temporal's: its ISO 8601 grammar rejects
 * impossible dates and times, and month arithmetic clamps (Mar 31 minus one
 * month is Feb 28) instead of rolling over into the next month the way `Date`
 * setters do.
 */

import { Temporal } from '@js-temporal/polyfill';

interface ParsedDateAlias {
  date: Date;
  originalInput: string;
}

type CalendarOffset = { days?: number; months?: number };

// Maps, not object literals: an object lookup would also find inherited keys
// such as `constructor`, so invalid input would resolve instead of throwing.
const NAMED_ALIASES = new Map<string, CalendarOffset>([
  ['today', {}],
  ['yesterday', { days: 1 }],
  ['last_week', { days: 7 }],
  ['last_month', { months: 1 }],
]);

const RELATIVE_UNITS = new Map<string, (value: number) => CalendarOffset>([
  ['d', (value) => ({ days: value })],
  ['w', (value) => ({ days: value * 7 })],
  ['m', (value) => ({ months: value })],
  ['q', (value) => ({ months: value * 3 })],
  ['y', (value) => ({ months: value * 12 })],
]);

/**
 * Parse a date alias into a Date object
 * @param alias - The date alias string (e.g., 'yesterday', '7d', '2025-01-01')
 * @param referenceDate - Optional reference date (defaults to now)
 * @returns ParsedDateAlias object
 * @throws Error if the alias is invalid
 */
export function parseDateAlias(alias: string, referenceDate: Date = new Date()): ParsedDateAlias {
  const raw = alias.trim();
  const unquoted =
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1).trim()
      : raw;
  const lowered = unquoted.toLowerCase();

  const named = NAMED_ALIASES.get(lowered);
  if (named) {
    return { date: utcDayStartBefore(referenceDate, named), originalInput: alias };
  }

  const relative = parseRelativeAlias(lowered);
  if (relative) {
    return { date: utcDayStartBefore(referenceDate, relative), originalInput: alias };
  }

  const instant = parseIsoInstant(unquoted);
  if (instant) {
    return { date: instant, originalInput: alias };
  }

  throw new Error(
    `Invalid date alias: "${alias}". ` +
      'Supported formats:\n' +
      '  - Named: today, yesterday, last_week, last_month\n' +
      '  - Relative: 7d, 30d, 90d, 1m, 3m, 6m, 1y (d=days, w=weeks, m=months, q=quarters, y=years)\n' +
      '  - ISO 8601: 2025-01-01 or 2025-01-01T12:00:00Z'
  );
}

/** `<digits><unit>` such as `7d` or `3m`, as the calendar distance it names. */
function parseRelativeAlias(value: string): CalendarOffset | null {
  const toOffset = RELATIVE_UNITS.get(value.slice(-1));
  const digits = value.slice(0, -1);
  if (!toOffset || digits.length === 0) return null;
  for (const char of digits) {
    if (char < '0' || char > '9') return null;
  }
  return toOffset(Number(digits));
}

/**
 * An ISO 8601 date or datetime as an instant. A string with an offset (`Z`,
 * `+03`, `+03:00`) is that instant; one without is read as UTC wall time.
 */
function parseIsoInstant(value: string): Date | null {
  try {
    return new Date(Temporal.Instant.from(value).epochMilliseconds);
  } catch {
    // No offset, or not ISO 8601 at all: try it as UTC wall time.
  }
  try {
    return new Date(
      Temporal.PlainDateTime.from(value).toZonedDateTime('UTC').epochMilliseconds
    );
  } catch {
    return null;
  }
}

/** Midnight UTC of the calendar day `offset` before `reference`'s UTC day. */
function utcDayStartBefore(reference: Date, offset: CalendarOffset): Date {
  const day = Temporal.Instant.fromEpochMilliseconds(reference.getTime())
    .toZonedDateTimeISO('UTC')
    .toPlainDate()
    .subtract({ days: offset.days ?? 0, months: offset.months ?? 0 });
  return new Date(day.toZonedDateTime('UTC').epochMilliseconds);
}

/**
 * Convert a date to the end of its UTC day (23:59:59.999Z)
 * Used for "until" date filters to include the entire day
 */
export function toEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}
