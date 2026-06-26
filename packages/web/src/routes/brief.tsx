import React, { useEffect, useState } from 'react';
import type { Briefing, BriefingRequest } from '@regardedtrader/core';
import { AiDisclaimer } from '../components/AiDisclaimer.js';

export interface BriefRouteProps {
  symbol: string;
  /** Override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Base path for the server API (defaults to `/api` to use Vite proxy). */
  apiBase?: string;
  /** Initial form values for the strategist arm. */
  initialThesis?: string;
  initialMaxLossUsd?: number;
  initialExpiry?: string;
  /** Callback to navigate back to the dashboard. */
  onClose?: () => void;
}

export interface BriefRequestPlan {
  url: string;
  init: RequestInit;
  usesStrategist: boolean;
}

/**
 * Pure helper that builds the HTTP call shape for the brief route. Exported
 * so the unit test can pin GET vs POST behaviour without rendering.
 *
 * Mirrors the CLI's `buildBriefRequest` so the two surfaces stay in lockstep
 * (issue #139 surface-parity rule).
 */
export function buildBriefRequest(opts: {
  symbol: string;
  thesis?: string;
  maxLossUsd?: number;
  expiry?: string;
  apiBase?: string;
}): BriefRequestPlan {
  const base = opts.apiBase ?? '/api';
  const body: BriefingRequest = {};
  if (opts.thesis) body.thesis = opts.thesis;
  if (typeof opts.maxLossUsd === 'number' && Number.isFinite(opts.maxLossUsd)) {
    body.maxLossUsd = opts.maxLossUsd;
  }
  if (opts.expiry) body.expiry = opts.expiry;
  const url = `${base}/briefing/${encodeURIComponent(opts.symbol.toUpperCase())}`;
  const usesStrategist = Boolean(body.thesis && typeof body.maxLossUsd === 'number');
  const init: RequestInit = usesStrategist
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    : { method: 'GET' };
  return { url, init, usesStrategist };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; data: Briefing };

/**
 * Web parity for `regard brief <SYM>` (issue #139). Surfaces the full
 * Orchestrator briefing pipeline: analyst sections plus optional Technician,
 * NewsScout, and Strategist arms with their `RiskOfficer` reviews. With no
 * strategist inputs this collapses to an analyst-only briefing (matches
 * `GET /briefing/:symbol`).
 */
export function Brief(props: BriefRouteProps): JSX.Element {
  const fetchImpl = props.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const [thesis, setThesis] = useState(props.initialThesis ?? '');
  const [maxLossStr, setMaxLossStr] = useState(
    props.initialMaxLossUsd === undefined ? '' : String(props.initialMaxLossUsd),
  );
  const [expiry, setExpiry] = useState(props.initialExpiry ?? '');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [runId, setRunId] = useState(0);

  // Auto-run an analyst-only briefing on mount so the page is useful
  // immediately. Strategist runs are explicit via the form.
  useEffect(() => {
    if (!props.symbol) return;
    if (!fetchImpl) return;
    let cancelled = false;
    setStatus({ kind: 'loading' });
    const maxLossNum = maxLossStr === '' ? undefined : Number(maxLossStr);
    const plan = buildBriefRequest({
      symbol: props.symbol,
      thesis: runId === 0 ? undefined : thesis || undefined,
      maxLossUsd: runId === 0 ? undefined : maxLossNum,
      expiry: runId === 0 ? undefined : expiry || undefined,
      apiBase: props.apiBase,
    });
    fetchImpl(plan.url, plan.init)
      .then(async (res) => {
        const text = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = text ? (JSON.parse(text) as { error?: string }) : {};
            if (j.error) msg = j.error;
          } catch {
            /* fall through */
          }
          setStatus({ kind: 'error', message: msg });
          return;
        }
        try {
          const data = JSON.parse(text) as Briefing;
          setStatus({ kind: 'ok', data });
        } catch {
          setStatus({ kind: 'error', message: 'Invalid JSON from server' });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // We deliberately re-run only when symbol or runId changes; form inputs
    // are read at submit time via `runId` bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.symbol, runId, fetchImpl, props.apiBase]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setRunId((n) => n + 1);
  }

  const sym = props.symbol.toUpperCase();

  return (
    <div className="brief-route" style={{ maxWidth: 880, margin: '0 auto', padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{sym} — full briefing</h1>
        {props.onClose && (
          <button type="button" onClick={props.onClose} aria-label="Back to dashboard">
            ← Back
          </button>
        )}
      </header>

      <form onSubmit={onSubmit} style={{ marginTop: 12, display: 'grid', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Trade thesis (optional)</span>
          <textarea
            value={thesis}
            onChange={(e) => setThesis(e.target.value)}
            placeholder="e.g. mean-revert bounce off SMA50 into next earnings"
            rows={2}
          />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            <span>Max loss (USD)</span>
            <input
              type="number"
              value={maxLossStr}
              onChange={(e) => setMaxLossStr(e.target.value)}
              min={1}
              step={1}
              placeholder="e.g. 500"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            <span>Expiry (optional)</span>
            <input
              type="text"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              placeholder="YYYY-MM-DD"
            />
          </label>
        </div>
        <div>
          <button type="submit" disabled={status.kind === 'loading'}>
            {status.kind === 'loading' ? 'Running…' : 'Run pipeline'}
          </button>
          <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>
            Thesis + max-loss together trigger the strategist arm.
          </span>
        </div>
      </form>

      <section style={{ marginTop: 16 }}>
        {status.kind === 'loading' && <p>Running briefing pipeline for {sym}…</p>}
        {status.kind === 'error' && (
          <p role="alert" style={{ color: 'crimson' }}>
            {status.message}
          </p>
        )}
        {status.kind === 'ok' && <BriefingView data={status.data} />}
      </section>

      <footer style={{ marginTop: 24 }}>
        <AiDisclaimer marginTop="none" className="italic opacity-70" />
      </footer>
    </div>
  );
}

function BriefingView({ data }: { data: Briefing }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <strong>Price</strong> ${data.quote.price.toFixed(2)} ·{' '}
        <strong>RSI</strong> {data.indicators.rsi14?.toFixed(1) ?? '—'} ·{' '}
        <strong>SMA20</strong> {data.indicators.sma20?.toFixed(2) ?? '—'} ·{' '}
        <strong>SMA50</strong> {data.indicators.sma50?.toFixed(2) ?? '—'}
      </div>

      <section>
        <h2 style={{ color: 'seagreen', margin: '4px 0' }}>Analyst — Bull case</h2>
        <p>{data.bullCase || <em>(no bull case generated)</em>}</p>
        <h2 style={{ color: 'crimson', margin: '4px 0' }}>Analyst — Bear case</h2>
        <p>{data.bearCase || <em>(no bear case generated)</em>}</p>
        {data.catalysts.length > 0 && (
          <>
            <h3 style={{ margin: '4px 0' }}>Catalysts</h3>
            <ul>
              {data.catalysts.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        )}
        {data.risks.length > 0 && (
          <>
            <h3 style={{ margin: '4px 0' }}>Risks</h3>
            <ul>
              {data.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {data.ta && (
        <section>
          <h2 style={{ color: 'mediumvioletred', margin: '4px 0' }}>Technician</h2>
          <p>
            <strong>Trend:</strong> {data.ta.trend}
            <br />
            <strong>Momentum:</strong> {data.ta.momentum}
            <br />
            <strong>Volatility:</strong> {data.ta.volatility}
          </p>
          {data.ta.keyLevels.length > 0 && (
            <p>
              <strong>Key levels:</strong>{' '}
              {data.ta.keyLevels.map((n) => n.toFixed(2)).join(', ')}
            </p>
          )}
          <p>{data.ta.commentary}</p>
        </section>
      )}

      {data.newsScout ? (
        <section>
          <h2 style={{ color: 'steelblue', margin: '4px 0' }}>NewsScout</h2>
          <p>{data.newsScout.summary}</p>
          <ul>
            {data.newsScout.headlines.slice(0, 5).map((h, i) => (
              <li key={i}>{h.title}</li>
            ))}
          </ul>
        </section>
      ) : data.news.length > 0 ? (
        <section>
          <h2 style={{ color: 'steelblue', margin: '4px 0' }}>Headlines</h2>
          <ul>
            {data.news.slice(0, 5).map((h, i) => (
              <li key={i}>{h.title}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.strategist && (
        <section>
          <h2 style={{ color: 'goldenrod', margin: '4px 0' }}>
            Strategist candidates ({data.strategist.candidates.length})
          </h2>
          <p style={{ opacity: 0.8 }}>
            <em>Thesis:</em> {data.strategist.thesis}
          </p>
          {data.strategist.noCompliantPlans && (
            <p style={{ color: 'crimson' }}>No candidate plans passed risk caps.</p>
          )}
          <ol>
            {data.strategist.candidates.map((c, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <strong>{c.plan.name}</strong> {c.review.ok ? '✓' : '⚠'}
                <div>
                  Max loss ${c.plan.maxLoss.toFixed(2)} · Max gain{' '}
                  {c.plan.maxGain === null ? '∞' : `$${c.plan.maxGain.toFixed(2)}`}
                </div>
                {c.plan.breakEvens.length > 0 && (
                  <div>
                    Break-evens: {c.plan.breakEvens.map((b) => b.toFixed(2)).join(', ')}
                  </div>
                )}
                {!c.review.ok && c.review.violations.length > 0 && (
                  <ul style={{ color: 'crimson' }}>
                    {c.review.violations.map((v, j) => (
                      <li key={j}>⚠ {v}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {data.riskVerdict && (
        <section>
          <h2 style={{ color: data.riskVerdict.ok ? 'seagreen' : 'crimson', margin: '4px 0' }}>
            RiskOfficer verdict: {data.riskVerdict.ok ? 'OK' : 'BLOCKED'}
          </h2>
          {data.riskVerdict.violations.length > 0 && (
            <ul style={{ color: 'crimson' }}>
              {data.riskVerdict.violations.map((v, i) => (
                <li key={i}>⚠ {v}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
