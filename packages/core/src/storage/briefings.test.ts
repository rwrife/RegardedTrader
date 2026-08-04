import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { BriefingStore, looksLikeBriefingId } from './briefings.js';
import type { Briefing } from '../schemas/index.js';

let root = '';

function sampleBriefing(asOf: string): Briefing {
  return {
    symbol: 'NVDA',
    asOf,
    quote: {
      symbol: 'NVDA',
      price: 123,
      change: 1,
      changePercent: 0.81,
      volume: 1000,
      asOf,
    },
    indicators: {
      rsi14: 50,
      sma20: 120,
      sma50: 115,
      ema12: 121,
      ema26: 118,
      macd: 3,
      macdSignal: 2,
      atr14: 4,
    },
    bullCase: 'Bull case.',
    bearCase: 'Bear case.',
    catalysts: ['earnings'],
    risks: ['macro'],
    news: [],
    disclaimer: 'Not financial advice.',
    sourcesUsed: [],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rt-briefings-'));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('BriefingStore', () => {
  it('writes, lists, and reads a persisted briefing by id', async () => {
    const store = new BriefingStore({ root });
    const first = await store.saveBriefing(sampleBriefing('2026-08-03T12:00:00.000Z'));
    await store.saveBriefing(sampleBriefing('2026-08-03T13:00:00.000Z'));

    expect(looksLikeBriefingId(first.id)).toBe(true);

    const list = await store.listBriefings('nvda', 20);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toContain('NVDA__2026-08-03T13-00-00.000Z');

    const read = await store.getBriefing(first.id);
    expect(read?.briefing.symbol).toBe('NVDA');
    expect(read?.briefing.asOf).toBe('2026-08-03T12:00:00.000Z');
  });

  it('returns null for unknown ids', async () => {
    const store = new BriefingStore({ root });
    expect(await store.getBriefing('NVDA__missing')).toBeNull();
    expect(await store.getBriefing('not-an-id')).toBeNull();
  });

  it('applies chmod 600 best-effort on persisted files', async () => {
    const store = new BriefingStore({ root });
    const saved = await store.saveBriefing(sampleBriefing('2026-08-03T14:00:00.000Z'));
    const s = await stat(saved.path);
    // Windows doesn't enforce POSIX mode bits; Unix does.
    if (process.platform !== 'win32') {
      expect(s.mode & 0o777).toBe(0o600);
    }
  });
});
