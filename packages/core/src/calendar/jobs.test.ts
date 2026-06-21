import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALENDAR_EARNINGS_JOB_ID,
  CALENDAR_HOLIDAYS_JOB_ID,
  DEFAULT_EARNINGS_CADENCE_MS,
  DEFAULT_HOLIDAYS_WEEKLY_FALLBACK_MS,
  createCalendarEarningsJob,
  createCalendarHolidaysJob,
  msUntilNextEt,
} from './jobs.js';
import { CalendarOrchestrator, type EarningsSource, type HolidaySource } from './orchestrator.js';
import { CalendarStore } from './store.js';
import type { CalendarEvent } from '../schemas/calendar.js';
import type { JobContext } from '../polling/scheduler.js';

class StubHolidaySource implements HolidaySource {
  constructor(
    readonly id: 'nyse' | 'fed',
    readonly events: CalendarEvent[],
  ) {}
  async fetch(): Promise<CalendarEvent[]> {
    return this.events;
  }
}

class StubEarningsSource implements EarningsSource {
  public callCount = 0;
  public callSymbols: string[] = [];
  constructor(
    readonly id: 'sec' | 'yahoo' | 'nasdaq',
    private readonly bySymbol: Map<string, CalendarEvent[]> = new Map(),
  ) {}
  async fetchSymbol(symbol: string): Promise<CalendarEvent[]> {
    this.callCount += 1;
    this.callSymbols.push(symbol);
    return this.bySymbol.get(symbol) ?? [];
  }
}

function ctx(id: string): JobContext {
  return {
    id,
    state: 'rth',
    attempt: 1,
    now: new Date('2026-06-21T12:00:00.000Z'),
  };
}

describe('createCalendarHolidaysJob', () => {
  let root: string;
  let store: CalendarStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rt-jobs-h-'));
    store = new CalendarStore({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('has the documented id and is single-flight', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarHolidaysJob({ orchestrator: orch });
    expect(job.id).toBe(CALENDAR_HOLIDAYS_JOB_ID);
    expect(job.id).toBe('calendar.holidays');
    expect(job.singleFlight).toBe(true);
  });

  it('cadence returns a positive ms-until-next-03:15-ET window (< 24h)', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarHolidaysJob({
      orchestrator: orch,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
    });
    const ms = job.cadence('rth');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('cadence is constant regardless of MarketState', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarHolidaysJob({
      orchestrator: orch,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
    });
    const a = job.cadence('rth');
    const b = job.cadence('closed');
    const c = job.cadence('holiday');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('falls back to weekly when disabled', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarHolidaysJob({
      orchestrator: orch,
      disabled: true,
    });
    expect(job.cadence('rth')).toBe(DEFAULT_HOLIDAYS_WEEKLY_FALLBACK_MS);
  });

  it('respects a custom weekly fallback', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const custom = 3 * 24 * 60 * 60 * 1000; // 3 days
    const job = createCalendarHolidaysJob({
      orchestrator: orch,
      disabled: true,
      weeklyFallbackMs: custom,
    });
    expect(job.cadence('rth')).toBe(custom);
  });

  it('respects a custom daily-at-ET target', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    // 04:00 ET target from a 12:00Z (08:00 ET in DST) "now" → ~20h until next.
    // We just check that it differs from the default 03:15 ET.
    const now = () => new Date('2026-06-21T12:00:00.000Z');
    const defaultJob = createCalendarHolidaysJob({ orchestrator: orch, now });
    const customJob = createCalendarHolidaysJob({
      orchestrator: orch,
      dailyAtET: { hour: 4, minute: 0 },
      now,
    });
    expect(customJob.cadence('rth')).not.toBe(defaultJob.cadence('rth'));
  });

  it('throws on an invalid daily-at-ET target', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    expect(() =>
      createCalendarHolidaysJob({
        orchestrator: orch,
        dailyAtET: { hour: 24, minute: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createCalendarHolidaysJob({
        orchestrator: orch,
        dailyAtET: { hour: 0, minute: 60 },
      }),
    ).toThrow(RangeError);
  });

  it('run() invokes orchestrator.refreshHolidays() and emits calendar.update', async () => {
    const nyseEvt: CalendarEvent = {
      id: 'h1',
      kind: 'market_holiday',
      symbol: null,
      startUtc: '2026-07-03T00:00:00.000Z',
      endUtc: '2026-07-03T00:00:00.000Z',
      allDay: true,
      title: 'Independence Day',
      sources: [{ name: 'NYSE', url: 'https://www.nyse.com/markets/hours-calendars' }],
      fetchedAt: '2026-01-01T00:00:00.000Z',
    };
    const emitted: unknown[] = [];
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [new StubHolidaySource('nyse', [nyseEvt])],
      earningsSources: [],
      emit: (e) => emitted.push(e),
    });
    const job = createCalendarHolidaysJob({ orchestrator: orch });
    await job.run(ctx(job.id));

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { kind: string }).kind).toBe('holidays');
  });

  it('run() swallows orchestrator errors (never crashes the scheduler)', async () => {
    // Manually craft an "orchestrator" stub that throws — the job must catch it.
    const onErrorCalls: unknown[] = [];
    const fakeOrchestrator = {
      refreshHolidays: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as CalendarOrchestrator;
    const job = createCalendarHolidaysJob({
      orchestrator: fakeOrchestrator,
      onError: (err) => onErrorCalls.push(err),
    });
    await expect(job.run(ctx(job.id))).resolves.toBeUndefined();
    expect(onErrorCalls).toHaveLength(1);
  });
});

describe('createCalendarEarningsJob', () => {
  let root: string;
  let store: CalendarStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rt-jobs-e-'));
    store = new CalendarStore({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('has the documented id and is single-flight', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarEarningsJob({
      orchestrator: orch,
      getWatchlist: () => [],
    });
    expect(job.id).toBe(CALENDAR_EARNINGS_JOB_ID);
    expect(job.id).toBe('calendar.earnings');
    expect(job.singleFlight).toBe(true);
  });

  it('cadence defaults to 6h regardless of MarketState', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarEarningsJob({
      orchestrator: orch,
      getWatchlist: () => [],
    });
    expect(job.cadence('rth')).toBe(DEFAULT_EARNINGS_CADENCE_MS);
    expect(job.cadence('closed')).toBe(DEFAULT_EARNINGS_CADENCE_MS);
    expect(DEFAULT_EARNINGS_CADENCE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('honors a custom cadence', () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const job = createCalendarEarningsJob({
      orchestrator: orch,
      getWatchlist: () => [],
      cadenceMs: 90_000,
    });
    expect(job.cadence('rth')).toBe(90_000);
  });

  it('run() reads the watchlist and forwards it to refreshEarnings', async () => {
    const yahoo = new StubEarningsSource(
      'yahoo',
      new Map([
        [
          'NVDA',
          [
            {
              id: 'e1',
              kind: 'earnings' as const,
              symbol: 'NVDA',
              startUtc: '2026-05-22T20:00:00.000Z',
              endUtc: '2026-05-22T20:00:00.000Z',
              allDay: false,
              title: 'NVDA earnings',
              sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
              fetchedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        ],
      ]),
    );
    const emitted: unknown[] = [];
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [yahoo],
      emit: (e) => emitted.push(e),
    });
    let symbolsPulled = 0;
    const job = createCalendarEarningsJob({
      orchestrator: orch,
      getWatchlist: () => {
        symbolsPulled += 1;
        return ['NVDA'];
      },
    });
    await job.run(ctx(job.id));
    expect(symbolsPulled).toBe(1);
    expect(yahoo.callSymbols).toEqual(['NVDA']);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { kind: string; count: number }).kind).toBe('earnings');
    expect((emitted[0] as { kind: string; count: number }).count).toBe(1);
  });

  it('run() swallows getWatchlist() errors (never crashes the scheduler)', async () => {
    const orch = new CalendarOrchestrator({
      store,
      holidaySources: [],
      earningsSources: [],
    });
    const onErrorCalls: unknown[] = [];
    const job = createCalendarEarningsJob({
      orchestrator: orch,
      getWatchlist: () => {
        throw new Error('watchlist down');
      },
      onError: (err) => onErrorCalls.push(err),
    });
    await expect(job.run(ctx(job.id))).resolves.toBeUndefined();
    expect(onErrorCalls).toHaveLength(1);
  });
});

describe('msUntilNextEt', () => {
  it('returns the same-day delta when target is in the future ET', () => {
    // Pick a winter date so ET = UTC-5. 12:00Z = 07:00 ET.
    // Target 03:15 ET → not until tomorrow.
    const now = new Date('2026-01-15T12:00:00.000Z');
    const ms = msUntilNextEt(now, { hour: 3, minute: 15 });
    // Tomorrow's 03:15 ET = next day 08:15Z (still EST).
    // From now (12:00Z today) → 08:15Z tomorrow = 20h15m.
    const expected = 20 * 60 * 60 * 1000 + 15 * 60 * 1000;
    expect(ms).toBeCloseTo(expected, -3); // allow a few ms drift
  });

  it('returns a small delta when target is just ahead ET', () => {
    // Winter: 03:00 ET = 08:00Z. Target 03:15 ET = 08:15Z. So at 08:14Z we want ~1 min.
    const now = new Date('2026-01-15T08:14:00.000Z');
    const ms = msUntilNextEt(now, { hour: 3, minute: 15 });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000 + 1000); // ~1 min ± slop
  });

  it('rolls to next day when target has just passed', () => {
    // Winter: 03:16 ET = 08:16Z. Target 03:15 ET → should be ~24h - 1 min.
    const now = new Date('2026-01-15T08:16:00.000Z');
    const ms = msUntilNextEt(now, { hour: 3, minute: 15 });
    const dayMs = 24 * 60 * 60 * 1000;
    expect(ms).toBeGreaterThan(dayMs - 2 * 60_000);
    expect(ms).toBeLessThanOrEqual(dayMs);
  });

  it('handles DST (summer ET = UTC-4)', () => {
    // June: 03:15 ET = 07:15Z.
    // At 07:00Z (= 03:00 ET on a DST day) we want ~15 min.
    const now = new Date('2026-06-21T07:00:00.000Z');
    const ms = msUntilNextEt(now, { hour: 3, minute: 15 });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(20 * 60_000); // generous bound for sub-second slop
    expect(ms).toBeGreaterThanOrEqual(14 * 60_000);
  });

  it('handles target at midnight ET', () => {
    // Winter: 00:00 ET = 05:00Z. From 04:30Z (winter) → 30 min.
    const now = new Date('2026-01-15T04:30:00.000Z');
    const ms = msUntilNextEt(now, { hour: 0, minute: 0 });
    expect(ms).toBeGreaterThan(29 * 60_000);
    expect(ms).toBeLessThan(31 * 60_000);
  });

  it('result is always positive', () => {
    // Try many "now" values across a year.
    const baseline = new Date('2026-01-01T00:00:00.000Z').getTime();
    for (let i = 0; i < 24; i++) {
      const now = new Date(baseline + i * 15 * 24 * 60 * 60 * 1000); // ~bi-weekly
      const ms = msUntilNextEt(now, { hour: 3, minute: 15 });
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
    }
  });
});
