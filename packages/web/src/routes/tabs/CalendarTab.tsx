import React from 'react';
import { SAMPLE_CALENDAR, type SampleTicker } from '../../sample-data.js';

/**
 * Per-ticker calendar tab. Filters out earnings events for *other* symbols
 * so the list stays relevant; market-wide events (holidays, early close)
 * always show. Extracted from App.tsx in #112.
 */
export function CalendarTab({ t }: { t: SampleTicker }): JSX.Element {
  const relevant = SAMPLE_CALENDAR.filter(
    (ev) => !('symbol' in ev) || ev.symbol === t.symbol || ev.kind !== 'earnings',
  );
  return (
    <div className="border border-border-subtle bg-surface rounded p-4">
      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-3">
        Upcoming for {t.symbol} + market
      </h3>
      <ul className="space-y-2 text-sm">
        {relevant.map((ev, i) => (
          <li key={i} className="flex items-center gap-3">
            <span className="num text-fg-muted text-xs w-10">+{ev.dateOffset}d</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider ${
                ev.kind === 'earnings'
                  ? 'bg-ai/10 text-ai'
                  : ev.kind === 'market_holiday'
                    ? 'bg-down/10 text-down'
                    : 'bg-warn/10 text-warn'
              }`}
            >
              {ev.kind.replace('market_', '').replace('_', ' ').toUpperCase()}
            </span>
            <span>{ev.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
