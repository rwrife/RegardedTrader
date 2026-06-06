import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CalendarStore,
  earningsPath,
  holidaysPath,
  latestPath,
  makeEventId,
} from './store.js';
import type { CalendarEvent } from '../schemas/calendar.js';

function holidayEvent(
  overrides: Partial<CalendarEvent> & { startUtc: string; title: string },
): CalendarEvent {
  const sources = overrides.sources ?? [{ name: 'NYSE', url: 'https://www.nyse.com/holidays' }];
  const startUtc = overrides.startUtc;
  return {
    id:
      overrides.id ??
      makeEventId({ kind: 'market_holiday', symbol: null, startUtc, sources }),
    kind: 'market_holiday',
    symbol: null,
    startUtc,
    endUtc: overrides.endUtc ?? startUtc,
    allDay: overrides.allDay ?? true,
    title: overrides.title,
    sources,
    fetchedAt: overrides.fetchedAt ?? '2026-01-01T00:00:00.000Z',
    details: overrides.details,
  };
}

function earlyCloseEvent(
  startUtc: string,
  endUtc: string,
  closeTimeEt = '13:00',
): CalendarEvent {
  const sources = [{ name: 'NYSE', url: 'https://www.nyse.com/holidays' }];
  return {
    id: makeEventId({ kind: 'market_early_close', symbol: null, startUtc, sources }),
    kind: 'market_early_close',
    symbol: null,
    startUtc,
    endUtc,
    allDay: false,
    title: 'Day after Thanksgiving (early close)',
    sources,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    details: { closeTimeEt },
  };
}

function earningsEvent(
  symbol: string,
  startUtc: string,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  const sources = overrides.sources ?? [
    { name: 'Yahoo', url: 'https://finance.yahoo.com/quote/' + symbol },
  ];
  return {
    id:
      overrides.id ??
      makeEventId({ kind: 'earnings', symbol: symbol.toUpperCase(), startUtc, sources }),
    kind: 'earnings',
    symbol: symbol.toUpperCase(),
    startUtc,
    endUtc: overrides.endUtc ?? startUtc,
    allDay: overrides.allDay ?? false,
    title: `${symbol.toUpperCase()} earnings`,
    sources,
    fetchedAt: overrides.fetchedAt ?? '2026-01-01T00:00:00.000Z',
    details: overrides.details ?? { when: 'amc' },
  };
}

describe('CalendarStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'regard-cal-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('upserts events into the right files and is idempotent by id', async () => {
    const store = new CalendarStore({ root, now: () => new Date('2026-01-10T12:00:00.000Z') });

    const xmas = holidayEvent({ startUtc: '2026-12-25T00:00:00.000Z', title: 'Christmas' });
    const nvda = earningsEvent('nvda', '2026-02-20T21:00:00.000Z');

    const first = await store.upsertEvents([xmas, nvda]);
    expect(first).toEqual({ inserted: 2, updated: 0 });

    // Same payload again -> no inserts, two updates, no duplicate rows.
    const second = await store.upsertEvents([xmas, nvda]);
    expect(second).toEqual({ inserted: 0, updated: 2 });

    const holidays = JSON.parse(await readFile(holidaysPath(root), 'utf8')) as {
      events: CalendarEvent[];
    };
    expect(holidays.events).toHaveLength(1);

    const nvdaFile = JSON.parse(await readFile(earningsPath('NVDA', root), 'utf8')) as {
      events: CalendarEvent[];
    };
    expect(nvdaFile.events).toHaveLength(1);
  });

  it('rejects invalid events (schema validation)', async () => {
    const store = new CalendarStore({ root });
    const bad = {
      // missing required fields like `id`, `kind`, etc.
      title: 'oops',
    } as unknown as CalendarEvent;
    await expect(store.upsertEvents([bad])).rejects.toThrow();
  });

  it('writes the latest.json denormalization for market + per-symbol', async () => {
    const store = new CalendarStore({
      root,
      now: () => new Date('2026-01-10T12:00:00.000Z'),
    });
    await store.upsertEvents([
      holidayEvent({ startUtc: '2026-12-25T00:00:00.000Z', title: 'Christmas' }),
      earningsEvent('AAPL', '2026-04-30T20:30:00.000Z'),
      earningsEvent('NVDA', '2026-02-20T21:00:00.000Z'),
    ]);

    const latest = JSON.parse(await readFile(latestPath(root), 'utf8'));
    expect(latest.market?.title).toBe('Christmas');
    expect(latest.bySymbol.NVDA?.startUtc).toBe('2026-02-20T21:00:00.000Z');
    expect(latest.bySymbol.AAPL?.startUtc).toBe('2026-04-30T20:30:00.000Z');
  });

  it('nextEvent honours symbol scope and kind filter', async () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    const store = new CalendarStore({ root, now: () => now });

    const past = earningsEvent('NVDA', '2025-11-20T21:00:00.000Z');
    const upcoming = earningsEvent('NVDA', '2026-02-20T21:00:00.000Z');
    const farther = earningsEvent('NVDA', '2026-05-22T21:00:00.000Z');
    const aapl = earningsEvent('AAPL', '2026-02-05T20:30:00.000Z');
    const xmas = holidayEvent({ startUtc: '2026-12-25T00:00:00.000Z', title: 'Christmas' });

    await store.upsertEvents([past, upcoming, farther, aapl, xmas]);

    // Per-symbol scope.
    const nextNvda = await store.nextEvent('nvda');
    expect(nextNvda?.startUtc).toBe('2026-02-20T21:00:00.000Z');

    // Market-only scope (null).
    const nextMarket = await store.nextEvent(null);
    expect(nextMarket?.title).toBe('Christmas');

    // Both scopes (undefined): AAPL is the soonest.
    const nextAny = await store.nextEvent();
    expect(nextAny?.symbol).toBe('AAPL');

    // Kind filter: only holidays from the "any" scope.
    const nextHoliday = await store.nextEvent(undefined, { kinds: ['market_holiday'] });
    expect(nextHoliday?.title).toBe('Christmas');

    // Custom fromUtc skips upcoming and returns farther.
    const skip = await store.nextEvent('NVDA', { fromUtc: '2026-03-01T00:00:00.000Z' });
    expect(skip?.startUtc).toBe('2026-05-22T21:00:00.000Z');
  });

  it('eventsBetween is half-open and respects symbol + kinds filter', async () => {
    const store = new CalendarStore({ root });
    const a = earningsEvent('NVDA', '2026-02-20T21:00:00.000Z');
    const b = earningsEvent('NVDA', '2026-05-22T21:00:00.000Z');
    const c = earningsEvent('AAPL', '2026-04-30T20:30:00.000Z');
    const xmas = holidayEvent({ startUtc: '2026-12-25T00:00:00.000Z', title: 'Christmas' });
    await store.upsertEvents([a, b, c, xmas]);

    const allQ1Q2 = await store.eventsBetween(
      '2026-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    );
    expect(allQ1Q2.map((e) => e.id)).toEqual([a.id, c.id, b.id]);

    const nvdaOnly = await store.eventsBetween(
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T00:00:00.000Z',
      { symbol: 'NVDA' },
    );
    expect(nvdaOnly).toHaveLength(2);

    const onlyHolidays = await store.eventsBetween(
      '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      { kinds: ['market_holiday'] },
    );
    expect(onlyHolidays).toHaveLength(1);
    expect(onlyHolidays[0]?.title).toBe('Christmas');

    // Half-open: an event whose start == toUtc is excluded.
    const excludeBoundary = await store.eventsBetween(
      '2026-02-20T21:00:00.000Z',
      '2026-05-22T21:00:00.000Z',
      { symbol: 'NVDA' },
    );
    expect(excludeBoundary.map((e) => e.id)).toEqual([a.id]);
  });

  it('marketStateFor reports closed/early/open and falls back to weekend-closed', async () => {
    const store = new CalendarStore({ root });
    await store.upsertEvents([
      holidayEvent({ startUtc: '2026-12-25T00:00:00.000Z', title: 'Christmas' }),
      earlyCloseEvent('2026-11-27T13:30:00.000Z', '2026-11-27T18:00:00.000Z'),
    ]);

    const closed = await store.marketStateFor('2026-12-25T15:00:00.000Z');
    expect(closed.state).toBe('closed');
    if (closed.state === 'closed') expect(closed.reason).toBe('Christmas');

    const early = await store.marketStateFor('2026-11-27T15:00:00.000Z');
    expect(early.state).toBe('early');
    if (early.state === 'early') expect(early.rthCloseUtc).toBe('2026-11-27T18:00:00.000Z');

    const open = await store.marketStateFor('2026-06-10T15:00:00.000Z'); // Wednesday
    expect(open.state).toBe('open');

    const weekend = await store.marketStateFor('2026-06-13T15:00:00.000Z'); // Saturday
    expect(weekend.state).toBe('closed');
    if (weekend.state === 'closed') expect(weekend.reason).toBe('weekend');

    await expect(store.marketStateFor('not-a-date')).rejects.toThrow();
  });

  it('isStale reports true for never-written and old files', async () => {
    let clock = new Date('2026-01-10T12:00:00.000Z');
    const store = new CalendarStore({
      root,
      staleMs: 1000,
      now: () => clock,
    });

    expect(await store.isStale({ kind: 'holidays' })).toBe(true);
    expect(await store.isStale({ kind: 'earnings', symbol: 'NVDA' })).toBe(true);

    await store.upsertEvents([
      holidayEvent({ startUtc: '2026-12-25T00:00:00.000Z', title: 'Christmas' }),
      earningsEvent('NVDA', '2026-02-20T21:00:00.000Z'),
    ]);

    expect(await store.isStale({ kind: 'holidays' })).toBe(false);
    expect(await store.isStale({ kind: 'earnings', symbol: 'NVDA' })).toBe(false);

    // Advance clock past the staleness window.
    clock = new Date(clock.getTime() + 10_000);
    expect(await store.isStale({ kind: 'holidays' })).toBe(true);
    expect(await store.isStale({ kind: 'earnings', symbol: 'NVDA' })).toBe(true);
  });

  it('writes files with chmod 600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const store = new CalendarStore({ root });
    await store.upsertEvents([
      earningsEvent('NVDA', '2026-02-20T21:00:00.000Z'),
    ]);
    const st = await stat(earningsPath('NVDA', root));
    // Mask to the permission bits only.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('corrupt JSON falls back to an empty file shape instead of throwing', async () => {
    await mkdir(join(root, 'earnings'), { recursive: true });
    await writeFile(earningsPath('XYZ', root), 'not-json{{{', 'utf8');
    const store = new CalendarStore({ root });
    const next = await store.nextEvent('XYZ');
    expect(next).toBeNull();
  });

  it('deterministic event id is stable across re-fetch', () => {
    const sources = [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }];
    const a = makeEventId({
      kind: 'earnings',
      symbol: 'NVDA',
      startUtc: '2026-02-20T21:00:00.000Z',
      sources,
    });
    const b = makeEventId({
      kind: 'earnings',
      symbol: 'NVDA',
      startUtc: '2026-02-20T21:00:00.000Z',
      sources: [...sources],
    });
    expect(a).toBe(b);

    const c = makeEventId({
      kind: 'earnings',
      symbol: 'NVDA',
      startUtc: '2026-02-21T21:00:00.000Z',
      sources,
    });
    expect(a).not.toBe(c);
  });
});
