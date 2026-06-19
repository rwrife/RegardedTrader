/**
 * `#/plan/:sym` — web trade-plan view, parity twin of CLI's `regard plan`.
 *
 * Per issue #113, this is the dashboard surface for the OptionsStrategist +
 * RiskOfficer pipeline that already powers `POST /plans` and the CLI plan
 * wizard. It is a thin client: all the strategist/risk logic lives in
 * `core`/`server`; this route only does form intake, the HTTP call, and the
 * card+chart rendering for the returned `ReviewedTradePlan[]`.
 *
 * The risk-graph (P/L at expiry) is rendered via `RiskGraphChart` so the
 * `plan.riskGraph` series from #76 finally has a UI home.
 */
import React, { useEffect, useState } from 'react';
import type { PlansResponse, ReviewedTradePlan } from '@regardedtrader/core';
import { RiskGraphChart } from '../components/RiskGraphChart.js';

const DISCLAIMER =
  'Not financial advice. AI-generated analysis based on public data. Verify everything before trading.';

export interface PlanRouteProps {
  symbol: string;
  /** Default budget surfaced in the form. Comes from app config in production. */
  defaultMaxLossUsd?: number;
  /** Override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Base path for the server API (defaults to `/api` to use Vite proxy). */
  apiBase?: string;
  /** Navigate back to dashboard. */
  onClose?: () => void;
}

export interface PlanRequestPlan {
  url: string;
  init: RequestInit;
}

/**
 * Pure helper that builds the `POST /plans` request shape. Exported so unit
 * tests can pin behaviour without rendering. Mirrors the CLI's request body
 * exactly so the two surfaces stay in lockstep (surface-parity rule).
 */
export function buildPlanRequest(opts: {
  symbol: string;
  thesis: string;
  maxLossUsd: number;
  expiry?: string;
  apiBase?: string;
}): PlanRequestPlan {
  const base = opts.apiBase ?? '/api';
  const body: Record<string, unknown> = {
    symbol: opts.symbol.toUpperCase(),
    thesis: opts.thesis,
    maxLossUsd: opts.maxLossUsd,
  };
  if (opts.expiry && opts.expiry.trim()) body.expiry = opts.expiry.trim();
  return {
    url: `${base}/plans`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; data: PlansResponse };

export function Plan(props: PlanRouteProps): JSX.Element {
  const fetchImpl = props.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  const [thesis, setThesis] = useState('');
  const [maxLossStr, setMaxLossStr] = useState<string>(
    typeof props.defaultMaxLossUsd === 'number' ? String(props.defaultMaxLossUsd) : '500',
  );
  const [expiry, setExpiry] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (runId === 0) return;
    if (!props.symbol) return;
    if (!fetchImpl) {
      setStatus({ kind: 'error', message: 'fetch is not available in this environment' });
      return;
    }
    const maxLossNum = Number(maxLossStr);
    if (!thesis.trim()) {
      setStatus({ kind: 'error', message: 'Thesis is required.' });
      return;
    }
    if (!Number.isFinite(maxLossNum) || maxLossNum <= 0) {
      setStatus({ kind: 'error', message: 'Max loss must be a positive number.' });
      return;
    }

    let cancelled = false;
    setStatus({ kind: 'loading' });
    const plan = buildPlanRequest({
      symbol: props.symbol,
      thesis: thesis.trim(),
      maxLossUsd: maxLossNum,
      expiry: expiry || undefined,
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
          const data = JSON.parse(text) as PlansResponse;
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
    // Inputs are read on submit via runId bump; we deliberately don't depend
    // on `thesis`/`maxLossStr`/`expiry` for re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, props.symbol, fetchImpl, props.apiBase]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setRunId((n) => n + 1);
  }

  const sym = props.symbol.toUpperCase();

  return (
    <div className="plan-route" style={{ maxWidth: 880, margin: '0 auto', padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{sym} — trade plan</h1>
        {props.onClose && (
          <button type="button" onClick={props.onClose} aria-label="Back to dashboard">
            ← Back
          </button>
        )}
      </header>

      <form onSubmit={onSubmit} style={{ marginTop: 12, display: 'grid', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Trade thesis</span>
          <textarea
            value={thesis}
            onChange={(e) => setThesis(e.target.value)}
            placeholder='e.g. "bullish into earnings, defined risk"'
            rows={2}
            aria-label="Trade thesis"
          />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            <span>Max loss budget (USD)</span>
            <input
              type="number"
              value={maxLossStr}
              onChange={(e) => setMaxLossStr(e.target.value)}
              min={1}
              step={1}
              aria-label="Max loss budget"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            <span>Expiry (optional)</span>
            <input
              type="text"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              placeholder="YYYY-MM-DD"
              aria-label="Expiry"
            />
          </label>
        </div>
        <div>
          <button type="submit" disabled={status.kind === 'loading'}>
            {status.kind === 'loading' ? 'Building plans…' : 'Build plans'}
          </button>
        </div>
      </form>

      <section style={{ marginTop: 16 }}>
        {status.kind === 'idle' && (
          <p style={{ opacity: 0.7 }}>
            Enter a thesis and a max-loss budget, then build candidate option structures.
          </p>
        )}
        {status.kind === 'loading' && <p>Generating candidate plans for {sym}…</p>}
        {status.kind === 'error' && (
          <p role="alert" style={{ color: 'crimson' }}>
            {status.message}
          </p>
        )}
        {status.kind === 'ok' && <PlansView data={status.data} />}
      </section>

      <footer style={{ marginTop: 24, fontStyle: 'italic', opacity: 0.7 }}>{DISCLAIMER}</footer>
    </div>
  );
}

function PlansView({ data }: { data: PlansResponse }): JSX.Element {
  if (data.plans.length === 0) {
    return (
      <p role="status">
        No candidate plans were generated. Try a different thesis or a higher max-loss budget.
      </p>
    );
  }
  return (
    <div>
      {data.noCompliantPlans && (
        <p role="alert" style={{ color: 'crimson' }}>
          No candidate plans passed your configured risk caps. Showing all candidates below for
          context.
        </p>
      )}
      <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
        {data.plans.map((c, i) => (
          <li key={i}>
            <PlanCard candidate={c} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function PlanCard({ candidate }: { candidate: ReviewedTradePlan }): JSX.Element {
  const { plan, review } = candidate;
  return (
    <article
      data-testid="plan-card"
      style={{
        border: '1px solid #1f2937',
        borderLeft: '4px solid #22d3ee',
        borderRadius: 4,
        padding: 12,
        background: '#0F1620',
        color: '#e5e7eb',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>
          {plan.name} {review.ok ? '✓' : '⚠'}
        </h3>
        <span style={{ fontSize: 11, opacity: 0.7 }}>AI</span>
      </header>
      <p style={{ margin: '4px 0', opacity: 0.85 }}>
        <em>{plan.thesis}</em>
      </p>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto 1fr',
          gap: '2px 8px',
          margin: '4px 0',
          fontFamily: 'monospace',
          fontSize: 12,
        }}
      >
        <dt>Max loss</dt>
        <dd style={{ margin: 0 }}>${plan.maxLoss.toFixed(2)}</dd>
        <dt>Max gain</dt>
        <dd style={{ margin: 0 }}>
          {plan.maxGain === null ? '∞' : `$${plan.maxGain.toFixed(2)}`}
        </dd>
        <dt>Break-evens</dt>
        <dd style={{ margin: 0, gridColumn: '2 / span 3' }}>
          {plan.breakEvens.length === 0
            ? '—'
            : plan.breakEvens.map((b) => b.toFixed(2)).join(', ')}
        </dd>
      </dl>

      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>Legs ({plan.legs.length})</summary>
        <ul style={{ fontFamily: 'monospace', fontSize: 12, margin: '4px 0 0 16px' }}>
          {plan.legs.map((leg, i) => (
            <li key={i}>
              {leg.action.toUpperCase()} {leg.qty}x {leg.contract.symbol}{' '}
              {leg.contract.expiry} {leg.contract.strike.toFixed(2)}{' '}
              {leg.contract.type.toUpperCase()} @ ${leg.contract.last?.toFixed(2) ?? '—'}
            </li>
          ))}
        </ul>
      </details>

      {plan.notes && (
        <p style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{plan.notes}</p>
      )}

      {!review.ok && review.violations.length > 0 && (
        <ul
          data-testid="risk-violations"
          style={{
            margin: '8px 0 0',
            paddingLeft: 16,
            color: '#fbbf24',
            fontSize: 12,
          }}
        >
          {review.violations.map((v, i) => (
            <li key={i}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '0 6px',
                  marginRight: 6,
                  border: '1px solid #fbbf24',
                  borderRadius: 9999,
                  fontSize: 10,
                  textTransform: 'uppercase',
                }}
              >
                Risk
              </span>
              {v}
            </li>
          ))}
        </ul>
      )}

      {plan.riskGraph && plan.riskGraph.underlying.length >= 2 && (
        <div style={{ marginTop: 8 }}>
          <RiskGraphChart series={plan.riskGraph} />
        </div>
      )}
    </article>
  );
}
