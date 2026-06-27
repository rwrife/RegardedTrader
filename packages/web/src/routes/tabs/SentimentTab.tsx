import React from 'react';
import type { SampleTicker } from '../../sample-data.js';
import { AiCard } from '../../components/primitives/AiCard.js';
import { Sparkline } from '../../components/primitives/Sparkline.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

/**
 * Sentiment tab: aggregate score bar + 24h sparkline + per-source
 * breakdown + recent-mentions list. Extracted from App.tsx in #112.
 */
export function SentimentTab({ t }: { t: SampleTicker }): JSX.Element {
  const s = t.sentiment;
  const pct = ((s.score + 1) / 2) * 100;
  const color = s.score >= 0.1 ? 'bg-up' : s.score <= -0.1 ? 'bg-down' : 'bg-fg-secondary';
  return (
    <AiCard label="SENTIMENT">
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
            Aggregate · {s.volume.toLocaleString()} mentions · conf{' '}
            {(s.confidence * 100).toFixed(0)}%
          </span>
          <span className={`num text-lg ${s.score >= 0 ? 'text-up' : 'text-down'}`}>
            {s.score >= 0 ? '+' : ''}
            {s.score.toFixed(2)}
          </span>
        </div>
        <div className="h-1.5 bg-surface-2 rounded overflow-hidden relative">
          <div className="absolute inset-y-0 left-1/2 w-px bg-border-subtle" />
          <div
            className={`h-full ${color}`}
            style={{
              width: `${Math.abs(pct - 50)}%`,
              marginLeft: pct < 50 ? `${pct}%` : '50%',
            }}
          />
        </div>
      </div>

      <div className="mb-4">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          24h sparkline
        </div>
        <Sparkline values={s.sparkline} />
      </div>

      <div className="grid grid-cols-5 gap-2 text-xs">
        {Object.entries(s.bySource).map(([src, b]) => (
          <div key={src} className="border border-border-subtle rounded p-2">
            <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
              {src}
            </div>
            <div className={`num text-sm ${b.score >= 0 ? 'text-up' : 'text-down'}`}>
              {b.score >= 0 ? '+' : ''}
              {b.score.toFixed(2)}
            </div>
            <div className="text-[10px] text-fg-muted num">
              {b.volume.toLocaleString()} mentions
            </div>
          </div>
        ))}
      </div>

      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mt-5 mb-2">
        Recent mentions
      </h3>
      <ul className="space-y-2 text-sm">
        {t.mentions.map((m) => (
          <li key={m.id} className="border border-border-subtle/60 rounded p-2">
            <div className="flex items-baseline gap-2 text-[11px] text-fg-muted">
              <span className="font-mono uppercase">{m.source}</span>
              <span>· {m.publishedAtMinutesAgo}m ago</span>
              <span className={`ml-auto num ${m.score >= 0 ? 'text-up' : 'text-down'}`}>
                {m.score >= 0 ? '+' : ''}
                {m.score.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 leading-relaxed">{m.body}</div>
          </li>
        ))}
      </ul>
      <AiDisclaimer marginTop="md" />
    </AiCard>
  );
}
