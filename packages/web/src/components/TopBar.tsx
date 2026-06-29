import React from 'react';
import { MarketPill } from './MarketPill.js';

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
