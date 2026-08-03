import React, { useEffect, useState } from 'react';

interface CalendarEvent {
  dateOffset: number;
  kind: string;
  title: string;
}

/**
 * Sidebar calendar widget: small "next 14 days" list with color-coded dots
 * for earnings vs. market events. Extracted from App.tsx in #112.
 * Fetches real upcoming market events from GET /calendar/upcoming.
 */
export function CalendarStrip(): JSX.Element {
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    fetch('/calendar/upcoming?days=14')
      .then((r) => r.json())
      .then((data: { events: CalendarEvent[] }) => {
        if (Array.isArray(data.events)) setEvents(data.events);
      })
      .catch(() => {/* server may not be up yet; leave empty */});
  }, []);

  return (
    <div className="border border-border-subtle bg-surface rounded p-3">
      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-2">
        Next 14 days
      </h3>
      <ul className="space-y-1.5 text-xs">
        {events.length === 0 ? (
          <li className="text-fg-muted">No upcoming market events</li>
        ) : (
          events.map((ev, i) => {
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
          })
        )}
      </ul>
    </div>
  );
}
