/**
 * `#/options/:sym` — web options-chain explorer.
 *
 * Parity twin of the CLI `regard options <SYM>` screen (issue #155). Both
 * surfaces are thin clients over `GET /options/:symbol` and share the same
 * grouping + greek-fill helpers from `@regardedtrader/core` so the numbers
 * are identical across surfaces.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { OptionContract, Quote } from '@regardedtrader/core';
import { fillGreeks, groupChainByStrike, type ChainRow } from '@regardedtrader/core/options';

import { AiDisclaimer } from '../components/AiDisclaimer.js';

export interface OptionsRouteProps {
  symbol: string;
  /** Override base path for the local server API. Defaults to `/api`. */
  apiBase?: string;
  /** Fetch impl override (tests). */
  fetchImpl?: typeof fetch;
  /** Test seam: when present, skip HTTP and render this chain. */
  initialChain?: OptionContract[];
  /** Test seam: when present, skip the quote fetch. */
  initialQuote?: Quote | null;
  /** Navigate back to the dashboard. */
  onClose?: () => void;
  /** Optional initial expiry filter. */
  initialExpiry?: string;
}

interface ChainRequestPlan {
  url: string;
  quoteUrl: string;
}

/**
 * Build the URL pair this route needs. Exported so tests can pin the wire
 * format without rendering.
 */
export function buildOptionsRequest(opts: {
  symbol: string;
  expiry?: string;
  apiBase?: string;
}): ChainRequestPlan {
  const base = opts.apiBase ?? '/api';
  const sym = encodeURIComponent(opts.symbol.toUpperCase());
  const qs = opts.expiry ? `?expiry=${encodeURIComponent(opts.expiry)}` : '';
  return {
    url: `${base}/options/${sym}${qs}`,
    quoteUrl: `${base}/quote/${sym}`,
  };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; chain: OptionContract[]; quote: Quote | null };

export function Options(props: OptionsRouteProps): JSX.Element {
  const fetchImpl = props.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const [expiry, setExpiry] = useState(props.initialExpiry ?? '');
  const seed = props.initialChain;
  const seedQuote = props.initialQuote ?? null;
  const [status, setStatus] = useState<Status>(
    seed ? { kind: 'ok', chain: seed, quote: seedQuote } : { kind: 'idle' },
  );

  useEffect(() => {
    if (seed) return;
    if (!props.symbol) return;
    if (!fetchImpl) {
      setStatus({ kind: 'error', message: 'fetch is not available in this environment' });
      return;
    }
    let cancelled = false;
    setStatus({ kind: 'loading' });
    const plan = buildOptionsRequest({
      symbol: props.symbol,
      expiry: expiry || undefined,
      apiBase: props.apiBase,
    });
    Promise.allSettled([fetchImpl(plan.url), fetchImpl(plan.quoteUrl)])
      .then(async ([chainRes, quoteRes]) => {
        if (cancelled) return;
        if (chainRes.status === 'rejected') {
          setStatus({
            kind: 'error',
            message:
              chainRes.reason instanceof Error
                ? chainRes.reason.message
                : String(chainRes.reason),
          });
          return;
        }
        if (!chainRes.value.ok) {
          setStatus({ kind: 'error', message: `HTTP ${chainRes.value.status}` });
          return;
        }
        const chainText = await chainRes.value.text();
        let chain: OptionContract[];
        try {
          chain = JSON.parse(chainText) as OptionContract[];
        } catch {
          setStatus({ kind: 'error', message: 'Invalid JSON from server' });
          return;
        }
        let quote: Quote | null = null;
        if (quoteRes.status === 'fulfilled' && quoteRes.value.ok) {
          try {
            quote = JSON.parse(await quoteRes.value.text()) as Quote;
          } catch {
            quote = null;
          }
        }
        if (cancelled) return;
        setStatus({ kind: 'ok', chain, quote });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [props.symbol, expiry, props.apiBase, fetchImpl, seed]);

  const rows: ChainRow[] = useMemo(() => {
    if (status.kind !== 'ok') return [];
    const spot = status.quote?.price ?? null;
    const filtered = expiry
      ? status.chain.filter((c) => c.expiry === expiry)
      : status.chain;
    const withGreeks =
      spot && spot > 0
        ? fillGreeks(filtered, { spot, asOf: status.quote?.asOf })
        : filtered.map((c) => ({ ...c }));
    return groupChainByStrike(withGreeks);
  }, [status, expiry]);

  const expiries: string[] = useMemo(() => {
    if (status.kind !== 'ok') return [];
    return Array.from(new Set(status.chain.map((c) => c.expiry))).sort();
  }, [status]);

  const sym = props.symbol.toUpperCase();

  return (
    <div className="options-route" style={{ maxWidth: 1000, margin: '0 auto', padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{sym} — options chain</h1>
        {props.onClose && (
          <button type="button" onClick={props.onClose} aria-label="Back to dashboard">
            ← Back
          </button>
        )}
      </header>

      {status.kind === 'ok' && status.quote && (
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
          spot ${status.quote.price.toFixed(2)} · as of {status.quote.asOf}
        </div>
      )}

      {expiries.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12 }}>
            Expiry:{' '}
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              aria-label="Expiry filter"
            >
              <option value="">All</option>
              {expiries.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {status.kind === 'loading' && (
        <p role="status" style={{ marginTop: 12 }}>
          Loading options for {sym}…
        </p>
      )}
      {status.kind === 'error' && (
        <p role="alert" style={{ marginTop: 12, color: 'crimson' }}>
          {status.message}
        </p>
      )}
      {status.kind === 'ok' && rows.length === 0 && (
        <p style={{ marginTop: 12 }}>No options data for {sym}.</p>
      )}

      {status.kind === 'ok' && rows.length > 0 && (
        <ChainTable rows={rows} spot={status.quote?.price ?? null} />
      )}

      <div style={{ marginTop: 16 }}>
        <AiDisclaimer marginTop="none" className="italic opacity-70 text-[11px]" />
      </div>
    </div>
  );
}

function ChainTable({
  rows,
  spot,
}: {
  rows: ReadonlyArray<ChainRow>;
  spot: number | null;
}): JSX.Element {
  const cell: React.CSSProperties = {
    padding: '2px 6px',
    fontFamily: 'monospace',
    textAlign: 'right',
    whiteSpace: 'nowrap',
  };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, opacity: 0.7 };
  return (
    <table
      style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}
      aria-label="Options chain"
    >
      <thead>
        <tr>
          <th style={head} colSpan={4}>
            Calls
          </th>
          <th style={head}>Strike</th>
          <th style={head} colSpan={4}>
            Puts
          </th>
        </tr>
        <tr>
          <th style={head}>Δ</th>
          <th style={head}>Bid</th>
          <th style={head}>Ask</th>
          <th style={head}>IV</th>
          <th style={head}>&nbsp;</th>
          <th style={head}>IV</th>
          <th style={head}>Bid</th>
          <th style={head}>Ask</th>
          <th style={head}>Δ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <ChainRowView key={r.strike} row={r} spot={spot} cell={cell} />
        ))}
      </tbody>
    </table>
  );
}

function ChainRowView({
  row,
  spot,
  cell,
}: {
  row: ChainRow;
  spot: number | null;
  cell: React.CSSProperties;
}): JSX.Element {
  const callItm =
    !!row.call && spot != null && spot > row.call.strike ? '#d1fadf' : undefined;
  const putItm =
    !!row.put && spot != null && spot < row.put.strike ? '#fee4e2' : undefined;
  return (
    <tr>
      <td style={{ ...cell, background: callItm }}>{fmt(row.call?.delta, 2)}</td>
      <td style={{ ...cell, background: callItm }}>{fmt(row.call?.bid, 2)}</td>
      <td style={{ ...cell, background: callItm }}>{fmt(row.call?.ask, 2)}</td>
      <td style={{ ...cell, background: callItm }}>{ivPct(row.call?.iv)}</td>
      <td style={{ ...cell, fontWeight: 700 }}>{fmt(row.strike, 2)}</td>
      <td style={{ ...cell, background: putItm }}>{ivPct(row.put?.iv)}</td>
      <td style={{ ...cell, background: putItm }}>{fmt(row.put?.bid, 2)}</td>
      <td style={{ ...cell, background: putItm }}>{fmt(row.put?.ask, 2)}</td>
      <td style={{ ...cell, background: putItm }}>{fmt(row.put?.delta, 2)}</td>
    </tr>
  );
}

function fmt(n: number | null | undefined, digits: number): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);
}
function ivPct(iv: number | null | undefined): string {
  return iv == null || !Number.isFinite(iv) ? '—' : `${(iv * 100).toFixed(1)}%`;
}
