import React, { useEffect, useMemo, useState } from 'react';
import { Recommendation as RecommendationSchema, type Recommendation } from '@regardedtrader/core';
import type { SampleTicker } from '../../sample-data.js';
import { AiCard } from '../../components/primitives/AiCard.js';
import { VerdictBlock } from '../../components/primitives/VerdictBlock.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

type VerdictAction = 'BUY' | 'HOLD' | 'SELL' | 'AVOID';

interface RecommendationEventPayload {
  type: 'recommendation.update';
  symbol: string;
  recommendation: Recommendation;
}

interface RecommendationHistoryResponse {
  symbol: string;
  items: Recommendation[];
}

interface RecommendationLatestResponse extends Recommendation {}

interface RecomputeResponse {
  recommendation: Recommendation;
}

export function buildRecommendationLatestUrl(symbol: string): string {
  return `/api/recommendations/${encodeURIComponent(symbol.toUpperCase())}/latest`;
}

export function buildRecommendationHistoryUrl(symbol: string, days = 30): string {
  return `/api/recommendations/${encodeURIComponent(symbol.toUpperCase())}?days=${days}`;
}

export function buildRecommendationRecomputeUrl(symbol: string): string {
  return `/api/recommendations/${encodeURIComponent(symbol.toUpperCase())}/recompute`;
}

function verdictColor(v: VerdictAction): string {
  if (v === 'BUY') return 'bg-up';
  if (v === 'SELL') return 'bg-down';
  if (v === 'AVOID') return 'bg-down/60';
  return 'bg-surface-2';
}

function toHistory(actions: VerdictAction[]): VerdictAction[] {
  if (actions.length >= 30) return actions.slice(actions.length - 30);
  const padding: VerdictAction[] = Array.from(
    { length: 30 - actions.length },
    () => 'HOLD' as const,
  );
  return [...padding, ...actions];
}

export function RecommendationTab({ t, demo }: { t: SampleTicker; demo: boolean }): JSX.Element {
  const [live, setLive] = useState<Recommendation | null>(null);
  const [history, setHistory] = useState<VerdictAction[]>(t.recommendation.history);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<boolean>(false);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      fetch(buildRecommendationLatestUrl(t.symbol))
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return RecommendationSchema.parse((await r.json()) as RecommendationLatestResponse);
        }),
      fetch(buildRecommendationHistoryUrl(t.symbol))
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = (await r.json()) as RecommendationHistoryResponse;
          return body.items.map((x) => RecommendationSchema.parse(x));
        }),
    ])
      .then(([latest, rows]) => {
        if (cancelled) return;
        setLive(latest);
        setHistory(toHistory(rows.map((x) => x.equity.action)));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [demo, t.symbol]);

  useEffect(() => {
    if (demo) return;
    const events = new EventSource('/api/events');
    const onUpdate = (evt: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(evt.data) as RecommendationEventPayload;
        if (payload.type !== 'recommendation.update') return;
        if (payload.symbol.toUpperCase() !== t.symbol.toUpperCase()) return;
        const parsed = RecommendationSchema.parse(payload.recommendation);
        setLive(parsed);
        setHistory((prev) => toHistory([...prev, parsed.equity.action]));
        setPulse(true);
      } catch {
        // Ignore malformed events.
      }
    };
    events.addEventListener('recommendation.update', onUpdate as EventListener);
    return () => {
      events.removeEventListener('recommendation.update', onUpdate as EventListener);
      events.close();
    };
  }, [demo, t.symbol]);

  useEffect(() => {
    if (!pulse) return;
    const timer = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(timer);
  }, [pulse]);

  const view = useMemo(() => {
    if (!live) return t.recommendation;
    return {
      equity: live.equity,
      options: live.options,
      riskFlags: live.riskFlags,
      history,
    };
  }, [history, live, t.recommendation]);

  async function recomputeNow(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(buildRecommendationRecomputeUrl(t.symbol), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as RecomputeResponse;
      const parsed = RecommendationSchema.parse(body.recommendation);
      setLive(parsed);
      setHistory((prev) => toHistory([...prev, parsed.equity.action]));
      setPulse(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const recommendation = view;

  return (
    <AiCard label="REC">
      {!demo && (
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              void recomputeNow();
            }}
            disabled={busy}
            className="px-2.5 py-1 text-xs rounded border border-border-subtle hover:border-ai/60 disabled:opacity-60"
          >
            {busy ? 'Recomputing…' : 'Recompute now'}
          </button>
          {error && <div className="text-[11px] text-warn">{error}</div>}
        </div>
      )}
      <div
        className={`grid md:grid-cols-2 gap-3 ${pulse ? 'recommendation-update-pulse' : ''}`}
      >
        <VerdictBlock title="Equity" v={recommendation.equity} />
        <VerdictBlock title="Covered Call" v={recommendation.options.coveredCall} naReason="no chain" />
        <VerdictBlock title="Covered Put" v={recommendation.options.coveredPut} naReason="no chain" />
        <VerdictBlock
          title="Naked Call"
          v={recommendation.options.nakedCall}
          naReason="naked shorts disabled"
        />
        <VerdictBlock
          title="Naked Put"
          v={recommendation.options.nakedPut}
          naReason="naked shorts disabled"
        />
      </div>
      {recommendation.riskFlags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {recommendation.riskFlags.map((f) => (
            <span
              key={f}
              className="px-2 py-0.5 rounded bg-warn/10 text-warn text-[10px] font-mono tracking-wider"
            >
              ⚠ {f}
            </span>
          ))}
        </div>
      )}
      {!demo && live && live.sources.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1">
            Sources used
          </div>
          <ul className="list-disc ml-5 text-xs text-fg-secondary space-y-0.5">
            {live.sources.map((s) => (
              <li key={`${s.name}:${s.url}`}>
                <a className="hover:text-ai" href={s.url} target="_blank" rel="noreferrer">
                  {s.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          30-day verdict history
        </div>
        <div className="flex gap-0.5">
          {recommendation.history.map((v, i) => (
            <div
              key={`${v}-${i}`}
              className={`h-4 w-2 ${verdictColor(v as VerdictAction)}`}
              title={`${30 - i}d ago · ${v}`}
            />
          ))}
        </div>
      </div>
      <AiDisclaimer marginTop="md" />
    </AiCard>
  );
}
