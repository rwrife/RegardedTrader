import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../store.js';
import {
  pollOptions,
  computeChainMetrics,
  OptionsChainSnapshot,
  type OptionsChainFetch,
  type OptionsChainFetcher,
  type OptionsUpdateEvent,
} from './options.js';
import type { OptionContract } from '../../schemas/index.js';

function call(
  strike: number,
  iv: number | null,
  vol = 0,
  oi = 0,
  delta?: number,
): OptionContract {
  return {
    symbol: `NVDA260619C${String(strike).padStart(8, '0')}`,
    underlying: 'NVDA',
    expiry: '2026-06-19',
    strike,
    type: 'call',
    bid: null,
    ask: null,
    last: null,
    volume: vol,
    openInterest: oi,
    iv,
    ...(delta !== undefined ? { delta } : {}),
  };
}

function put(
  strike: number,
  iv: number | null,
  vol = 0,
  oi = 0,
  delta?: number,
): OptionContract {
  return {
    symbol: `NVDA260619P${String(strike).padStart(8, '0')}`,
    underlying: 'NVDA',
    expiry: '2026-06-19',
    strike,
    type: 'put',
    bid: null,
    ask: null,
    last: null,
    volume: vol,
    openInterest: oi,
    iv,
    ...(delta !== undefined ? { delta } : {}),
  };
}

class FakeFetcher implements OptionsChainFetcher {
  expirationsList: Date[];
  chains: Map<string, OptionsChainFetch>;
  expirationCalls = 0;
  chainCalls: Date[] = [];
  expirationsError: Error | null = null;
  chainErrors: Map<string, Error> = new Map();
  constructor(expirations: Date[], chains: Map<string, OptionsChainFetch>) {
    this.expirationsList = expirations;
    this.chains = chains;
  }
  async expirations(): Promise<readonly Date[]> {
    this.expirationCalls += 1;
    if (this.expirationsError) throw this.expirationsError;
    return this.expirationsList;
  }
  async chain(_symbol: string, expiry: Date): Promise<OptionsChainFetch> {
    this.chainCalls.push(expiry);
    const key = expiry.toISOString().slice(0, 10);
    const err = this.chainErrors.get(key);
    if (err) throw err;
    const c = this.chains.get(key);
    if (!c) return { contracts: [], underlyingPrice: null };
    return c;
  }
}

describe('computeChainMetrics', () => {
  it('aggregates OI, volume, P/C ratio and ATM IV', () => {
    const contracts = [
      call(100, 0.5, 10, 100),
      call(110, 0.45, 20, 200),
      put(100, 0.55, 30, 150),
      put(90, 0.6, 40, 250),
    ];
    const m = computeChainMetrics('nvda', '2026-06-19', contracts, 100);
    expect(m.symbol).toBe('NVDA');
    expect(m.openInterest).toEqual({ call: 300, put: 400, total: 700 });
    expect(m.volume).toEqual({ call: 30, put: 70, total: 100 });
    expect(m.putCallRatio).toBeCloseTo(70 / 30);
    // ATM = avg of nearest-strike call IV (0.5) and put IV (0.55).
    expect(m.atmIv).toBeCloseTo(0.525);
    expect(m.contractCount).toBe(4);
  });

  it('returns null P/C ratio when call volume is zero', () => {
    const m = computeChainMetrics(
      'NVDA',
      '2026-06-19',
      [put(100, 0.5, 10, 0)],
      100,
    );
    expect(m.putCallRatio).toBeNull();
  });

  it('returns null ATM IV when underlying price is unknown', () => {
    const m = computeChainMetrics(
      'NVDA',
      '2026-06-19',
      [call(100, 0.5, 0, 0), put(100, 0.5, 0, 0)],
      null,
    );
    expect(m.atmIv).toBeNull();
  });

  it('computes 25Δ IV skew from contract deltas when available', () => {
    const contracts = [
      call(110, 0.4, 0, 0, 0.26), // closest to 25Δ call
      call(120, 0.35, 0, 0, 0.15),
      put(90, 0.5, 0, 0, -0.24), // closest to 25Δ put
      put(80, 0.55, 0, 0, -0.1),
    ];
    const m = computeChainMetrics('NVDA', '2026-06-19', contracts, 100);
    expect(m.ivSkew25d).toBeCloseTo(0.5 - 0.4);
  });

  it('falls back to a ±10% strike proxy when deltas are absent', () => {
    const contracts = [
      call(110, 0.4, 0, 0),
      put(90, 0.5, 0, 0),
      call(100, 0.45, 0, 0),
      put(100, 0.45, 0, 0),
    ];
    const m = computeChainMetrics('NVDA', '2026-06-19', contracts, 100);
    expect(m.ivSkew25d).toBeCloseTo(0.1);
  });

  it('skips contracts without IVs when picking ATM and skew anchors', () => {
    const contracts = [
      call(100, null, 0, 0),
      call(101, 0.5, 0, 0),
      put(100, null, 0, 0),
      put(99, 0.6, 0, 0),
    ];
    const m = computeChainMetrics('NVDA', '2026-06-19', contracts, 100);
    expect(m.atmIv).toBeCloseTo(0.55);
  });
});

describe('pollOptions', () => {
  let dir: string;
  let store: SnapshotStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rt-opts-'));
    store = new SnapshotStore({ root: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists one snapshot per expiry and emits options.update', async () => {
    const exps = [
      new Date(Date.UTC(2026, 5, 19)),
      new Date(Date.UTC(2026, 5, 26)),
      new Date(Date.UTC(2026, 6, 17)),
      new Date(Date.UTC(2026, 7, 21)),
    ];
    const chains = new Map<string, OptionsChainFetch>([
      [
        '2026-06-19',
        {
          contracts: [call(100, 0.5, 10, 100), put(100, 0.55, 20, 200)],
          underlyingPrice: 100,
        },
      ],
      [
        '2026-06-26',
        {
          contracts: [call(100, 0.48, 5, 50), put(100, 0.52, 15, 75)],
          underlyingPrice: 100,
        },
      ],
      [
        '2026-07-17',
        {
          contracts: [call(100, 0.46, 3, 25), put(100, 0.49, 7, 30)],
          underlyingPrice: 100,
        },
      ],
    ]);
    const fetcher = new FakeFetcher(exps, chains);
    const events: OptionsUpdateEvent[] = [];

    const res = await pollOptions({
      symbol: 'nvda',
      store,
      fetcher,
      onEvent: (e) => events.push(e),
      now: () => new Date('2026-05-22T12:00:00Z'),
    });

    expect(fetcher.expirationCalls).toBe(1);
    expect(fetcher.chainCalls.length).toBe(3); // default 3 chains
    expect(res.inserted).toBe(3);
    expect(res.fetched).toBe(6);
    expect(Object.keys(res.byExpiry).sort()).toEqual([
      '2026-06-19',
      '2026-06-26',
      '2026-07-17',
    ]);
    expect(events.map((e) => e.expiry).sort()).toEqual([
      '2026-06-19',
      '2026-06-26',
      '2026-07-17',
    ]);
    for (const e of events) {
      expect(e.type).toBe('options.update');
      expect(e.symbol).toBe('NVDA');
      expect(e.metrics.contractCount).toBe(2);
    }

    const latest = await store.readLatest('NVDA');
    expect(latest.entries.options).toBeDefined();
    const data = OptionsChainSnapshot.parse(latest.entries.options!.data);
    // latest reflects the most recently written entry — the last expiry.
    expect(data.metrics.expiry).toBe('2026-07-17');
  });

  it('respects the chains option', async () => {
    const exps = [
      new Date(Date.UTC(2026, 5, 19)),
      new Date(Date.UTC(2026, 5, 26)),
      new Date(Date.UTC(2026, 6, 17)),
    ];
    const chains = new Map<string, OptionsChainFetch>([
      ['2026-06-19', { contracts: [call(100, 0.5)], underlyingPrice: 100 }],
      ['2026-06-26', { contracts: [call(100, 0.5)], underlyingPrice: 100 }],
      ['2026-07-17', { contracts: [call(100, 0.5)], underlyingPrice: 100 }],
    ]);
    const fetcher = new FakeFetcher(exps, chains);
    const res = await pollOptions({
      symbol: 'NVDA',
      store,
      fetcher,
      chains: 1,
    });
    expect(fetcher.chainCalls.length).toBe(1);
    expect(res.inserted).toBe(1);
  });

  it('routes expirations() failures through onError and returns empty', async () => {
    const fetcher = new FakeFetcher([], new Map());
    fetcher.expirationsError = new Error('upstream down');
    const errors: Array<{ expiry: string | null; msg: string }> = [];

    const res = await pollOptions({
      symbol: 'NVDA',
      store,
      fetcher,
      onError: (expiry, e) => errors.push({ expiry, msg: (e as Error).message }),
    });

    expect(res).toEqual({ fetched: 0, inserted: 0, byExpiry: {} });
    expect(errors).toEqual([{ expiry: null, msg: 'upstream down' }]);
  });

  it('keeps going when a single expiry fetch fails', async () => {
    const exps = [
      new Date(Date.UTC(2026, 5, 19)),
      new Date(Date.UTC(2026, 5, 26)),
      new Date(Date.UTC(2026, 6, 17)),
    ];
    const chains = new Map<string, OptionsChainFetch>([
      ['2026-06-19', { contracts: [call(100, 0.5)], underlyingPrice: 100 }],
      ['2026-07-17', { contracts: [call(100, 0.5)], underlyingPrice: 100 }],
    ]);
    const fetcher = new FakeFetcher(exps, chains);
    fetcher.chainErrors.set('2026-06-26', new Error('429'));
    const errors: Array<{ expiry: string | null; msg: string }> = [];

    const res = await pollOptions({
      symbol: 'NVDA',
      store,
      fetcher,
      onError: (expiry, e) => errors.push({ expiry, msg: (e as Error).message }),
    });
    expect(res.inserted).toBe(2);
    expect(res.byExpiry['2026-06-26']!.error).toBe('429');
    expect(errors).toEqual([{ expiry: '2026-06-26', msg: '429' }]);
  });

  it('drops malformed contracts at the schema boundary', async () => {
    const exps = [new Date(Date.UTC(2026, 5, 19))];
    const bad = { ...call(100, 0.5), strike: 'oops' } as unknown as OptionContract;
    const chains = new Map<string, OptionsChainFetch>([
      [
        '2026-06-19',
        { contracts: [bad, call(100, 0.5, 1, 1)], underlyingPrice: 100 },
      ],
    ]);
    const fetcher = new FakeFetcher(exps, chains);
    const res = await pollOptions({ symbol: 'NVDA', store, fetcher });
    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);
    expect(res.byExpiry['2026-06-19']!.fetched).toBe(1);
  });

  it('returns early when chains is 0', async () => {
    const fetcher = new FakeFetcher(
      [new Date(Date.UTC(2026, 5, 19))],
      new Map(),
    );
    const res = await pollOptions({
      symbol: 'NVDA',
      store,
      fetcher,
      chains: 0,
    });
    expect(res).toEqual({ fetched: 0, inserted: 0, byExpiry: {} });
    expect(fetcher.expirationCalls).toBe(0);
  });

  it('uses spied store.appendSnapshot with kind="options"', async () => {
    const exps = [new Date(Date.UTC(2026, 5, 19))];
    const chains = new Map<string, OptionsChainFetch>([
      ['2026-06-19', { contracts: [call(100, 0.5)], underlyingPrice: 100 }],
    ]);
    const fetcher = new FakeFetcher(exps, chains);
    const spy = vi.spyOn(store, 'appendSnapshot');
    await pollOptions({ symbol: 'NVDA', store, fetcher });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![1]).toBe('options');
  });
});
