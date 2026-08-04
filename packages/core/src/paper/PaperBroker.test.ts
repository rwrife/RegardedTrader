import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketDataClient, TradePlan } from '../index.js';
import { PaperBroker } from './PaperBroker.js';
import { PaperStore } from './store.js';

const samplePlan: TradePlan = {
  name: 'Bull call spread',
  thesis: 'Upside continuation with defined risk.',
  legs: [
    {
      action: 'buy',
      qty: 1,
      contract: {
        symbol: 'NVDA260918C00125000',
        underlying: 'NVDA',
        expiry: '2026-09-18',
        strike: 125,
        type: 'call',
        bid: 5,
        ask: 5.4,
        last: 5.2,
        volume: 100,
        openInterest: 500,
        iv: 0.42,
      },
    },
    {
      action: 'sell',
      qty: 1,
      contract: {
        symbol: 'NVDA260918C00135000',
        underlying: 'NVDA',
        expiry: '2026-09-18',
        strike: 135,
        type: 'call',
        bid: 2.1,
        ask: 2.5,
        last: 2.2,
        volume: 80,
        openInterest: 350,
        iv: 0.4,
      },
    },
  ],
  maxLoss: 280,
  maxGain: 720,
  breakEvens: [127.8],
};

function fakeMarket(): MarketDataClient {
  return {
    quote: async () => ({
      symbol: 'NVDA',
      price: 130,
      change: 0,
      changePercent: 0,
      volume: 1_000,
      asOf: '2026-08-03T00:00:00.000Z',
    }),
    history: async () => [],
    news: async () => [],
    optionsChain: async () => [],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-paper-'));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('PaperBroker', () => {
  it('refuses orders unless mode=paper', async () => {
    const store = new PaperStore({ homeDir: dir });
    const broker = new PaperBroker({ market: fakeMarket(), store });
    await expect(
      broker.submit({
        mode: 'live',
        planId: 'plan-live-1',
        plan: samplePlan,
      }),
    ).rejects.toThrow(/paper mode/i);
  });

  it('computes a mid-price net premium and persists order + position', async () => {
    const store = new PaperStore({ homeDir: dir });
    const broker = new PaperBroker({ market: fakeMarket(), store });
    const fill = await broker.submit({
      mode: 'paper',
      planId: 'plan-paper-1',
      plan: samplePlan,
    });

    expect(fill.planId).toBe('plan-paper-1');
    expect(fill.symbol).toBe('NVDA');
    expect(fill.underlyingPrice).toBe(130);
    // debit: buy mid 5.2, credit: sell mid 2.3 => net 2.9 * 100 = 290
    expect(fill.netPremiumUsd).toBeCloseTo(290, 6);

    const orders = await store.listOrders();
    const positions = await store.listPositions();
    expect(orders).toHaveLength(1);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.planId).toBe('plan-paper-1');
  });

  it('writes JSON orders/positions files that round-trip', async () => {
    const store = new PaperStore({ homeDir: dir });
    const broker = new PaperBroker({ market: fakeMarket(), store });
    await broker.submit({ mode: 'paper', planId: 'plan-paper-2', plan: samplePlan });

    const ordersRaw = await readFile(join(dir, 'paper', 'orders.json'), 'utf8');
    const positionsRaw = await readFile(join(dir, 'paper', 'positions.json'), 'utf8');
    expect(JSON.parse(ordersRaw)).toMatchObject({ version: 1 });
    expect(JSON.parse(positionsRaw)).toMatchObject({ version: 1 });
  });
});

