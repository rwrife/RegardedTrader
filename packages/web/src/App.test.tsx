import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('opens the command palette with Ctrl+K and executes CLI-style plan command', () => {
    render(<App />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const paletteInput = screen.getByPlaceholderText('Type a command…');
    fireEvent.change(paletteInput, { target: { value: 'plan AAPL' } });
    fireEvent.keyDown(paletteInput, { key: 'Enter' });

    expect(window.location.hash).toBe('#/plan/AAPL');
  });

  it('focuses the ticker bar when pressing slash outside editable controls', () => {
    render(<App />);

    const tickerInput = screen.getByLabelText('Ticker input');
    expect((tickerInput as HTMLInputElement).disabled).toBe(false);
    expect(document.activeElement).not.toBe(tickerInput);

    fireEvent.keyDown(window, { key: '/' });

    expect(document.activeElement).toBe(tickerInput);
  });
});
