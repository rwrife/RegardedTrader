import React, { useEffect, useState } from 'react';
import { formatEventTimeLabel, type CalendarEventWire } from '../calendar-format.js';

interface CalendarWindowWire {
  fromEt: string;
  toEtExclusive: string;
  days: number;
  events: CalendarEventWire[];
}

interface CalendarStripDay {
  key: string;
  market: CalendarEventWire[];
  earnings: CalendarEventWire[];
}

const LOCAL_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const ET_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
});

function dayKeyLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function buildDays(events: ReadonlyArray<CalendarEventWire>): CalendarStripDay[] {
  const map = new Map<string, CalendarStripDay>();
  for (const ev of events) {
    const key = dayKeyLocal(ev.startUtc);
    const bucket = map.get(key) ?? { key, market: [], earnings: [] };
    if (ev.kind === 'earnings') bucket.earnings.push(ev);
    if (ev.kind === 'market_holiday' || ev.kind === 'market_early_close') bucket.market.push(ev);
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Sidebar calendar widget: small "next 14 days" list with color-coded dots
 * for earnings vs. market events. Extracted from App.tsx in #112.
 * Fetches watchlist+market events from GET /calendar/events.
 */
export function CalendarStrip(): JSX.Element {
  const [days, setDays] = useState<CalendarStripDay[]>([]);

  useEffect(() => {
    fetch('/calendar/events?days=14')
      .then((r) => r.json())
      .then((data: CalendarWindowWire) => {
        if (Array.isArray(data.events)) setDays(buildDays(data.events));
      })
      .catch(() => {/* server may not be up yet; leave empty */});
  }, []);

  return (
    <div className="border border-border-subtle bg-surface rounded p-3">
      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-2">
        Next 14 days
      </h3>
      <ul className="space-y-1.5 text-xs">
        {days.length === 0 ? (
          <li className="text-fg-muted">No upcoming market events</li>
        ) : (
          days.map((day) => {
            const sample = day.market[0] ?? day.earnings[0];
            if (!sample) return null;
            const localDay = LOCAL_DAY.format(new Date(sample.startUtc));
            const etDay = `${ET_DAY.format(new Date(sample.startUtc))} ET`;
            return (
              <li key={day.key} className="flex items-start gap-2 py-0.5">
                <span className="num text-fg-muted w-16 shrink-0" title={etDay}>
                  {localDay}
                </span>
                <div className="flex-1 min-w-0 space-y-1">
                  {day.market.map((ev) => (
                    <div
                      key={ev.id}
                      data-testid="calendar-strip-market-bar"
                      className={`truncate rounded px-1.5 py-0.5 ${
                        ev.kind === 'market_holiday'
                          ? 'bg-down/10 text-down'
                          : 'bg-warn/10 text-warn'
                      }`}
                      title={`${formatEventTimeLabel(ev.startUtc).label} (local)\n${formatEventTimeLabel(
                        ev.startUtc,
                      ).etLabel}`}
                    >
                      {ev.title}
                    </div>
                  ))}
                  {day.earnings.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {day.earnings.map((ev) => {
                        const symbol = ev.symbol ?? '—';
                        const time = formatEventTimeLabel(ev.startUtc);
                        return (
                          <span
                            key={ev.id}
                            data-testid="calendar-strip-earnings-dot"
                            className="inline-flex items-center gap-1 rounded-full bg-ai/10 text-ai px-1.5 py-0.5"
                            title={`${ev.title}\n${time.label} (local)\n${time.etLabel}`}
                          >
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-ai" />
                            <span className="num text-[10px]">{symbol}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
