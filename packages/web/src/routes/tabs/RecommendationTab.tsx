import React from 'react';
import type { SampleTicker } from '../../sample-data.js';
import { AiCard } from '../../components/primitives/AiCard.js';
import { VerdictBlock } from '../../components/primitives/VerdictBlock.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

/**
 * Multi-leg recommender tab: one `VerdictBlock` per stance (equity, covered
 * call/put, naked call/put), plus risk-flag pills and a 30-day verdict
 * history strip. Extracted from App.tsx in #112.
 */
export function RecommendationTab({ t }: { t: SampleTicker }): JSX.Element {
  const r = t.recommendation;
  return (
    <AiCard label="REC">
      <div className="grid md:grid-cols-2 gap-3">
        <VerdictBlock title="Equity" v={r.equity} />
        <VerdictBlock title="Covered Call" v={r.options.coveredCall} />
        <VerdictBlock title="Covered Put" v={r.options.coveredPut} />
        <VerdictBlock title="Naked Call" v={r.options.nakedCall} />
        <VerdictBlock title="Naked Put" v={r.options.nakedPut} />
      </div>
      {r.riskFlags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {r.riskFlags.map((f) => (
            <span
              key={f}
              className="px-2 py-0.5 rounded bg-warn/10 text-warn text-[10px] font-mono tracking-wider"
            >
              ⚠ {f}
            </span>
          ))}
        </div>
      )}
      <div className="mt-4">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          30-day verdict history
        </div>
        <div className="flex gap-0.5">
          {r.history.map((v, i) => {
            const c =
              v === 'BUY'
                ? 'bg-up'
                : v === 'SELL'
                  ? 'bg-down'
                  : v === 'AVOID'
                    ? 'bg-down/60'
                    : 'bg-surface-2';
            return <div key={i} className={`h-4 w-2 ${c}`} title={`${30 - i}d ago · ${v}`} />;
          })}
        </div>
      </div>
      <AiDisclaimer marginTop="md" />
    </AiCard>
  );
}
