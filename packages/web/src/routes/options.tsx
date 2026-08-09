/**
 * `#/options/:sym` — web options-chain explorer.
 *
 * Parity twin of the CLI `regard options <SYM>` screen (issue #155). Both
 * surfaces are thin clients over `GET /options/:symbol` and share the same
 * grouping + greek-fill helpers from `@regardedtrader/core` so the numbers
 * are identical across surfaces.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type {
  ImpliedMoveRow,
  OptionContract,
  OptionsChainResponse,
  Quote,
  SkewSeries,
} from '@regardedtrader/core';
import {
  fillGreeks,
  groupChainByStrike,
  type ChainRow,
} from '@regardedtrader/core/options';

import { AiDisclaimer } from '../components/AiDisclaimer.js';

export interface OptionsRouteProps {
  symbol: string;
  /** Override base path for the local server API. Defaults to `/api`. */
  apiBase?: string;
  /** Fetch impl override (tests). */
  fetchImpl?: typeof fetch;
  /** Test seam: when present, skip HTTP and render this chain. */
  initialChain?: OptionContract[];
  /** Optional test seam for the implied-move strip. */
  initialImpliedMoves?: ImpliedMoveRow[];
  /** Optional test seam for IV skew-by-expiry data. */
  initialSkew?: SkewSeries[];
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
  | {
      kind: 'ok';
      chain: OptionContract[];
      quote: Quote | null;
      impliedMoves: ImpliedMoveRow[];
      skew: SkewSeries[];
    };

export function Options(props: OptionsRouteProps): JSX.Element {
  const fetchImpl = props.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const [expiry, setExpiry] = useState(props.initialExpiry ?? '');
  const seed = props.initialChain;
  const seedQuote = props.initialQuote ?? null;
  const [status, setStatus] = useState<Status>(
    seed
      ? {
          kind: 'ok',
          chain: seed,
          quote: seedQuote,
          impliedMoves: props.initialImpliedMoves ?? [],
          skew: props.initialSkew ?? [],
        }
      : { kind: 'idle' },
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
        let parsed: OptionsChainResponse | OptionContract[];
        try {
          parsed = JSON.parse(chainText) as OptionsChainResponse | OptionContract[];
        } catch {
          setStatus({ kind: 'error', message: 'Invalid JSON from server' });
          return;
        }
        const chain = Array.isArray(parsed) ? parsed : parsed.contracts;
        const impliedMoves = Array.isArray(parsed) ? [] : parsed.impliedMoves;
        const skew = Array.isArray(parsed) ? [] : (parsed.skew ?? []);
        let quote: Quote | null = null;
        if (quoteRes.status === 'fulfilled' && quoteRes.value.ok) {
          try {
            quote = JSON.parse(await quoteRes.value.text()) as Quote;
          } catch {
            quote = null;
          }
        }
        if (cancelled) return;
        setStatus({
          kind: 'ok',
          chain,
          quote,
          impliedMoves,
          skew,
        });
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

  const displaySkew: SkewSeries[] = useMemo(() => {
    if (status.kind !== 'ok') return [];
    const rows = expiry ? status.skew.filter((row) => row.expiry === expiry) : status.skew;
    return rows;
  }, [status, expiry]);

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

      {status.kind === 'ok' && status.impliedMoves.length > 0 && (
        <ImpliedMoveStrip rows={status.impliedMoves} />
      )}
      {displaySkew.length > 0 && <SkewPanels rows={displaySkew} />}

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

function SkewPanels({ rows }: { rows: ReadonlyArray<SkewSeries> }): JSX.Element {
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
      {rows.map((row) => (
        <SkewPanel key={`skew-${row.expiry}`} row={row} />
      ))}
    </div>
  );
}

function SkewPanel({ row }: { row: SkewSeries }): JSX.Element {
  const width = 520;
  const height = 170;
  const pad = 24;
  const points = [...row.callIv, ...row.putIv].sort((a, b) => a.moneyness - b.moneyness);
  const moneynessValues = points.map((p) => p.moneyness);
  const ivValues = points.map((p) => p.iv);

  if (points.length === 0) {
    return (
      <div style={{ border: '1px solid #243041', borderRadius: 8, padding: 10, fontSize: 12 }}>
        <div style={{ fontFamily: 'monospace', color: '#e5e7eb' }}>{row.expiry} skew</div>
        <div style={{ opacity: 0.7 }}>No IV points available.</div>
      </div>
    );
  }

  const minM = Math.min(...moneynessValues);
  const maxM = Math.max(...moneynessValues);
  const minIv = Math.min(...ivValues);
  const maxIv = Math.max(...ivValues);
  const rangeM = maxM - minM || 1;
  const rangeIv = maxIv - minIv || 1;

  const scaleX = (moneyness: number): number =>
    pad + ((moneyness - minM) / rangeM) * (width - pad * 2);
  const scaleY = (iv: number): number =>
    height - pad - ((iv - minIv) / rangeIv) * (height - pad * 2);

  const callPath = toPath(row.callIv, scaleX, scaleY);
  const putPath = toPath(row.putIv, scaleX, scaleY);
  const atmX = scaleX(1);
  const summary = summarizeSkew(row);

  return (
    <div style={{ border: '1px solid #243041', borderRadius: 8, padding: 10, background: '#0f1620' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          fontFamily: 'monospace',
          fontSize: 12,
          color: '#e5e7eb',
        }}
      >
        <span>{row.expiry} IV skew</span>
        <span style={{ color: row.gappy ? '#f59e0b' : '#94a3b8' }}>
          IV {summary.minPct}..{summary.medianPct}..{summary.maxPct} · slope {summary.slope}
          {row.gappy ? ' · gappy' : ''}
        </span>
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`IV skew chart ${row.expiry}`}
        style={{ display: 'block', marginTop: 8, maxWidth: '100%' }}
      >
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#334155" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#334155" />

        {callPath && (
          <path
            d={callPath}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={2}
            strokeDasharray={row.gappy ? '5 4' : undefined}
          />
        )}
        {putPath && (
          <path
            d={putPath}
            fill="none"
            stroke="#a3a3a3"
            strokeWidth={2}
            strokeDasharray={row.gappy ? '5 4' : undefined}
          />
        )}

        <line x1={atmX} x2={atmX} y1={pad} y2={height - pad} stroke="#f59e0b" strokeWidth={1.5} />

        <text x={pad} y={height - 6} fill="#94a3b8" fontSize={10} fontFamily="monospace">
          {(minM * 100).toFixed(1)}%
        </text>
        <text
          x={width / 2}
          y={height - 6}
          fill="#94a3b8"
          fontSize={10}
          textAnchor="middle"
          fontFamily="monospace"
        >
          ATM 100.0%
        </text>
        <text
          x={width - pad}
          y={height - 6}
          fill="#94a3b8"
          fontSize={10}
          textAnchor="end"
          fontFamily="monospace"
        >
          {(maxM * 100).toFixed(1)}%
        </text>
      </svg>
    </div>
  );
}

function toPath(
  points: ReadonlyArray<{ moneyness: number; iv: number }>,
  sx: (moneyness: number) => number,
  sy: (iv: number) => number,
): string | null {
  if (points.length === 0) return null;
  return points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${sx(p.moneyness).toFixed(2)} ${sy(p.iv).toFixed(2)}`)
    .join(' ');
}

function summarizeSkew(row: SkewSeries): {
  minPct: string;
  medianPct: string;
  maxPct: string;
  slope: string;
} {
  const points = [...row.callIv, ...row.putIv].sort((a, b) => a.moneyness - b.moneyness);
  if (points.length === 0) {
    return { minPct: '—', medianPct: '—', maxPct: '—', slope: '—' };
  }
  const ivs = points.map((p) => p.iv).sort((a, b) => a - b);
  const min = ivs[0]!;
  const median = ivs[Math.floor(ivs.length / 2)]!;
  const max = ivs[ivs.length - 1]!;
  const left = points[0]!;
  const right = points[points.length - 1]!;
  const slope =
    right.moneyness === left.moneyness
      ? null
      : (right.iv - left.iv) / (right.moneyness - left.moneyness);

  return {
    minPct: `${(min * 100).toFixed(1)}%`,
    medianPct: `${(median * 100).toFixed(1)}%`,
    maxPct: `${(max * 100).toFixed(1)}%`,
    slope: slope == null || !Number.isFinite(slope) ? '—' : slope.toFixed(2),
  };
}

function ImpliedMoveStrip({ rows }: { rows: ReadonlyArray<ImpliedMoveRow> }): JSX.Element {
  return (
    <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {rows.map((row) => {
        const warn = row.impliedMovePct >= 0.05;
        return (
          <div
            key={row.expiry}
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              border: '1px solid #2b3442',
              borderRadius: 6,
              padding: '4px 8px',
              color: warn ? '#fbbf24' : '#e5e7eb',
            }}
          >
            {row.expiry}: ±${row.impliedMoveAbs.toFixed(2)} ({(row.impliedMovePct * 100).toFixed(1)}%)
          </div>
        );
      })}
    </div>
  );
}
