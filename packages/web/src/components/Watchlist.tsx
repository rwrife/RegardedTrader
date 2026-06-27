import React from 'react';
import { SAMPLE_TICKERS } from '../sample-data.js';
import { WatchlistRow } from './WatchlistRow.js';

/**
 * Sidebar watchlist: filter input plus a list of `WatchlistRow`s. Active
 * row is highlighted. Extracted from App.tsx in #112.
 */
export function Watchlist({
  active,
  onPick,
  query,
  setQuery,
  demo,
}: {
  active: string;
  onPick: (s: string) => void;
  query: string;
  setQuery: (s: string) => void;
  demo: boolean;
}): JSX.Element {
  const filtered = SAMPLE_TICKERS.filter(
    (t) =>
      !query ||
      t.symbol.toLowerCase().includes(query.toLowerCase()) ||
      t.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="border border-border-subtle bg-surface rounded">
      <div className="p-2 border-b border-border-subtle">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter watchlist…"
          className="w-full bg-surface-2 border border-border-subtle rounded px-2 py-1 text-xs focus:outline-none focus:border-ai"
        />
      </div>
      <ul className="text-xs">
        {filtered.map((t) => (
          <WatchlistRow
            key={t.symbol}
            t={t}
            active={active === t.symbol}
            onPick={onPick}
            demo={demo}
          />
        ))}
      </ul>
    </div>
  );
}
