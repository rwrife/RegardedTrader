import React from 'react';
import type { SampleVerdict } from '../../sample-data.js';

/** Map a recommender verdict action to its tone color class. */
export function verdictColor(action: SampleVerdict['action']): string {
  switch (action) {
    case 'BUY':
      return 'text-up';
    case 'SELL':
      return 'text-down';
    case 'AVOID':
      return 'text-down';
    default:
      return 'text-fg-secondary';
  }
}

function verdictIcon(action: SampleVerdict['action']): string {
  if (action === 'BUY') return '▲';
  if (action === 'SELL') return '▼';
  if (action === 'AVOID') return '▼';
  return '•';
}

/**
 * Single recommender verdict tile (equity / covered call / etc.). Renders
 * a "not available" stub when no verdict is provided so the layout stays
 * stable. Extracted from App.tsx in #112.
 */
export function VerdictBlock({
  title,
  v,
  naReason,
}: {
  title: string;
  v: SampleVerdict | null;
  naReason?: string;
}): JSX.Element {
  if (!v) {
    return (
      <div className="border border-border-subtle/60 rounded p-3 text-xs text-fg-muted">
        <div className="font-mono tracking-wider uppercase text-[10px] mb-1">{title}</div>
        <div>
          <span className="uppercase tracking-wider text-[10px] mr-1">n/a</span>
          <span>{naReason ?? 'policy/data gate'}</span>
        </div>
      </div>
    );
  }
  const color = verdictColor(v.action);
  const icon = verdictIcon(v.action);
  const convictionPct = Math.round(v.conviction * 100);
  const topSignals = v.signals.slice(0, 3);
  const topContra = v.contraSignals.slice(0, 3);
  return (
    <div className="border border-border-subtle rounded p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono tracking-wider uppercase text-[10px] text-fg-muted">{title}</div>
        <div className={`text-sm font-semibold ${color}`}>
          <span aria-hidden>{icon}</span> {v.action}{' '}
          <span className="text-fg-muted text-xs num">· {convictionPct}%</span>
        </div>
      </div>
      <div className="mb-2 h-1 rounded bg-surface-2 overflow-hidden" aria-label="conviction">
        <div className="h-full bg-ai" style={{ width: `${convictionPct}%` }} />
      </div>
      <p className="text-xs text-fg leading-relaxed">{v.rationale}</p>
      {(topSignals.length > 0 || topContra.length > 0) && (
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2 text-[11px]">
          <div>
            {topSignals.map((s, i) => {
              const pct = Math.round(Math.min(1, Math.abs(s.contribution)) * 100);
              return (
                <div key={i} className="mb-1.5">
                  <div className="flex justify-between gap-2 num">
                    <span className="text-fg-muted">{s.name}</span>
                    <span className="text-fg-secondary">{String(s.value)}</span>
                    <span className="text-up">+{s.contribution.toFixed(2)}</span>
                  </div>
                  <div className="h-1 rounded bg-surface-2 overflow-hidden">
                    <div className="h-full bg-up/80" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div>
            {topContra.map((s, i) => {
              const pct = Math.round(Math.min(1, Math.abs(s.contribution)) * 100);
              return (
                <div key={i} className="mb-1.5">
                  <div className="flex justify-between gap-2 num">
                    <span className="text-fg-muted">{s.name}</span>
                    <span className="text-fg-secondary">{String(s.value)}</span>
                    <span className="text-down">{s.contribution.toFixed(2)}</span>
                  </div>
                  <div className="h-1 rounded bg-surface-2 overflow-hidden">
                    <div className="h-full bg-down/80" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
