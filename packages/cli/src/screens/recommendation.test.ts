import { describe, expect, it } from 'vitest';
import {
  buildRecommendationHistoryPath,
  buildRecommendationLatestPath,
  buildRecommendationRecomputePath,
  parseRecommendationArgs,
} from './recommendation.js';

describe('recommendation helpers', () => {
  it('builds latest + recompute paths with upper-cased symbols', () => {
    expect(buildRecommendationLatestPath('nvda')).toBe('/recommendations/NVDA/latest');
    expect(buildRecommendationRecomputePath('msft')).toBe('/recommendations/MSFT/recompute');
  });

  it('builds history path using since/until for the requested day window', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    const path = buildRecommendationHistoryPath('aapl', 30, now);
    expect(path).toContain('/recommendations/AAPL?');
    expect(path).toContain('since=2026-07-07T12%3A00%3A00.000Z');
    expect(path).toContain('until=2026-08-06T12%3A00%3A00.000Z');
  });

  it('parses latest command with recompute option', () => {
    expect(parseRecommendationArgs(['nvda', '--recompute'])).toEqual({
      kind: 'latest',
      symbol: 'NVDA',
      recompute: true,
    });
  });

  it('parses history command and honors --days flag from args', () => {
    expect(parseRecommendationArgs(['nvda', 'history', '--days=14'])).toEqual({
      kind: 'history',
      symbol: 'NVDA',
      days: 14,
    });
  });

  it('falls back to injected days flag for history when no inline --days is present', () => {
    expect(parseRecommendationArgs(['nvda', 'history'], { daysFlag: 21 })).toEqual({
      kind: 'history',
      symbol: 'NVDA',
      days: 21,
    });
  });

  it('parses watch mode with optional symbol filters', () => {
    expect(parseRecommendationArgs(['watch'])).toEqual({ kind: 'watch', symbols: [] });
    expect(parseRecommendationArgs(['watch', 'nvda', 'tsla'])).toEqual({
      kind: 'watch',
      symbols: ['NVDA', 'TSLA'],
    });
  });

  it('returns helpful errors for invalid forms', () => {
    const missing = parseRecommendationArgs([]);
    expect(missing.kind).toBe('error');

    const badDays = parseRecommendationArgs(['nvda', 'history', '--days=0']);
    expect(badDays.kind).toBe('error');

    const badSub = parseRecommendationArgs(['nvda', 'foobar']);
    expect(badSub.kind).toBe('error');
  });
});
