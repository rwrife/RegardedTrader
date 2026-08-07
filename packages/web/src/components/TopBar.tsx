import React, { useEffect, useState } from 'react';
import { MarketPill } from './MarketPill.js';
import { formatEventTimeLabel } from '../calendar-format.js';

/**
 * Minimal client-side shape of `GET /version` (issue #179). We deliberately
 * keep this as an ambient interface rather than importing the Zod schema
 * from `@regardedtrader/core` so the web bundle doesn't pull node-only
 * modules (`node:fs`/`node:url`) that the core `version.ts` helper touches
 * at import time.
 */
interface ServerVersionPayload {
  server: string;
  core: string;
  node: string;
  api: number;
  startedAt: string;
}

interface UpcomingEvent {
  dateOffset: number;
  kind: string;
  title: string;
  details?: { closeTimeEt?: string } | null;
  startUtc?: string;
}

interface CalendarStatusPayload {
  stale?: boolean;
  marketState?: string;
}

interface MarketPillState {
  label: string;
  note?: string;
  mutedNote?: boolean;
  stale: boolean;
}

const LOCAL_CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function mapMarketStateLabel(raw: string | undefined): string {
  switch (raw) {
    case 'rth':
      return 'Open';
    case 'pre':
      return 'Pre-market';
    case 'post':
      return 'After-hours';
    case 'holiday':
      return 'Holiday';
    case 'closed':
      return 'Closed';
    default:
      return 'Open';
  }
}

function toMarketPillState(
  events: ReadonlyArray<UpcomingEvent>,
  status: CalendarStatusPayload,
): MarketPillState {
  const today = events.find((ev) => ev.dateOffset === 0);
  if (today?.kind === 'market_holiday') {
    return {
      label: mapMarketStateLabel(status.marketState),
      note: today.title,
      mutedNote: true,
      stale: Boolean(status.stale),
    };
  }
  if (today?.kind === 'market_early_close') {
    const closeEt = today.details?.closeTimeEt ?? '13:00';
    return {
      label: mapMarketStateLabel(status.marketState),
      note: `Early close ${closeEt} ET`,
      mutedNote: false,
      stale: Boolean(status.stale),
    };
  }
  return {
    label: mapMarketStateLabel(status.marketState),
    stale: Boolean(status.stale),
  };
}

/**
 * `GET /version` chip loader (issue #179). Fetches once on mount and
 * renders a tiny "srv X.Y.Z \u00b7 core X.Y.Z" pill. On any failure (network,
 * non-200, malformed body) it degrades to "srv ?" \u2014 never red, never a
 * pulse; the chip is neutral chrome, not a data signal.
 */
function useServerVersion(): { label: string; title: string | undefined } {
  const [state, setState] = useState<{ label: string; title: string | undefined }>({
    label: 'srv \u2026',
    title: undefined,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/version');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = (await r.json()) as unknown;
        // Structural check: never trust the wire without a shape guard.
        if (
          raw !== null &&
          typeof raw === 'object' &&
          typeof (raw as { server?: unknown }).server === 'string' &&
          typeof (raw as { core?: unknown }).core === 'string' &&
          typeof (raw as { api?: unknown }).api === 'number'
        ) {
          const v = raw as ServerVersionPayload;
          if (!cancelled) {
            setState({
              label: `srv ${v.server} \u00b7 core ${v.core}`,
              title: `node ${v.node} \u00b7 api ${v.api} \u00b7 started ${v.startedAt}`,
            });
          }
          return;
        }
        throw new Error('malformed /version payload');
      } catch {
        if (!cancelled) setState({ label: 'srv ?', title: '/version unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function useMarketPill(): MarketPillState {
  const [state, setState] = useState<MarketPillState>({
    label: 'Open',
    note: undefined,
    mutedNote: false,
    stale: false,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [upcomingRes, statusRes] = await Promise.all([
          fetch('/calendar/upcoming?days=1'),
          fetch('/calendar/status'),
        ]);
        if (!upcomingRes.ok || !statusRes.ok) throw new Error('calendar unavailable');
        const upcomingRaw = (await upcomingRes.json()) as unknown;
        const statusRaw = (await statusRes.json()) as unknown;
        const events = Array.isArray((upcomingRaw as { events?: unknown }).events)
          ? ((upcomingRaw as { events: UpcomingEvent[] }).events ?? [])
          : [];
        const status: CalendarStatusPayload =
          statusRaw && typeof statusRaw === 'object' ? (statusRaw as CalendarStatusPayload) : {};
        if (!cancelled) setState(toMarketPillState(events, status));
      } catch {
        // Keep default view model when calendar read fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * Thin status bar at the top of the dashboard. Shows the local server
 * address, market state, demo-mode badge, current UTC time, and a settings
 * shortcut. Extracted from App.tsx in #112.
 */
export function TopBar({
  demo,
  onOpenSettings,
  onOpenWatchlist,
  onOpenPaper,
  onOpenPalette,
}: {
  demo: boolean;
  onOpenSettings: () => void;
  /** Optional: navigate to the dedicated `/watchlist` surface (#167). */
  onOpenWatchlist?: () => void;
  /** Optional: navigate to the dedicated paper-trading surface (#103). */
  onOpenPaper?: () => void;
  /** Optional: open the global ⌘K / Ctrl-K command palette. */
  onOpenPalette?: () => void;
}): JSX.Element {
  const version = useServerVersion();
  const market = useMarketPill();
  const now = new Date();
  const localClock = LOCAL_CLOCK.format(now);
  const etClock = `${ET_CLOCK.format(now)} ET`;
  return (
    <header className="border-b border-border-subtle bg-surface">
      <div className="max-w-7xl mx-auto px-6 h-12 flex items-center gap-4 text-xs">
        <div className="flex items-center gap-2 font-semibold">
          <span className="text-up">▲</span>
          <span className="tracking-tight">RegardedTrader</span>
        </div>
        <span className="text-fg-muted">·</span>
        <span className="num text-fg-secondary">local · 127.0.0.1:4317</span>
        <span className="text-fg-muted">·</span>
        <MarketPill
          label={market.label}
          note={market.note}
          mutedNote={market.mutedNote}
          stale={market.stale}
        />
        <span
          data-testid="version-chip"
          title={version.title}
          className="num text-fg-muted text-[10px] px-1.5 py-0.5 rounded border border-border-subtle"
        >
          {version.label}
        </span>
        {demo && (
          <span className="ml-2 px-1.5 py-0.5 rounded bg-ai/10 text-ai text-[10px] font-mono tracking-wider">
            DEMO DATA
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-fg-muted">
          <span
            className="num"
            title={`${formatEventTimeLabel(now.toISOString()).etLabel} · market now ${etClock}`}
          >
            {localClock}
          </span>
          {onOpenWatchlist && (
            <button
              type="button"
              onClick={onOpenWatchlist}
              aria-label="Open watchlist"
              title="Watchlist"
              className="px-1.5 py-0.5 rounded border border-border-subtle text-[11px] hover:text-ai hover:border-ai"
            >
              Watchlist
            </button>
          )}
          {onOpenPaper && (
            <button
              type="button"
              onClick={onOpenPaper}
              aria-label="Open paper trading"
              title="Paper"
              className="px-1.5 py-0.5 rounded border border-warn text-warn text-[11px] hover:opacity-80"
            >
              PAPER
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
            className="px-1.5 py-0.5 rounded border border-border-subtle text-[12px] hover:text-ai hover:border-ai"
          >
            ⚙
          </button>
          {onOpenPalette ? (
            <button
              type="button"
              onClick={onOpenPalette}
              title="Open command palette"
              aria-label="Open command palette"
              className="px-1.5 py-0.5 rounded border border-border-subtle text-[10px] hover:text-ai hover:border-ai focus:outline-none focus-visible:ring-1 focus-visible:ring-ai"
            >
              ⌘K
            </button>
          ) : (
            <kbd className="px-1.5 py-0.5 rounded border border-border-subtle text-[10px]">⌘K</kbd>
          )}
        </div>
      </div>
    </header>
  );
}
