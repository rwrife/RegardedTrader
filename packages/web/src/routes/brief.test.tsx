import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Brief, buildBriefRequest } from './brief.js';
import type { Briefing } from '@regardedtrader/core';

describe('buildBriefRequest (web)', () => {
  it('uses GET when no strategist inputs are provided', () => {
    const r = buildBriefRequest({ symbol: 'nvda' });
    expect(r.url).toBe('/api/briefing/NVDA');
    expect(r.init.method).toBe('GET');
    expect(r.usesStrategist).toBe(false);
    expect(r.init.body).toBeUndefined();
  });

  it('keeps GET when only thesis is provided', () => {
    const r = buildBriefRequest({ symbol: 'AAPL', thesis: 'bull' });
    expect(r.init.method).toBe('GET');
    expect(r.usesStrategist).toBe(false);
  });

  it('keeps GET when only maxLossUsd is provided', () => {
    const r = buildBriefRequest({ symbol: 'AAPL', maxLossUsd: 500 });
    expect(r.init.method).toBe('GET');
  });

  it('switches to POST with body when thesis + maxLossUsd are present', () => {
    const r = buildBriefRequest({
      symbol: 'tsla',
      thesis: 'mean revert',
      maxLossUsd: 250,
      expiry: '2026-07-17',
    });
    expect(r.url).toBe('/api/briefing/TSLA');
    expect(r.init.method).toBe('POST');
    expect(r.usesStrategist).toBe(true);
    expect(JSON.parse(String(r.init.body))).toEqual({
      thesis: 'mean revert',
      maxLossUsd: 250,
      expiry: '2026-07-17',
    });
    const headers = r.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('drops non-finite maxLossUsd', () => {
    const r = buildBriefRequest({
      symbol: 'NVDA',
      thesis: 'x',
      maxLossUsd: Number.POSITIVE_INFINITY,
    });
    expect(r.init.method).toBe('GET');
  });

  it('honors apiBase override', () => {
    const r = buildBriefRequest({ symbol: 'msft', apiBase: 'http://127.0.0.1:4317' });
    expect(r.url).toBe('http://127.0.0.1:4317/briefing/MSFT');
  });
});

const FIXTURE: Briefing = {
  symbol: 'NVDA',
  asOf: '2026-06-16T00:00:00.000Z',
  quote: {
    symbol: 'NVDA',
    price: 123.45,
    change: 1.5,
    changePercent: 1.23,
    volume: 1000,
    asOf: '2026-06-16T00:00:00.000Z',
  },
  indicators: {
    rsi14: 55,
    sma20: 120,
    sma50: 118,
    ema12: null,
    ema26: null,
    macd: null,
    macdSignal: null,
    atr14: null,
  },
  bullCase: 'fixture bull',
  bearCase: 'fixture bear',
  catalysts: ['cat1'],
  risks: ['risk1'],
  news: [
    {
      title: 'Headline 1',
      url: 'https://example.com',
      source: 'ex',
      publishedAt: '2026-06-15T00:00:00.000Z',
    },
  ],
  disclaimer: 'Not financial advice.',
  sourcesUsed: [],
};

describe('<Brief /> route', () => {
  afterEach(() => cleanup());

  it('renders an analyst-only briefing via GET on mount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<Brief symbol="nvda" fetchImpl={fetchMock as unknown as typeof fetch} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/briefing/NVDA');
    expect((init as RequestInit).method).toBe('GET');

    expect(await screen.findByText('fixture bull')).toBeTruthy();
    expect(screen.getByText('fixture bear')).toBeTruthy();
    expect(screen.getByText('Headline 1')).toBeTruthy();
  });

  it('submits a POST briefing with strategist inputs when both fields are filled', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<Brief symbol="NVDA" fetchImpl={fetchMock as unknown as typeof fetch} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.type(screen.getByPlaceholderText(/mean-revert/i), 'play the bounce');
    await user.type(screen.getByPlaceholderText(/e\.g\. 500/i), '500');
    await user.click(screen.getByRole('button', { name: /run pipeline/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/briefing/NVDA');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      thesis: 'play the bounce',
      maxLossUsd: 500,
    });
  });

  it('shows the server error message on non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'AI provider not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<Brief symbol="NVDA" fetchImpl={fetchMock as unknown as typeof fetch} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/AI provider not configured/);
  });
});
