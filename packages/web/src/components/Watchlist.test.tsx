import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Watchlist } from './Watchlist.js';
import { SAMPLE_TICKERS } from '../sample-data.js';

afterEach(() => cleanup());

describe('Watchlist', () => {
  it('renders one row per sample ticker by default', () => {
    render(
      <Watchlist
        active={SAMPLE_TICKERS[0]!.symbol}
        onPick={() => {}}
        query=""
        setQuery={() => {}}
        demo
      />,
    );
    for (const t of SAMPLE_TICKERS) {
      // Each ticker symbol shows up as the row label.
      expect(screen.getAllByText(t.symbol).length).toBeGreaterThan(0);
    }
  });

  it('filters rows case-insensitively by symbol substring', () => {
    const sym = SAMPLE_TICKERS[0]!.symbol;
    render(
      <Watchlist
        active={sym}
        onPick={() => {}}
        query={sym.toLowerCase()}
        setQuery={() => {}}
        demo
      />,
    );
    // The matching ticker is still rendered.
    expect(screen.getAllByText(sym).length).toBeGreaterThan(0);
    // A different sample ticker should be filtered out if its symbol/name
    // doesn't include the query.
    const other = SAMPLE_TICKERS.find(
      (t) =>
        t.symbol !== sym &&
        !t.symbol.toLowerCase().includes(sym.toLowerCase()) &&
        !t.name.toLowerCase().includes(sym.toLowerCase()),
    );
    if (other) {
      expect(screen.queryByText(other.symbol)).toBeNull();
    }
  });

  it('calls setQuery when the filter input changes', () => {
    const setQuery = vi.fn();
    render(
      <Watchlist
        active={SAMPLE_TICKERS[0]!.symbol}
        onPick={() => {}}
        query=""
        setQuery={setQuery}
        demo
      />,
    );
    const input = screen.getByPlaceholderText(/filter watchlist/i);
    fireEvent.change(input, { target: { value: 'nvd' } });
    expect(setQuery).toHaveBeenCalledWith('nvd');
  });

  it('invokes onPick with the row symbol when a row is clicked', () => {
    const onPick = vi.fn();
    const first = SAMPLE_TICKERS[0]!.symbol;
    render(
      <Watchlist active={first} onPick={onPick} query="" setQuery={() => {}} demo />,
    );
    const target = SAMPLE_TICKERS[1] ?? SAMPLE_TICKERS[0]!;
    // Click the row that matches the target's symbol. Multiple elements may
    // share the text, so grab the button ancestor.
    const symEls = screen.getAllByText(target.symbol);
    const btn = symEls
      .map((el) => el.closest('button'))
      .find((b): b is HTMLButtonElement => b !== null);
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(onPick).toHaveBeenCalledWith(target.symbol);
  });
});
