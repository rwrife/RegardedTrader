import React, { useCallback, useEffect, useState } from 'react';
import type { ValidationResult, WatchlistEntry } from '../types.js';
import { AiDisclaimer } from './AiDisclaimer.js';
import { ResultRow } from './ResultRow.js';

/**
 * M1 ticker intake form + validated-list. POSTs candidate symbols to
 * `/api/tickers/validate`, shows the per-symbol results, and refreshes the
 * persisted watchlist from `/api/tickers`. Extracted from App.tsx in #112.
 */
export function TickerIntake({ demo }: { demo: boolean }): JSX.Element {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [results, setResults] = useState<ValidationResult[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    if (demo) return;
    try {
      const r = await fetch('/api/tickers');
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as { entries: WatchlistEntry[] };
      setEntries(j.entries);
    } catch (e) {
      setErr(`Could not load watchlist: ${(e as Error).message}`);
    }
  }, [demo]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  async function validate(refresh: boolean): Promise<void> {
    const symbols = input
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) return;
    setBusy(true);
    setErr(null);
    setResults([]);
    try {
      const r = await fetch('/api/tickers/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols, refresh }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`${r.status}: ${t}`);
      }
      const j = (await r.json()) as { results: ValidationResult[] };
      setResults(j.results);
      setInput('');
      await refreshList();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(symbol: string): Promise<void> {
    if (demo) return;
    await fetch(`/api/tickers/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
    await refreshList();
  }

  return (
    <div className="border border-border-subtle bg-surface rounded">
      <div className="p-2 border-b border-border-subtle">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          Add tickers
        </div>
        <div className="flex gap-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void validate(false);
            }}
            placeholder="NVDA AAPL META"
            disabled={busy || demo}
            className="flex-1 bg-surface-2 border border-border-subtle rounded px-2 py-1 text-xs focus:outline-none focus:border-ai disabled:opacity-50"
          />
          <button
            onClick={() => void validate(false)}
            disabled={busy || demo || !input.trim()}
            className="px-2 py-1 text-xs bg-ai/10 text-ai rounded border border-ai/30 hover:bg-ai/20 disabled:opacity-40"
            title="Validate and add"
          >
            Add
          </button>
          <button
            onClick={() => void validate(true)}
            disabled={busy || demo || !input.trim()}
            className="px-2 py-1 text-xs bg-surface-2 text-fg-secondary rounded border border-border-subtle hover:text-fg disabled:opacity-40"
            title="Force re-validation, bypass 7-day cache"
          >
            ↻
          </button>
        </div>
        {demo && (
          <div className="mt-1.5 text-[10px] text-fg-muted">
            Demo mode — backend not reachable. Start the server to add real tickers.
          </div>
        )}
        {err && <div className="mt-1.5 text-[10px] text-down">{err}</div>}
        {busy && <div className="mt-1.5 text-[10px] text-fg-muted">Validating…</div>}
      </div>

      {results.length > 0 && (
        <div className="border-b border-border-subtle p-2 space-y-2">
          {results.map((r, i) => (
            <ResultRow key={i} r={r} />
          ))}
          <AiDisclaimer marginTop="none" className="text-[10px] text-fg-muted italic" />
        </div>
      )}

      <div>
        <div className="px-2 pt-2 text-[10px] font-mono tracking-wider text-fg-muted uppercase">
          Validated ({entries.length})
        </div>
        {entries.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-fg-muted">No validated tickers yet.</div>
        ) : (
          <ul className="text-xs">
            {entries.map((e) => (
              <li
                key={e.profile.symbol}
                className="px-3 py-2 flex items-baseline gap-2 border-t border-border-subtle/40"
                title={e.profile.description}
              >
                <span className="font-semibold tracking-tight w-12">{e.profile.symbol}</span>
                <span className="text-fg-secondary truncate flex-1">{e.profile.name}</span>
                <span className="text-[10px] text-fg-muted">{e.profile.exchange}</span>
                <button
                  onClick={() => void remove(e.profile.symbol)}
                  className="text-fg-muted hover:text-down text-[10px]"
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
