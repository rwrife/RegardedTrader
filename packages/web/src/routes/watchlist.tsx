/**
 * `#/watchlist` — web watchlist surface.
 *
 * Parity twin of the CLI `regard watch <ls|add|rm>` flow (issue #167). Both
 * surfaces talk to the same `/tickers` endpoints on the local server:
 *
 *   - `GET /tickers`                 \u2192 list validated entries
 *   - `POST /tickers/validate`       \u2192 add (one or more) by symbol
 *   - `DELETE /tickers/:sym`         \u2192 remove
 *
 * The price column is hydrated via `useLiveQuote`, which already powers the
 * sidebar `Watchlist` component; so this route is purely a thin client over
 * existing server + shared hooks (no new orchestration logic).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  WatchlistEntry as WatchlistEntrySchema,
  type WatchlistEntry,
} from '@regardedtrader/core/schemas';
import { z } from 'zod';
import { AiDisclaimer } from '../components/AiDisclaimer.js';
import { useLiveQuote } from '../hooks/useLiveQuote.js';
import { SAMPLE_CALENDAR } from '../sample-data.js';

export interface WatchlistRouteProps {
  /** Override fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Override base path; defaults to `/api`. */
  apiBase?: string;
  /** Test seam: when present, skip the initial fetch and seed the list. */
  initialEntries?: WatchlistEntry[];
  /** When true, render rows without subscribing to live quotes. */
  disableLiveQuotes?: boolean;
  /** Navigate back to the dashboard. */
  onClose?: () => void;
}

const ListResponse = z.object({
  entries: z.array(WatchlistEntrySchema).default([]),
});

const ValidateResponse = z.object({
  results: z.array(z.unknown()).default([]),
});

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; entries: WatchlistEntry[] };

/**
 * Pure URL helper, exported so tests can pin the wire format without
 * rendering the component.
 */
export function buildWatchlistUrls(apiBase = '/api'): {
  list: string;
  validate: string;
  remove(symbol: string): string;
} {
  return {
    list: `${apiBase}/tickers`,
    validate: `${apiBase}/tickers/validate`,
    remove: (symbol: string) =>
      `${apiBase}/tickers/${encodeURIComponent(symbol.toUpperCase())}`,
  };
}

interface NextEventLookup {
  /** First upcoming earnings event for the symbol, if any. */
  earnings(symbol: string): { inDays: number; title: string } | null;
}

/**
 * Build a tiny earnings lookup from the sample calendar. The real backend
 * earnings feed lands in #19/#44; until then this just lets us render the
 * "earnings badge" promised by the issue without inventing data.
 */
export function buildEarningsLookup(): NextEventLookup {
  return {
    earnings(symbol) {
      const hit = SAMPLE_CALENDAR.find(
        (ev) => ev.kind === 'earnings' && 'symbol' in ev && ev.symbol === symbol,
      );
      if (!hit) return null;
      return { inDays: hit.dateOffset, title: hit.title };
    },
  };
}

export function Watchlist(props: WatchlistRouteProps): JSX.Element {
  const fetchImpl =
    props.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const apiBase = props.apiBase ?? '/api';
  const urls = useMemo(() => buildWatchlistUrls(apiBase), [apiBase]);
  const events = useMemo(() => buildEarningsLookup(), []);

  const [status, setStatus] = useState<Status>(() =>
    props.initialEntries
      ? { kind: 'ok', entries: props.initialEntries }
      : { kind: 'loading' },
  );
  const [addInput, setAddInput] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const reload = useCallback(async () => {
    if (!fetchImpl) {
      setStatus({ kind: 'error', message: 'fetch is not available in this environment' });
      return;
    }
    setStatus({ kind: 'loading' });
    try {
      const res = await fetchImpl(urls.list);
      if (!res.ok) {
        setStatus({ kind: 'error', message: `HTTP ${res.status}` });
        return;
      }
      const json = (await res.json()) as unknown;
      const parsed = ListResponse.parse(json);
      setStatus({ kind: 'ok', entries: parsed.entries });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [fetchImpl, urls.list]);

  useEffect(() => {
    if (props.initialEntries) return;
    void reload();
  }, [props.initialEntries, reload]);

  const onAdd = useCallback(
    async (raw: string) => {
      const symbols = raw
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0);
      if (symbols.length === 0) return;
      if (!fetchImpl) return;
      setActionError(null);
      setActionPending(true);
      try {
        const res = await fetchImpl(urls.validate, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols, refresh: false }),
        });
        if (!res.ok) {
          setActionError(`HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as unknown;
        // We don't surface the full result detail here — the sidebar intake
        // form does that. We just need to know the call succeeded so we can
        // reload the list.
        ValidateResponse.parse(json);
        setAddInput('');
        await reload();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionPending(false);
      }
    },
    [fetchImpl, urls.validate, reload],
  );

  const onRemove = useCallback(
    async (symbol: string) => {
      if (!fetchImpl) return;
      setActionError(null);
      setActionPending(true);
      try {
        const res = await fetchImpl(urls.remove(symbol), { method: 'DELETE' });
        if (!res.ok) {
          setActionError(`HTTP ${res.status}`);
          return;
        }
        await reload();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionPending(false);
      }
    },
    [fetchImpl, urls, reload],
  );

  return (
    <div className="min-h-screen bg-app text-fg">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Watchlist</h1>
          {props.onClose && (
            <button
              type="button"
              onClick={props.onClose}
              className="text-xs text-fg-muted hover:text-fg-secondary"
            >
              ← back
            </button>
          )}
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd(addInput);
          }}
          className="flex gap-2"
          aria-label="Add ticker"
        >
          <input
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            placeholder="Add tickers (e.g. NVDA AAPL)"
            className="flex-1 bg-surface-2 border border-border-subtle rounded px-2 py-1 text-xs focus:outline-none focus:border-ai"
            disabled={actionPending}
          />
          <button
            type="submit"
            className="px-3 py-1 text-xs border border-border-subtle rounded hover:bg-surface-2 disabled:opacity-50"
            disabled={actionPending || addInput.trim().length === 0}
          >
            Add
          </button>
        </form>

        {actionError && (
          <div role="alert" className="text-xs text-down">
            {actionError}
          </div>
        )}

        {status.kind === 'loading' && (
          <div className="text-xs text-fg-muted">Loading watchlist…</div>
        )}
        {status.kind === 'error' && (
          <div role="alert" className="text-xs text-down">
            {status.message}
          </div>
        )}
        {status.kind === 'ok' && status.entries.length === 0 && (
          <div className="text-xs text-fg-muted">
            No tickers yet. Add one above or run <code>regard watch add NVDA</code>.
          </div>
        )}

        {status.kind === 'ok' && status.entries.length > 0 && (
          <table
            className="w-full text-xs border border-border-subtle rounded overflow-hidden"
            aria-label="Watchlist"
          >
            <thead className="bg-surface text-fg-muted">
              <tr>
                <th className="text-left px-2 py-1">Symbol</th>
                <th className="text-left px-2 py-1">Name</th>
                <th className="text-right px-2 py-1">Last</th>
                <th className="text-right px-2 py-1">%Chg</th>
                <th className="text-left px-2 py-1">Sector</th>
                <th className="text-left px-2 py-1">Events</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {status.entries.map((entry) => (
                <Row
                  key={entry.profile.symbol}
                  entry={entry}
                  earnings={events.earnings(entry.profile.symbol)}
                  liveDisabled={Boolean(props.disableLiveQuotes)}
                  onRemove={() => void onRemove(entry.profile.symbol)}
                  removing={actionPending}
                />
              ))}
            </tbody>
          </table>
        )}

        <AiDisclaimer />
      </div>
    </div>
  );
}

function Row({
  entry,
  earnings,
  liveDisabled,
  onRemove,
  removing,
}: {
  entry: WatchlistEntry;
  earnings: { inDays: number; title: string } | null;
  liveDisabled: boolean;
  onRemove: () => void;
  removing: boolean;
}): JSX.Element {
  const live = useLiveQuote(entry.profile.symbol, { enabled: !liveDisabled });
  const price = live.quote?.price ?? null;
  const changePct = live.quote?.changePercent ?? null;
  const up = changePct !== null && changePct >= 0;
  return (
    <tr className="border-t border-border-subtle">
      <td className="px-2 py-1 font-semibold">{entry.profile.symbol}</td>
      <td className="px-2 py-1 text-fg-secondary truncate max-w-[14rem]" title={entry.profile.name}>
        {entry.profile.name}
      </td>
      <td className="px-2 py-1 text-right num">
        {price !== null ? `$${price.toFixed(2)}` : '—'}
      </td>
      <td className={`px-2 py-1 text-right num ${changePct === null ? '' : up ? 'text-up' : 'text-down'}`}>
        {changePct !== null ? `${up ? '+' : ''}${changePct.toFixed(2)}%` : '—'}
      </td>
      <td className="px-2 py-1 text-fg-muted">{entry.profile.sector}</td>
      <td className="px-2 py-1">
        {earnings ? (
          <span
            className="inline-block px-1.5 py-0.5 rounded bg-surface-2 text-warn text-[10px]"
            title={earnings.title}
          >
            Earnings +{earnings.inDays}d
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </td>
      <td className="px-2 py-1 text-right">
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="text-fg-muted hover:text-down disabled:opacity-50"
          aria-label={`Remove ${entry.profile.symbol}`}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}
