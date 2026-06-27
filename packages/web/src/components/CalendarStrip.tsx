import React from 'react';
import { SAMPLE_CALENDAR } from '../sample-data.js';

/**
 * Sidebar calendar widget: small "next 14 days" list with color-coded dots
 * for earnings vs. market events. Extracted from App.tsx in #112.
 */
export function CalendarStrip(): JSX.Element {
  return (
    <div className="border border-border-subtle bg-surface rounded p-3">
      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-2">
        Next 14 days
      </h3>
      <ul className="space-y-1.5 text-xs">
        {SAMPLE_CALENDAR.map((ev, i) => {
          const dot =
            ev.kind === 'market_holiday'
              ? 'bg-down'
              : ev.kind === 'market_early_close'
                ? 'bg-warn'
                : 'bg-ai';
          return (
            <li key={i} className="flex items-center gap-2">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
              <span className="num text-fg-muted w-8">+{ev.dateOffset}d</span>
              <span className="truncate" title={ev.title}>
                {ev.title}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
