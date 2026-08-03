import React from 'react';
import { useLiveQuote } from '../hooks/useLiveQuote.js';

export interface WatchlistRowTicker {
  symbol: string;
  name: string;
  quote?: { price: number; change: number; changePercent: number };
}

/**
 * Single row in the watchlist. Works with both sample and real tickers.
 * Uses live quote polling when the backend is reachable; falls back to
 * static quote data when provided (sample/demo mode).
 */
export function WatchlistRow({
  t,
  active,
  onPick,
  demo,
}: {
  t: WatchlistRowTicker;
  active: boolean;
  onPick: (s: string) => void;
  demo: boolean;
}): JSX.Element {
  const live = useLiveQuote(t.symbol, { enabled: !demo });
  const price = live.quote?.price ?? t.quote?.price;
  const change = live.quote?.change ?? t.quote?.change ?? 0;
  const changePercent = live.quote?.changePercent ?? t.quote?.changePercent ?? 0;
  const up = change >= 0;
  return (
    <li>
      <button
        onClick={() => onPick(t.symbol)}
        className={`w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-surface-2 ${
          active ? 'bg-surface-2' : ''
        }`}
      >
        <span className="font-semibold tracking-tight w-12">{t.symbol}</span>
        <span className="num text-fg-secondary truncate flex-1">
          {price != null ? `$${price.toFixed(2)}` : t.name}
        </span>
        {price != null && (
          <span className={`num ml-auto ${up ? 'text-up' : 'text-down'}`}>
            {up ? '▲' : '▼'} {up ? '+' : ''}
            {changePercent.toFixed(2)}%
          </span>
        )}
      </button>
    </li>
  );
}
