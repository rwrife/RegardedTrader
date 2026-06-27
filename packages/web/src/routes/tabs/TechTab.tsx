import React, { useEffect, useState } from 'react';
import type { SampleTicker } from '../../sample-data.js';
import { AiCard } from '../../components/primitives/AiCard.js';
import { Section } from '../../components/primitives/Section.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

interface TechnicianOutput {
  trend: string;
  momentum: string;
  volatility: string;
  keyLevels: number[];
  commentary: string;
}

/**
 * Live Technician agent tab. Fetches `GET /api/technician/:symbol` when the
 * backend is reachable; falls back to a demo-mode message when it's not.
 * Extracted from App.tsx in #112.
 */
export function TechTab({ t, demo }: { t: SampleTicker; demo: boolean }): JSX.Element {
  const [data, setData] = useState<TechnicianOutput | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setErr(null);
    if (demo) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/technician/${encodeURIComponent(t.symbol)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as TechnicianOutput;
        if (!cancelled) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t.symbol, demo]);

  if (demo) {
    return (
      <AiCard label="TECH">
        <p className="text-sm text-fg-secondary">
          Live Technician analysis is unavailable in demo mode.
        </p>
        <AiDisclaimer marginTop="md" />
      </AiCard>
    );
  }

  return (
    <AiCard label="TECH">
      {loading && <p className="text-sm text-fg-muted">Analysing {t.symbol}…</p>}
      {err && <p className="text-sm text-down">Could not load Technician output: {err}</p>}
      {data && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-4">
            <Section title="Trend" tone="up" body={data.trend} />
            <Section title="Momentum" tone="up" body={data.momentum} />
            <Section title="Volatility" tone="up" body={data.volatility} />
          </div>
          {data.keyLevels.length > 0 && (
            <div>
              <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
                Key levels
              </div>
              <div className="flex flex-wrap gap-2">
                {data.keyLevels.map((n, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded bg-surface-2 text-xs font-mono num"
                  >
                    {n.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
              Commentary
            </div>
            <p className="text-sm leading-relaxed">{data.commentary}</p>
          </div>
        </div>
      )}
      <AiDisclaimer marginTop="md" />
    </AiCard>
  );
}
