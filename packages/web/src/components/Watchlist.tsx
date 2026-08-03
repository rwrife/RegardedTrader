import React, { useCallback, useEffect, useState } from 'react';
import { SAMPLE_TICKERS } from '../sample-data.js';
import { WatchlistRow } from './WatchlistRow.js';
import type { WatchlistEntry } from '../types.js';

/**
 * Sidebar watchlist: filter input plus a list of WatchlistRows.
 * In live mode fetches real entries from /api/tickers; demo falls back to
 * SAMPLE_TICKERS.
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
  const [realEntries, setRealEntries] = useState<WatchlistEntry[]>([]);

  const refresh = useCallback(async () => {
    if (demo) return;
    try {
      const r = await fetch('/api/tickers');
      if (!r.ok) return;
      const j = (await r.json()) as { entries: WatchlistEntry[] };
      if (Array.isArray(j.entries)) setRealEntries(j.entries);
    } catch { /* server not ready */ }
  }, [demo]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll for new entries every 5 s so additions in TickerIntake appear here.
  useEffect(() => {
    if (demo) return;
    const id = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(id);
  }, [demo, refresh]);

  const rows = demo
    ? SAMPLE_TICKERS.filter(
        (t) =>
          !query ||
          t.symbol.toLowerCase().includes(query.toLowerCase()) ||
          t.name.toLowerCase().includes(query.toLowerCase()),
      ).map((t) => ({ symbol: t.symbol, name: t.name, quote: t.quote }))
    : realEntries
        .map((e) => ({ symbol: e.profile.symbol, name: e.profile.name }))
        .filter(
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
        {rows.length === 0 ? (
          <li className="px-3 py-3 text-fg-muted text-[11px]">
            {demo ? 'No tickers.' : 'Add tickers above to get started.'}
          </li>
        ) : (
          rows.map((t) => (
            <WatchlistRow
              key={t.symbol}
              t={t}
              active={active === t.symbol}
              onPick={onPick}
              demo={demo}
            />
          ))
        )}
      </ul>
    </div>
  );
}
