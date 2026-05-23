import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../store.js';
import {
  pollQuote,
  QuotePoller,
  QuoteSnapshot,
  type QuoteHistoryFetcher,
  type QuoteSource,
  type QuoteUpdateEvent,
} from './quote.js';
import type { OHLCV, Quote } from '../../schemas/index.js';

function mkQuote(symbol: string, price: number): Quote {
  return {
    symbol,
    price,
    change: 1.23,
    changePercent: 0.45,
    volume: 1_000_000,
    marketCap: 1_000_000_000,
    asOf: new Date('2026-05-23T13:30:00Z').toISOString(),
  };
}

function mkBars(n: number, start = 100): OHLCV[] {
  const out: OHLCV[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + Math.sin(i / 3) * 5 + i * 0.1;
    out.push({
      t: new Date(Date.UTC(2026, 0, 1) + i * 86400000)
        .toISOString()
        .slice(0, 10),
      o: c - 0.5,
      h: c + 1,
      l: c - 1,
      c,
      v: 1_000_000 + i,
    });
  }
  return out;
}

class FakeSource implements QuoteSource {
  calls = 0;
  errorOn: 'never' | 'always' = 'never';
  constructor(
    public name: string,
    private quotes: Map<string, Quote>,
  ) {}
  async quote(symbol: string): Promise<Quote> {
    this.calls += 1;
    if (this.errorOn === 'always') {
      throw new Error(`${this.name} boom`);
    }
    const q = this.quotes.get(symbol.toUpperCase());
    if (!q) throw new Error(`${this.name}: no quote for ${symbol}`);
    return q;
  }
}

class FakeHistory implements QuoteHistoryFetcher {
  calls = 0;
  failures = 0;
  fail = false;
  constructor(private bars: OHLCV[]) {}
  async history(_symbol: string, _days: number): Promise<OHLCV[]> {
    this.calls += 1;
    if (this.fail) {
      this.failures += 1;
      throw new Error('history boom');
    }
    return this.bars;
  }
}

describe('pollQuote', () => {
  let dir: string;
  let store: SnapshotStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rt-quote-'));
    store = new SnapshotStore({ root: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists a snapshot, emits quote.update, and computes indicators', async () => {
    const yahoo = new FakeSource('yahoo', new Map([['NVDA', mkQuote('NVDA', 120)]]));
    const hist = new FakeHistory(mkBars(80));
    const events: QuoteUpdateEvent[] = [];
    const res = await pollQuote({
      symbol: 'nvda',
      store,
      sources: [yahoo],
      historyFetcher: hist,
      onEvent: (e) => events.push(e),
      now: () => new Date('2026-05-23T13:30:01Z'),
    });

    expect(res.ok).toBe(true);
    expect(res.source).toBe('yahoo');
    expect(res.indicatorsComputed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.symbol).toBe('NVDA');
    expect(events[0]?.indicators?.sma20).not.toBeNull();

    const latest = await store.readLatest('NVDA');
    const entry = latest.entries['quote'];
    expect(entry).toBeDefined();
    const parsed = QuoteSnapshot.parse(entry!.data);
    expect(parsed.quote.symbol).toBe('NVDA');
    expect(parsed.source).toBe('yahoo');
    expect(parsed.indicators?.rsi14).not.toBeNull();
  });

  it('falls through to the next source when the first throws', async () => {
    const yahoo = new FakeSource('yahoo', new Map());
    yahoo.errorOn = 'always';
    const cnbc = new FakeSource('cnbc', new Map([['NVDA', mkQuote('NVDA', 120)]]));
    const errors: string[] = [];

    const res = await pollQuote({
      symbol: 'NVDA',
      store,
      sources: [yahoo, cnbc],
      onError: (src) => errors.push(src),
    });

    expect(res.source).toBe('cnbc');
    expect(yahoo.calls).toBe(1);
    expect(cnbc.calls).toBe(1);
    expect(errors).toEqual(['yahoo']);
    expect(res.attempts.map((a) => a.source)).toEqual(['yahoo', 'cnbc']);
    expect(res.attempts[0]?.ok).toBe(false);
    expect(res.attempts[1]?.ok).toBe(true);
  });

  it('throws when every source fails', async () => {
    const a = new FakeSource('yahoo', new Map());
    a.errorOn = 'always';
    const b = new FakeSource('cnbc', new Map());
    b.errorOn = 'always';
    await expect(
      pollQuote({ symbol: 'NVDA', store, sources: [a, b] }),
    ).rejects.toThrow(/all sources failed/);
  });

  it('still persists a snapshot when history fetcher throws', async () => {
    const yahoo = new FakeSource('yahoo', new Map([['NVDA', mkQuote('NVDA', 120)]]));
    const hist = new FakeHistory([]);
    hist.fail = true;
    const errors: string[] = [];
    const res = await pollQuote({
      symbol: 'NVDA',
      store,
      sources: [yahoo],
      historyFetcher: hist,
      onError: (s) => errors.push(s),
    });
    expect(res.ok).toBe(true);
    expect(res.indicatorsComputed).toBe(false);
    expect(errors).toEqual(['history']);
    const latest = await store.readLatest('NVDA');
    const parsed = QuoteSnapshot.parse(latest.entries['quote']!.data);
    expect(parsed.indicators).toBeNull();
  });

  it('rejects when no sources are supplied', async () => {
    await expect(
      pollQuote({ symbol: 'NVDA', store, sources: [] }),
    ).rejects.toThrow(/at least one QuoteSource/);
  });
});

describe('QuotePoller', () => {
  let dir: string;
  let store: SnapshotStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rt-quote-p-'));
    store = new SnapshotStore({ root: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('single-flights concurrent polls per symbol', async () => {
    const yahoo = new FakeSource('yahoo', new Map([['NVDA', mkQuote('NVDA', 120)]]));
    // Patch quote() with a deferred resolver so we can observe concurrency.
    let resolveFn: (() => void) | null = null;
    const deferred = new Promise<void>((r) => {
      resolveFn = r;
    });
    const original = yahoo.quote.bind(yahoo);
    yahoo.quote = vi.fn(async (s: string) => {
      await deferred;
      return original(s);
    });

    const poller = new QuotePoller({ store, sources: [yahoo] });
    const p1 = poller.pollSymbol('NVDA');
    const p2 = poller.pollSymbol('NVDA');
    expect(p1).toBe(p2);
    (resolveFn as unknown as () => void)();
    await Promise.all([p1, p2]);
    expect(yahoo.quote).toHaveBeenCalledTimes(1);
  });

  it('marks a symbol unhealthy after 3 consecutive failures and skips further polls', async () => {
    const yahoo = new FakeSource('yahoo', new Map());
    yahoo.errorOn = 'always';
    const poller = new QuotePoller({ store, sources: [yahoo] });

    for (let i = 0; i < 3; i++) {
      const r = await poller.pollSymbol('NVDA');
      expect(r.skipped).toBe(false);
      expect(r.error).not.toBeNull();
      expect(r.health.consecutiveFailures).toBe(i + 1);
    }
    const h = poller.healthOf('NVDA');
    expect(h.status).toBe('unhealthy');
    expect(h.lastError).toMatch(/all sources failed/);

    const skipped = await poller.pollSymbol('NVDA');
    expect(skipped.skipped).toBe(true);
    expect(yahoo.calls).toBe(3); // 4th call short-circuited
  });

  it('clears consecutive failures on success', async () => {
    const yahoo = new FakeSource('yahoo', new Map([['NVDA', mkQuote('NVDA', 120)]]));
    yahoo.errorOn = 'always';
    const poller = new QuotePoller({
      store,
      sources: [yahoo],
      unhealthyThreshold: 5,
    });

    await poller.pollSymbol('NVDA');
    await poller.pollSymbol('NVDA');
    expect(poller.healthOf('NVDA').consecutiveFailures).toBe(2);

    yahoo.errorOn = 'never';
    const ok = await poller.pollSymbol('NVDA');
    expect(ok.error).toBeNull();
    expect(ok.result?.ok).toBe(true);
    const h = poller.healthOf('NVDA');
    expect(h.status).toBe('healthy');
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastError).toBeNull();
    expect(h.lastSuccessAt).not.toBeNull();
  });

  it('resetHealth clears the unhealthy flag', async () => {
    const yahoo = new FakeSource('yahoo', new Map());
    yahoo.errorOn = 'always';
    const poller = new QuotePoller({ store, sources: [yahoo] });
    for (let i = 0; i < 3; i++) await poller.pollSymbol('NVDA');
    expect(poller.healthOf('NVDA').status).toBe('unhealthy');
    poller.resetHealth('NVDA');
    expect(poller.healthOf('NVDA').status).toBe('healthy');
  });

  it('health() returns sorted snapshots for all tracked symbols', async () => {
    const yahoo = new FakeSource(
      'yahoo',
      new Map([
        ['NVDA', mkQuote('NVDA', 1)],
        ['AAPL', mkQuote('AAPL', 1)],
      ]),
    );
    const poller = new QuotePoller({ store, sources: [yahoo] });
    await poller.pollSymbol('NVDA');
    await poller.pollSymbol('AAPL');
    const h = poller.health();
    expect(h.map((x) => x.symbol)).toEqual(['AAPL', 'NVDA']);
    expect(h.every((x) => x.status === 'healthy')).toBe(true);
  });
});
