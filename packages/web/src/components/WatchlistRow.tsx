import React from 'react';
import type { SampleTicker } from '../sample-data.js';
import { useLiveQuote } from '../hooks/useLiveQuote.js';

/**
 * Single row in the watchlist. Subscribes to live quote polling when the
 * backend is reachable so prices/percent change reflect reality; in demo
 * mode it falls back to the seeded sample quote. Extracted from App.tsx
 * in #112.
 */
export function WatchlistRow({
  t,
  active,
  onPick,
  demo,
}: {
  t: SampleTicker;
  active: boolean;
  onPick: (s: string) => void;
  demo: boolean;
}): JSX.Element {
  // Subscribe each row to live quotes when the backend is reachable. The hook
  // pauses polling when the tab is hidden and adapts cadence to market state,
  // so N rows == N polls but each one is cheap.
  const live = useLiveQuote(t.symbol, { enabled: !demo });
  const price = live.quote?.price ?? t.quote.price;
  const change = live.quote?.change ?? t.quote.change;
  const changePercent = live.quote?.changePercent ?? t.quote.changePercent;
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
        <span className="num text-fg-secondary">${price.toFixed(2)}</span>
        <span className={`num ml-auto ${up ? 'text-up' : 'text-down'}`}>
          {up ? '▲' : '▼'} {up ? '+' : ''}
          {changePercent.toFixed(2)}%
        </span>
      </button>
    </li>
  );
}
