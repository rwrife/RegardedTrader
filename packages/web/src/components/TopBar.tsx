import React, { useEffect, useState } from 'react';
import { MarketPill } from './MarketPill.js';

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

/**
 * Thin status bar at the top of the dashboard. Shows the local server
 * address, market state, demo-mode badge, current UTC time, and a settings
 * shortcut. Extracted from App.tsx in #112.
 */
export function TopBar({
  demo,
  onOpenSettings,
  onOpenWatchlist,
}: {
  demo: boolean;
  onOpenSettings: () => void;
  /** Optional: navigate to the dedicated `/watchlist` surface (#167). */
  onOpenWatchlist?: () => void;
}): JSX.Element {
  const version = useServerVersion();
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
        <MarketPill />
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
          <span className="num">{new Date().toUTCString().slice(17, 25)} UTC</span>
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
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
            className="px-1.5 py-0.5 rounded border border-border-subtle text-[12px] hover:text-ai hover:border-ai"
          >
            ⚙
          </button>
          <kbd className="px-1.5 py-0.5 rounded border border-border-subtle text-[10px]">⌘K</kbd>
        </div>
      </div>
    </header>
  );
}
