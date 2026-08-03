import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { App } from './App.js';
import { SAMPLE_TICKERS } from './sample-data.js';

afterEach(() => {
  cleanup();
  window.location.hash = '#/';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('<App />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  it('renders in demo mode with seeded watchlist data', () => {
    render(<App />);
    expect(screen.getByText(/RegardedTrader/)).toBeDefined();
    expect(screen.getAllByText(SAMPLE_TICKERS[0]!.symbol).length).toBeGreaterThan(0);
  });
});
