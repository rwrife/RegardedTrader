import { describe, expect, it } from 'vitest';
import { buildBriefRequest } from './brief.js';

describe('buildBriefRequest', () => {
  it('uses GET when no strategist inputs are provided', () => {
    const r = buildBriefRequest({ symbol: 'nvda' });
    expect(r.path).toBe('/briefing/NVDA');
    expect(r.init.method).toBe('GET');
    expect(r.usesStrategist).toBe(false);
    expect(r.init.body).toBeUndefined();
  });

  it('keeps GET when only thesis is provided (missing budget)', () => {
    const r = buildBriefRequest({ symbol: 'AAPL', thesis: 'bullish on services' });
    expect(r.init.method).toBe('GET');
    expect(r.usesStrategist).toBe(false);
  });

  it('keeps GET when only maxLossUsd is provided (missing thesis)', () => {
    const r = buildBriefRequest({ symbol: 'AAPL', maxLossUsd: 500 });
    expect(r.init.method).toBe('GET');
    expect(r.usesStrategist).toBe(false);
  });

  it('switches to POST with body when thesis + maxLossUsd are present', () => {
    const r = buildBriefRequest({
      symbol: 'tsla',
      thesis: 'mean revert',
      maxLossUsd: 250,
      expiry: '2026-07-17',
    });
    expect(r.path).toBe('/briefing/TSLA');
    expect(r.init.method).toBe('POST');
    expect(r.usesStrategist).toBe(true);
    const parsed = JSON.parse(String(r.init.body));
    expect(parsed).toEqual({
      thesis: 'mean revert',
      maxLossUsd: 250,
      expiry: '2026-07-17',
    });
  });

  it('drops non-finite maxLossUsd (NaN/Infinity)', () => {
    const r = buildBriefRequest({
      symbol: 'NVDA',
      thesis: 'x',
      maxLossUsd: Number.NaN,
    });
    expect(r.init.method).toBe('GET');
    expect(r.usesStrategist).toBe(false);
  });

  it('upper-cases symbol in the URL', () => {
    const r = buildBriefRequest({ symbol: 'msft' });
    expect(r.path).toBe('/briefing/MSFT');
  });
});
