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

/**
 * Single recommender verdict tile (equity / covered call / etc.). Renders
 * a "not available" stub when no verdict is provided so the layout stays
 * stable. Extracted from App.tsx in #112.
 */
export function VerdictBlock({
  title,
  v,
}: {
  title: string;
  v: SampleVerdict | null;
}): JSX.Element {
  if (!v) {
    return (
      <div className="border border-border-subtle/60 rounded p-3 text-xs text-fg-muted">
        <div className="font-mono tracking-wider uppercase text-[10px] mb-1">{title}</div>
        <div>— not available (policy or data gate)</div>
      </div>
    );
  }
  const color = verdictColor(v.action);
  return (
    <div className="border border-border-subtle rounded p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono tracking-wider uppercase text-[10px] text-fg-muted">{title}</div>
        <div className={`text-sm font-semibold ${color}`}>
          {v.action}{' '}
          <span className="text-fg-muted text-xs">· {(v.conviction * 100).toFixed(0)}%</span>
        </div>
      </div>
      <p className="text-xs text-fg leading-relaxed">{v.rationale}</p>
      {(v.signals.length > 0 || v.contraSignals.length > 0) && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            {v.signals.map((s, i) => (
              <div key={i} className="flex justify-between gap-2 num">
                <span className="text-fg-muted">{s.name}</span>
                <span className="text-up">+{s.contribution.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div>
            {v.contraSignals.map((s, i) => (
              <div key={i} className="flex justify-between gap-2 num">
                <span className="text-fg-muted">{s.name}</span>
                <span className="text-down">{s.contribution.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
