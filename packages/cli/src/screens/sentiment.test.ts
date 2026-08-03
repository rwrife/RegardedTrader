import { describe, expect, it } from 'vitest';
import {
  buildMentionsPath,
  buildSentimentHistoryPath,
  buildSentimentLatestPath,
  pickLatestSnapshot,
  windowSinceIso,
} from './sentiment.js';

describe('sentiment helpers', () => {
  it('builds latest sentiment path with an upper-cased symbol', () => {
    expect(buildSentimentLatestPath('nvda')).toBe('/sentiment/NVDA/latest');
  });

  it('builds history path with a since filter when a window is provided', () => {
    const now = new Date('2026-08-03T12:00:00.000Z');
    const path = buildSentimentHistoryPath('aapl', '30m', now);
    expect(path).toBe('/sentiment/AAPL?since=2026-08-03T11%3A30%3A00.000Z');
  });

  it('returns null when window format is invalid', () => {
    const now = new Date('2026-08-03T12:00:00.000Z');
    expect(windowSinceIso('45', now)).toBeNull();
    expect(windowSinceIso('1w', now)).toBeNull();
  });

  it('picks the most recent snapshot from history', () => {
    const latest = pickLatestSnapshot([
      { asOf: '2026-08-03T11:00:00.000Z', score: 0.1, confidence: 0.5, volume: 1, symbol: 'NVDA', bySource: {} },
      { asOf: '2026-08-03T11:30:00.000Z', score: 0.2, confidence: 0.6, volume: 2, symbol: 'NVDA', bySource: {} },
    ]);
    expect(latest?.asOf).toBe('2026-08-03T11:30:00.000Z');
  });

  it('builds mentions path with source + limit filters', () => {
    expect(buildMentionsPath('tsla', 'reddit', 50)).toBe('/mentions/TSLA?source=reddit&limit=50');
  });
});
