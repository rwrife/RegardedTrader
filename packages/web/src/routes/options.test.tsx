import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Options, buildOptionsRequest } from './options.js';
import type { OptionContract, Quote } from '@regardedtrader/core';

afterEach(() => {
  cleanup();
});

describe('buildOptionsRequest', () => {
  it('uppercases the symbol and points at /api/options', () => {
    const r = buildOptionsRequest({ symbol: 'nvda' });
    expect(r.url).toBe('/api/options/NVDA');
    expect(r.quoteUrl).toBe('/api/quote/NVDA');
  });

  it('attaches the expiry query when provided', () => {
    const r = buildOptionsRequest({ symbol: 'AAPL', expiry: '2026-07-17' });
    expect(r.url).toBe('/api/options/AAPL?expiry=2026-07-17');
  });

  it('honors the apiBase override', () => {
    const r = buildOptionsRequest({ symbol: 'msft', apiBase: 'http://127.0.0.1:4317' });
    expect(r.url).toBe('http://127.0.0.1:4317/options/MSFT');
  });
});

function contract(over: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: 'NVDA-C-150',
    underlying: 'NVDA',
    expiry: '2026-12-18',
    strike: 150,
    type: 'call',
    bid: 5,
    ask: 5.5,
    last: 5.25,
    volume: 100,
    openInterest: 1000,
    iv: 0.4,
    ...over,
  };
}

const sampleChain: OptionContract[] = [
  contract({ strike: 140, type: 'call' }),
  contract({ strike: 140, type: 'put', symbol: 'NVDA-P-140' }),
  contract({ strike: 150, type: 'call' }),
  contract({ strike: 150, type: 'put', symbol: 'NVDA-P-150' }),
  contract({ strike: 160, type: 'call' }),
  contract({ strike: 160, type: 'put', symbol: 'NVDA-P-160' }),
];

const sampleQuote: Quote = {
  symbol: 'NVDA',
  price: 152,
  change: 1,
  changePercent: 0.6,
  volume: 1_000_000,
  asOf: '2026-06-23T00:00:00Z',
};

describe('<Options />', () => {
  it('renders a chain table with the disclaimer when seeded with data', () => {
    render(<Options symbol="NVDA" initialChain={sampleChain} initialQuote={sampleQuote} />);
    expect(screen.getByLabelText('Options chain')).toBeDefined();
    expect(screen.getByText(/Not financial advice/i)).toBeDefined();
    // Strikes render as monospace numbers.
    expect(screen.getByText('140.00')).toBeDefined();
    expect(screen.getByText('150.00')).toBeDefined();
    expect(screen.getByText('160.00')).toBeDefined();
  });

  it('lets the user filter by expiry', async () => {
    const mixed: OptionContract[] = [
      contract({ strike: 150, expiry: '2026-12-18' }),
      contract({ strike: 160, expiry: '2027-01-15' }),
    ];
    render(<Options symbol="NVDA" initialChain={mixed} initialQuote={sampleQuote} />);
    // Both strikes initially visible (no filter).
    expect(screen.getByText('150.00')).toBeDefined();
    expect(screen.getByText('160.00')).toBeDefined();

    const select = screen.getByLabelText('Expiry filter') as HTMLSelectElement;
    await userEvent.selectOptions(select, '2026-12-18');
    await waitFor(() => {
      expect(screen.queryByText('160.00')).toBeNull();
    });
    expect(screen.getByText('150.00')).toBeDefined();
  });

  it('shows an empty-state message when the seeded chain is empty', () => {
    render(<Options symbol="ZZZZ" initialChain={[]} initialQuote={null} />);
    expect(screen.getByText(/No options data for ZZZZ/i)).toBeDefined();
  });
});
