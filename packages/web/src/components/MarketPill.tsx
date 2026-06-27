import React from 'react';
import { SAMPLE_MARKET_STATE } from '../sample-data.js';

/**
 * Status-bar pill that shows market open/closed and an optional note (e.g.
 * "early close"). Extracted from App.tsx in #112.
 */
export function MarketPill(): JSX.Element {
  const s = SAMPLE_MARKET_STATE;
  const color =
    s.state === 'open' ? 'text-up' : s.state === 'closed' ? 'text-down' : 'text-fg-secondary';
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color.replace('text-', 'bg-')}`} />
      <span className={color}>{s.label}</span>
      {s.note && <span className="text-fg-muted">· {s.note}</span>}
    </span>
  );
}
