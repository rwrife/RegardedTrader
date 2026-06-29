import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { WatchlistEntry } from '@regardedtrader/core/schemas';
import { Watchlist, buildWatchlistUrls, buildEarningsLookup } from './watchlist.js';

afterEach(() => {
  cleanup();
});

function entry(over: Partial<WatchlistEntry['profile']> = {}): WatchlistEntry {
  return {
    profile: {
      symbol: 'NVDA',
      name: 'NVIDIA Corp',
      exchange: 'NASDAQ',
      sector: 'Technology',
      industry: 'Semiconductors',
      description: 'GPUs and AI accelerators.',
      sources: ['https://example.com/nvda'],
      validatedAt: '2026-06-01T00:00:00Z',
      ...over,
    },
    addedAt: '2026-06-01T00:00:00Z',
  };
}

describe('buildWatchlistUrls', () => {
  it('defaults to the /api prefix', () => {
    const u = buildWatchlistUrls();
    expect(u.list).toBe('/api/tickers');
    expect(u.validate).toBe('/api/tickers/validate');
    expect(u.remove('nvda')).toBe('/api/tickers/NVDA');
  });

  it('honors an apiBase override', () => {
    const u = buildWatchlistUrls('http://127.0.0.1:4317');
    expect(u.list).toBe('http://127.0.0.1:4317/tickers');
    expect(u.remove('aapl')).toBe('http://127.0.0.1:4317/tickers/AAPL');
  });
});

describe('buildEarningsLookup', () => {
  it('returns the seeded NVDA earnings event from the sample calendar', () => {
    const ev = buildEarningsLookup().earnings('NVDA');
    expect(ev).not.toBeNull();
    expect(ev!.inDays).toBeGreaterThanOrEqual(0);
    expect(ev!.title.toLowerCase()).toContain('nvda');
  });

  it('returns null for symbols with no upcoming earnings', () => {
    expect(buildEarningsLookup().earnings('ZZZZ')).toBeNull();
  });
});

describe('<Watchlist />', () => {
  it('renders the seeded list with the disclaimer and earnings badge', () => {
    render(
      <Watchlist
        initialEntries={[entry({ symbol: 'NVDA' })]}
        disableLiveQuotes
      />,
    );
    expect(screen.getByLabelText('Watchlist')).toBeDefined();
    expect(screen.getByText('NVDA')).toBeDefined();
    expect(screen.getByText(/NVIDIA Corp/)).toBeDefined();
    expect(screen.getByText(/Earnings \+\d+d/)).toBeDefined();
    expect(screen.getByText(/Not financial advice/i)).toBeDefined();
  });

  it('renders the empty state when the server returns no entries', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    render(<Watchlist fetchImpl={fetchImpl} disableLiveQuotes />);
    await waitFor(() => {
      expect(screen.getByText(/No tickers yet/)).toBeDefined();
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/tickers');
  });

  it('POSTs to /tickers/validate when the user adds a symbol', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/tickers/validate')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ entries: [entry({ symbol: 'AAPL', name: 'Apple Inc' })] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    render(
      <Watchlist
        initialEntries={[]}
        fetchImpl={fetchImpl}
        disableLiveQuotes
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Add tickers/), 'aapl');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/tickers/validate'));
      expect(post).toBeDefined();
      expect(post!.init?.method).toBe('POST');
      const body = JSON.parse(String(post!.init?.body));
      expect(body.symbols).toEqual(['AAPL']);
      expect(body.refresh).toBe(false);
    });
  });

  it('DELETEs the symbol when the user clicks remove', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/tickers/NVDA') && init?.method === 'DELETE') {
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <Watchlist
        initialEntries={[entry({ symbol: 'NVDA' })]}
        fetchImpl={fetchImpl}
        disableLiveQuotes
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Remove NVDA'));
    await waitFor(() => {
      const del = calls.find(
        (c) => c.init?.method === 'DELETE' && c.url.endsWith('/tickers/NVDA'),
      );
      expect(del).toBeDefined();
    });
  });
});
