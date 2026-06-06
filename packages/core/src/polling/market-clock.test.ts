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

  describe('CalendarStore integration (issue #61)', () => {
    type StoreEvent = {
      readonly kind: string;
      readonly startUtc: string;
      readonly details?: { readonly closeTimeEt?: string } | undefined;
    };
    function fakeStore(events: ReadonlyArray<StoreEvent>): {
      eventsBetween: (
        fromUtc: string,
        toUtc: string,
        query?: { symbol?: string | null; kinds?: ReadonlyArray<string> },
      ) => Promise<ReadonlyArray<StoreEvent>>;
      calls: number;
    } {
      const obj = {
        calls: 0,
        async eventsBetween(
          _fromUtc: string,
          _toUtc: string,
          _query?: { symbol?: string | null; kinds?: ReadonlyArray<string> },
        ): Promise<ReadonlyArray<StoreEvent>> {
          obj.calls += 1;
          return events;
        },
      };
      return obj;
    }

    it('regular trading day: store with no events for the day leaves rth intact', async () => {
      const store = fakeStore([
        // Some other day's holiday — unrelated to the queried date.
        { kind: 'market_holiday', startUtc: '2025-12-25T05:00:00.000Z' },
      ]);
      const c = new MarketClock({
        calendar: fixedCalendar(),
        store,
        now: () => new Date('2025-06-10T14:30:00Z'), // Tue 10:30 ET
      });
      await c.refreshFromStore();
      expect(c.state()).toBe('rth');
      expect(c.isHoliday('2025-12-25')).toBe(true);
    });

    it('full holiday from store: state goes to "holiday" on that ET date', async () => {
      // 2026-01-19 = MLK Day. 09:30 ET = 14:30 UTC (EST).
      const store = fakeStore([
        { kind: 'market_holiday', startUtc: '2026-01-19T05:00:00.000Z' },
      ]);
      const c = new MarketClock({
        calendar: fixedCalendar(),
        store,
        now: () => new Date('2026-01-19T14:30:00Z'),
      });
      await c.refreshFromStore();
      expect(c.state()).toBe('holiday');
      expect(c.isHoliday('2026-01-19')).toBe(true);
    });

    it('early close from store is applied (closeTimeEt drives the cutoff)', async () => {
      // 2026-07-03 is a Friday — commonly early-close in real life.
      const store = fakeStore([
        {
          kind: 'market_early_close',
          startUtc: '2026-07-03T04:00:00.000Z',
          details: { closeTimeEt: '13:00' },
        },
      ]);
      const c = new MarketClock({
        calendar: fixedCalendar(),
        store,
        // 13:30 ET = 17:30 UTC. After early close — should be post.
        now: () => new Date('2026-07-03T17:30:00Z'),
      });
      await c.refreshFromStore();
      expect(c.closeTimeFor('2026-07-03')).toBe('13:00');
      expect(c.state()).toBe('post');
    });

    it('day after schema fallback: store throws -> keeps active calendar', async () => {
      const throwing = {
        async eventsBetween(): Promise<never> {
          throw new Error('disk corrupted');
        },
      };
      const c = new MarketClock({
        calendar: fixedCalendar(),
        store: throwing,
        now: () => new Date('2025-12-25T19:30:00Z'),
      });
      // Refresh swallows the error and keeps the bundled fixture.
      const cal = await c.refreshFromStore();
      expect(cal.holidays.has('2025-12-25')).toBe(true);
      expect(c.state()).toBe('holiday');
    });

    it('store empty -> bundled fallback is used (first boot before cron)', async () => {
      const store = fakeStore([]);
      const c = new MarketClock({
        calendar: fixedCalendar(),
        store,
        now: () => new Date('2025-12-25T19:30:00Z'),
      });
      await c.refreshFromStore();
      // Bundled fixture still has 2025-12-25 as a holiday.
      expect(c.state()).toBe('holiday');
      expect(c.isHoliday('2025-12-25')).toBe(true);
    });

    it('refreshFromStore notifies onCalendarUpdate listeners only on change', async () => {
      const store = fakeStore([
        { kind: 'market_holiday', startUtc: '2026-01-19T05:00:00.000Z' },
      ]);
      const c = new MarketClock({ calendar: fixedCalendar(), store });
      let calls = 0;
      const off = c.onCalendarUpdate(() => {
        calls += 1;
      });
      await c.refreshFromStore();
      expect(calls).toBe(1);
      // Second refresh with identical store payload: no-op.
      await c.refreshFromStore();
      expect(calls).toBe(1);
      off();
    });

    it('refreshFromStore is a no-op when no store is configured', async () => {
      const c = new MarketClock({ calendar: fixedCalendar() });
      const before = c.getCalendar();
      const after = await c.refreshFromStore();
      expect(after).toBe(before);
    });
  });
});
