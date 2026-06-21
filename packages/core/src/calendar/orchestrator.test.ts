import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CalendarOrchestrator,
  type CalendarUpdateEvent,
  type EarningsSource,
  type HolidaySource,
} from './orchestrator.js';
import { CalendarStore, makeEventId } from './store.js';
import type { CalendarEvent, CalendarSource } from '../schemas/calendar.js';

function holidayEvent(opts: {
  startUtc: string;
  title: string;
  sourceName: 'NYSE' | 'Fed';
  fetchedAt?: string;
}): CalendarEvent {
  const sourceUrl =
    opts.sourceName === 'NYSE'
      ? 'https://www.nyse.com/markets/hours-calendars'
      : 'https://www.federalreserve.gov/aboutthefed/k8.htm';
  const sources: CalendarSource[] = [{ name: opts.sourceName, url: sourceUrl }];
  return {
    id: makeEventId({
      kind: 'market_holiday',
      symbol: null,
      startUtc: opts.startUtc,
      sources,
    }),
    kind: 'market_holiday',
    symbol: null,
    startUtc: opts.startUtc,
    endUtc: opts.startUtc,
    allDay: true,
    title: opts.title,
    sources,
    fetchedAt: opts.fetchedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function earningsEvent(opts: {
  symbol: string;
  startUtc: string;
  sourceName: 'SEC' | 'Yahoo' | 'Nasdaq';
  title?: string;
  fetchedAt?: string;
}): CalendarEvent {
  const sourceUrlMap = {
    SEC: 'https://www.sec.gov/cgi-bin/browse-edgar',
    Yahoo: `https://finance.yahoo.com/quote/${opts.symbol}`,
    Nasdaq: `https://api.nasdaq.com/api/calendar/earnings`,
  } as const;
  const sources: CalendarSource[] = [
    { name: opts.sourceName, url: sourceUrlMap[opts.sourceName] },
  ];
  return {
    id: makeEventId({
      kind: 'earnings',
      symbol: opts.symbol.toUpperCase(),
      startUtc: opts.startUtc,
      sources,
    }),
    kind: 'earnings',
    symbol: opts.symbol.toUpperCase(),
    startUtc: opts.startUtc,
    endUtc: opts.startUtc,
    allDay: false,
    title: opts.title ?? `${opts.symbol.toUpperCase()} earnings`,
    sources,
    fetchedAt: opts.fetchedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

class FakeHolidaySource implements HolidaySource {
  constructor(
    readonly id: 'nyse' | 'fed',
    readonly impl: () => Promise<CalendarEvent[]>,
  ) {}
  fetch(): Promise<CalendarEvent[]> {
    return this.impl();
  }
}

class FakeEarningsSource implements EarningsSource {
  constructor(
    readonly id: 'sec' | 'yahoo' | 'nasdaq',
    readonly impl: (symbol: string) => Promise<CalendarEvent[]>,
  ) {}
  fetchSymbol(symbol: string): Promise<CalendarEvent[]> {
    return this.impl(symbol);
  }
}

describe('CalendarOrchestrator', () => {
  let root: string;
  let store: CalendarStore;
  const NOW = new Date('2026-06-21T12:00:00.000Z');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rt-orch-'));
    store = new CalendarStore({ root, now: () => NOW });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('refreshHolidays', () => {
    it('reconciles NYSE over Fed on the same date', async () => {
      const nyseEvt = holidayEvent({
        startUtc: '2026-07-03T00:00:00.000Z',
        title: 'Independence Day (observed) — NYSE',
        sourceName: 'NYSE',
      });
      const fedEvt = holidayEvent({
        startUtc: '2026-07-03T00:00:00.000Z',
        title: 'Independence Day (observed) — Fed',
        sourceName: 'Fed',
      });

      const events: CalendarUpdateEvent[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [
          new FakeHolidaySource('nyse', async () => [nyseEvt]),
          new FakeHolidaySource('fed', async () => [fedEvt]),
        ],
        earningsSources: [],
        emit: (e) => events.push(e),
        now: () => NOW,
      });

      const result = await orch.refreshHolidays();
      expect(result.ok).toBe(true);
      expect(result.staleSources).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.events).toBe(1);

      // The persisted event should be the NYSE one.
      const persisted = await store.eventsBetween(
        '2026-07-01T00:00:00.000Z',
        '2026-07-31T00:00:00.000Z',
        { symbol: null },
      );
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.title).toBe('Independence Day (observed) — NYSE');

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('holidays');
      expect(events[0]?.count).toBe(1);
      expect(events[0]?.staleSources).toEqual([]);
    });

    it('keeps the Fed event when NYSE returns nothing for that date', async () => {
      const fedEvt = holidayEvent({
        startUtc: '2026-12-25T00:00:00.000Z',
        title: 'Christmas Day — Fed',
        sourceName: 'Fed',
      });
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [
          new FakeHolidaySource('nyse', async () => []),
          new FakeHolidaySource('fed', async () => [fedEvt]),
        ],
        earningsSources: [],
        now: () => NOW,
      });

      const result = await orch.refreshHolidays();
      expect(result.ok).toBe(true);
      expect(result.events).toBeGreaterThanOrEqual(1);

      const persisted = await store.eventsBetween(
        '2026-12-24T00:00:00.000Z',
        '2026-12-26T00:00:00.000Z',
        { symbol: null },
      );
      expect(persisted.map((e) => e.title)).toContain('Christmas Day — Fed');
    });

    it('marks holidays stale when every source fails', async () => {
      const events: CalendarUpdateEvent[] = [];
      const errs: Array<{ ctx: string; err: unknown }> = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [
          new FakeHolidaySource('nyse', async () => {
            throw new Error('nyse down');
          }),
          new FakeHolidaySource('fed', async () => {
            throw new Error('fed down');
          }),
        ],
        earningsSources: [],
        emit: (e) => events.push(e),
        onError: (ctx, err) => errs.push({ ctx, err }),
        now: () => NOW,
      });

      const result = await orch.refreshHolidays();
      expect(result.ok).toBe(false);
      expect(result.events).toBe(0);
      expect(result.staleSources.slice().sort()).toEqual(['fed', 'nyse']);
      expect(result.errors).toHaveLength(2);
      expect(orch.stale).toBe(true);
      expect(orch.holidaysAreStale).toBe(true);
      // No emit on hard failure.
      expect(events).toHaveLength(0);
      expect(errs.map((e) => e.ctx).sort()).toEqual([
        'holidays:fed',
        'holidays:nyse',
      ]);
    });

    it('partial recovery clears the stale flag', async () => {
      const nyseEvt = holidayEvent({
        startUtc: '2026-09-07T00:00:00.000Z',
        title: 'Labor Day',
        sourceName: 'NYSE',
      });
      let nyseShouldFail = true;
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [
          new FakeHolidaySource('nyse', async () => {
            if (nyseShouldFail) throw new Error('nyse down');
            return [nyseEvt];
          }),
          new FakeHolidaySource('fed', async () => {
            throw new Error('fed down');
          }),
        ],
        earningsSources: [],
        now: () => NOW,
      });

      // First pass: both fail → stale.
      const r1 = await orch.refreshHolidays();
      expect(r1.ok).toBe(false);
      expect(orch.holidaysAreStale).toBe(true);

      // Second pass: NYSE recovers (Fed still down) → not stale.
      nyseShouldFail = false;
      const r2 = await orch.refreshHolidays();
      expect(r2.ok).toBe(true);
      expect(r2.staleSources).toEqual(['fed']);
      expect(orch.holidaysAreStale).toBe(false);
    });

    it('one source throwing does not block the other', async () => {
      const fedEvt = holidayEvent({
        startUtc: '2026-11-26T00:00:00.000Z',
        title: 'Thanksgiving',
        sourceName: 'Fed',
      });
      const events: CalendarUpdateEvent[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [
          new FakeHolidaySource('nyse', async () => {
            throw new Error('nyse down');
          }),
          new FakeHolidaySource('fed', async () => [fedEvt]),
        ],
        earningsSources: [],
        emit: (e) => events.push(e),
        now: () => NOW,
      });

      const result = await orch.refreshHolidays();
      expect(result.ok).toBe(true);
      expect(result.staleSources).toEqual(['nyse']);
      expect(result.events).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.staleSources).toEqual(['nyse']);
    });

    it('does not change stale when no holiday sources are configured', async () => {
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [],
        now: () => NOW,
      });
      const result = await orch.refreshHolidays();
      expect(result.ok).toBe(true);
      expect(result.events).toBe(0);
      expect(orch.holidaysAreStale).toBe(false);
    });
  });

  describe('refreshEarnings', () => {
    it('reconciles SEC > Yahoo > Nasdaq on the same (symbol, date)', async () => {
      const sec = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T21:00:00.000Z',
        sourceName: 'SEC',
        title: 'NVDA earnings (SEC)',
      });
      const yahoo = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T20:00:00.000Z',
        sourceName: 'Yahoo',
        title: 'NVDA earnings (Yahoo)',
      });
      const nasdaq = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T22:30:00.000Z',
        sourceName: 'Nasdaq',
        title: 'NVDA earnings (Nasdaq)',
      });
      const events: CalendarUpdateEvent[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('sec', async () => [sec]),
          new FakeEarningsSource('yahoo', async () => [yahoo]),
          new FakeEarningsSource('nasdaq', async () => [nasdaq]),
        ],
        emit: (e) => events.push(e),
        now: () => NOW,
      });
      const result = await orch.refreshEarnings(['nvda']);
      expect(result.ok).toBe(true);
      expect(result.events).toBe(1);
      expect(result.staleSources).toEqual([]);

      const persisted = await store.eventsBetween(
        '2026-05-22T00:00:00.000Z',
        '2026-05-23T00:00:00.000Z',
        { symbol: 'NVDA' },
      );
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.title).toBe('NVDA earnings (SEC)');

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('earnings');
      expect(events[0]?.count).toBe(1);
      expect(events[0]?.symbols).toEqual(['NVDA']);
    });

    it('falls back to Yahoo when SEC is absent', async () => {
      const yahoo = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T20:00:00.000Z',
        sourceName: 'Yahoo',
        title: 'NVDA earnings (Yahoo)',
      });
      const nasdaq = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T22:30:00.000Z',
        sourceName: 'Nasdaq',
        title: 'NVDA earnings (Nasdaq)',
      });
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('yahoo', async () => [yahoo]),
          new FakeEarningsSource('nasdaq', async () => [nasdaq]),
        ],
        now: () => NOW,
      });
      const result = await orch.refreshEarnings(['NVDA']);
      expect(result.ok).toBe(true);
      expect(result.events).toBe(1);

      const persisted = await store.eventsBetween(
        '2026-05-22T00:00:00.000Z',
        '2026-05-23T00:00:00.000Z',
        { symbol: 'NVDA' },
      );
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.title).toBe('NVDA earnings (Yahoo)');
    });

    it('marks earnings stale only when every source throws for every symbol', async () => {
      const events: CalendarUpdateEvent[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('sec', async () => {
            throw new Error('sec down');
          }),
          new FakeEarningsSource('yahoo', async () => {
            throw new Error('yahoo down');
          }),
        ],
        emit: (e) => events.push(e),
        now: () => NOW,
      });
      const result = await orch.refreshEarnings(['NVDA', 'AAPL']);
      expect(result.ok).toBe(false);
      expect(result.staleSources.slice().sort()).toEqual(['sec', 'yahoo']);
      expect(result.errors.length).toBe(4); // 2 sources × 2 symbols
      expect(orch.earningsAreStale).toBe(true);
      expect(orch.stale).toBe(true);
      expect(events).toHaveLength(0);
    });

    it('does NOT mark stale when sources just return empty (quiet period)', async () => {
      const events: CalendarUpdateEvent[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('yahoo', async () => []),
          new FakeEarningsSource('nasdaq', async () => []),
        ],
        emit: (e) => events.push(e),
        now: () => NOW,
      });
      const result = await orch.refreshEarnings(['NVDA']);
      expect(result.ok).toBe(true);
      expect(result.events).toBe(0);
      expect(orch.earningsAreStale).toBe(false);
      // We still emit a calendar.update so downstream knows we ran.
      expect(events).toHaveLength(1);
      expect(events[0]?.count).toBe(0);
    });

    it('one source erroring for one symbol does not block the others', async () => {
      const yahooNvda = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T20:00:00.000Z',
        sourceName: 'Yahoo',
      });
      const yahooAapl = earningsEvent({
        symbol: 'AAPL',
        startUtc: '2026-05-01T20:30:00.000Z',
        sourceName: 'Yahoo',
      });
      const errs: Array<{ ctx: string; err: unknown }> = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('sec', async (sym) => {
            if (sym === 'NVDA') throw new Error('SEC NVDA failed');
            return [];
          }),
          new FakeEarningsSource('yahoo', async (sym) => {
            if (sym === 'NVDA') return [yahooNvda];
            if (sym === 'AAPL') return [yahooAapl];
            return [];
          }),
        ],
        onError: (ctx, err) => errs.push({ ctx, err }),
        now: () => NOW,
      });
      const result = await orch.refreshEarnings(['NVDA', 'AAPL']);
      expect(result.ok).toBe(true);
      expect(result.events).toBe(2);
      // SEC succeeded (empty) for AAPL → not in staleSources.
      expect(result.staleSources).toEqual([]);
      expect(errs.map((e) => e.ctx).sort()).toEqual(['earnings:sec:NVDA']);
    });

    it('partial earnings recovery clears the stale flag', async () => {
      let yahooDown = true;
      const yahooEvt = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T20:00:00.000Z',
        sourceName: 'Yahoo',
      });
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('yahoo', async () => {
            if (yahooDown) throw new Error('yahoo down');
            return [yahooEvt];
          }),
        ],
        now: () => NOW,
      });
      const r1 = await orch.refreshEarnings(['NVDA']);
      expect(r1.ok).toBe(false);
      expect(orch.earningsAreStale).toBe(true);

      yahooDown = false;
      const r2 = await orch.refreshEarnings(['NVDA']);
      expect(r2.ok).toBe(true);
      expect(orch.earningsAreStale).toBe(false);
    });

    it('empty symbol list is a no-op success', async () => {
      const events: CalendarUpdateEvent[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('yahoo', async () => {
            throw new Error('should not be called');
          }),
        ],
        emit: (e) => events.push(e),
        now: () => NOW,
      });
      const result = await orch.refreshEarnings([]);
      expect(result.ok).toBe(true);
      expect(result.events).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('normalizes symbols to uppercase before forwarding', async () => {
      const seen: string[] = [];
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('yahoo', async (sym) => {
            seen.push(sym);
            return [];
          }),
        ],
        now: () => NOW,
      });
      await orch.refreshEarnings(['nvda', 'aApl']);
      expect(seen.sort()).toEqual(['AAPL', 'NVDA']);
    });

    it('honors custom source weights (Nasdaq overrides Yahoo when weighted higher)', async () => {
      const yahoo = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T20:00:00.000Z',
        sourceName: 'Yahoo',
        title: 'Yahoo wins normally',
      });
      const nasdaq = earningsEvent({
        symbol: 'NVDA',
        startUtc: '2026-05-22T22:00:00.000Z',
        sourceName: 'Nasdaq',
        title: 'Nasdaq wins via override',
      });
      const orch = new CalendarOrchestrator({
        store,
        holidaySources: [],
        earningsSources: [
          new FakeEarningsSource('yahoo', async () => [yahoo]),
          new FakeEarningsSource('nasdaq', async () => [nasdaq]),
        ],
        sourceWeights: { yahoo: 10, nasdaq: 999 },
        now: () => NOW,
      });
      const result = await orch.refreshEarnings(['NVDA']);
      expect(result.ok).toBe(true);

      const persisted = await store.eventsBetween(
        '2026-05-22T00:00:00.000Z',
        '2026-05-23T00:00:00.000Z',
        { symbol: 'NVDA' },
      );
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.title).toBe('Nasdaq wins via override');
    });
  });
});
