import { describe, it, expect } from 'vitest';
import { isUsMarketOpen, _holidaysForYear } from './marketHours.js';

/**
 * Build a UTC Date from a wall-clock America/New_York time. We compute the
 * UTC offset that ET is at on that local day (EST = -5, EDT = -4) by
 * round-tripping through Intl, so DST flips don't make the suite brittle.
 */
function etDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // Try -5 (EST); if when projected back to ET it shows the requested wall
  // clock, keep it. Otherwise use -4 (EDT).
  for (const offset of [-5, -4]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour - offset, minute));
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(candidate).map((p) => [p.type, p.value]),
    );
    const h = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      h === hour &&
      Number(parts.minute) === minute
    ) {
      return candidate;
    }
  }
  // Fallback: assume EST.
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

describe('isUsMarketOpen', () => {
  // 2024-06-12 is a Wednesday (no holiday).
  it('returns false during pre-market (09:00 ET, regular weekday)', () => {
    expect(isUsMarketOpen(etDate(2024, 6, 12, 9, 0))).toBe(false);
    expect(isUsMarketOpen(etDate(2024, 6, 12, 9, 29))).toBe(false);
  });

  it('returns true during regular hours (10:00 and 15:59 ET, regular weekday)', () => {
    expect(isUsMarketOpen(etDate(2024, 6, 12, 9, 30))).toBe(true);
    expect(isUsMarketOpen(etDate(2024, 6, 12, 10, 0))).toBe(true);
    expect(isUsMarketOpen(etDate(2024, 6, 12, 15, 59))).toBe(true);
  });

  it('returns false during after-hours (16:00 and 18:30 ET, regular weekday)', () => {
    expect(isUsMarketOpen(etDate(2024, 6, 12, 16, 0))).toBe(false);
    expect(isUsMarketOpen(etDate(2024, 6, 12, 18, 30))).toBe(false);
  });

  it('returns false on a weekend (Saturday 11:00 ET)', () => {
    // 2024-06-15 is a Saturday.
    expect(isUsMarketOpen(etDate(2024, 6, 15, 11, 0))).toBe(false);
    // Sunday too.
    expect(isUsMarketOpen(etDate(2024, 6, 16, 11, 0))).toBe(false);
  });

  it('returns false on a known holiday (Christmas, Dec 25 2024 at 11:00 ET)', () => {
    // Dec 25 2024 is a Wednesday, full NYSE close.
    expect(isUsMarketOpen(etDate(2024, 12, 25, 11, 0))).toBe(false);
  });

  it('computes a sane US market holiday calendar for 2024', () => {
    const h = _holidaysForYear(2024);
    // Spot checks — observed dates per NYSE 2024 calendar.
    expect(h.has('2024-01-01')).toBe(true); // New Year's Day
    expect(h.has('2024-01-15')).toBe(true); // MLK Day (3rd Mon Jan)
    expect(h.has('2024-02-19')).toBe(true); // Presidents Day
    expect(h.has('2024-03-29')).toBe(true); // Good Friday
    expect(h.has('2024-05-27')).toBe(true); // Memorial Day
    expect(h.has('2024-06-19')).toBe(true); // Juneteenth
    expect(h.has('2024-07-04')).toBe(true); // Independence Day
    expect(h.has('2024-09-02')).toBe(true); // Labor Day
    expect(h.has('2024-11-28')).toBe(true); // Thanksgiving
    expect(h.has('2024-12-25')).toBe(true); // Christmas
  });
});
