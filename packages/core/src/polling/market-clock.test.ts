import { describe, it, expect } from 'vitest';
import { MarketClock, type MarketCalendar } from './market-clock.js';

function fixedCalendar(): MarketCalendar {
  return {
    timezone: 'America/New_York',
    regularHours: { open: '09:30', close: '16:00' },
    holidays: new Set(['2025-12-25', '2025-01-01']),
    earlyCloses: new Map([['2025-11-28', '13:00']]),
  };
}

function clockAt(iso: string): MarketClock {
  return new MarketClock({ calendar: fixedCalendar(), now: () => new Date(iso) });
}

describe('MarketClock', () => {
  it('returns rth during regular trading hours on a weekday', () => {
    // 2025-06-10 is a Tuesday. 14:30 UTC = 10:30 ET (EDT).
    expect(clockAt('2025-06-10T14:30:00Z').state()).toBe('rth');
  });

  it('returns pre during pre-market (04:00–09:30 ET)', () => {
    // 2025-06-10 12:00 UTC = 08:00 ET (EDT).
    expect(clockAt('2025-06-10T12:00:00Z').state()).toBe('pre');
  });

  it('returns post during after-hours (16:00–20:00 ET)', () => {
    // 2025-06-10 22:00 UTC = 18:00 ET (EDT).
    expect(clockAt('2025-06-10T22:00:00Z').state()).toBe('post');
  });

  it('returns closed before 04:00 ET and after 20:00 ET on a weekday', () => {
    // 2025-06-10 02:00 ET = 06:00 UTC.
    expect(clockAt('2025-06-10T06:00:00Z').state()).toBe('closed');
    // 2025-06-10 21:00 ET = 01:00 UTC next day.
    expect(clockAt('2025-06-11T01:00:00Z').state()).toBe('closed');
  });

  it('returns closed on weekends', () => {
    // 2025-06-14 is Saturday.
    expect(clockAt('2025-06-14T15:00:00Z').state()).toBe('closed');
    // 2025-06-15 is Sunday.
    expect(clockAt('2025-06-15T15:00:00Z').state()).toBe('closed');
  });

  it('returns holiday on listed market holidays', () => {
    // 2025-12-25 14:30 ET = 19:30 UTC.
    expect(clockAt('2025-12-25T19:30:00Z').state()).toBe('holiday');
    expect(clockAt('2025-12-25T19:30:00Z').isHoliday('2025-12-25')).toBe(true);
  });

  it('honours early closes', () => {
    const c = clockAt('2025-11-28T18:30:00Z'); // 13:30 ET, after early close
    expect(c.state()).toBe('post');
    expect(c.closeTimeFor('2025-11-28')).toBe('13:00');
    // 12:30 ET should still be RTH.
    expect(clockAt('2025-11-28T17:30:00Z').state()).toBe('rth');
  });

  it('isOpen mirrors rth', () => {
    expect(clockAt('2025-06-10T14:30:00Z').isOpen()).toBe(true);
    expect(clockAt('2025-06-10T22:00:00Z').isOpen()).toBe(false);
  });

  it('loads the bundled calendar by default', () => {
    const c = new MarketClock();
    const cal = c.getCalendar();
    expect(cal.holidays.size).toBeGreaterThan(0);
    expect(cal.regularHours.open).toBe('09:30');
  });
});
