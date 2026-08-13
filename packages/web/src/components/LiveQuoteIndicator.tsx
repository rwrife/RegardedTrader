import React, { useEffect, useState } from 'react';

const REGULAR_CADENCE_MS = 10_000;
const OFF_HOURS_CADENCE_MS = 60_000;
const STALE_MULTIPLIER = 2;

function expectedCadenceMs(marketState: string | null | undefined): number {
  return marketState === 'REGULAR' ? REGULAR_CADENCE_MS : OFF_HOURS_CADENCE_MS;
}

interface LiveQuoteIndicatorProps {
  lastUpdatedAt: Date | null;
  isLoading: boolean;
  error: string | null;
  marketState?: string | null;
}

/**
 * Tiny "updated Ns ago" badge that lives in the price box. Re-renders once
 * a second to keep the label fresh, and translates the well-known "no
 * provider" 503 into an actionable hint. Extracted from App.tsx in #112.
 */
export function LiveQuoteIndicator({
  lastUpdatedAt,
  isLoading,
  error,
  marketState,
}: LiveQuoteIndicatorProps): JSX.Element {
  // Re-render once a second so the "updated Xs ago" label stays fresh even
  // when nothing else in the parent changes.
  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (error) {
    // Surface the "please configure a provider" 503 with an actionable hint
    // rather than the generic "live quote error" badge.
    const needsProvider = /no market-data provider/i.test(error);
    if (needsProvider) {
      return (
        <span
          className="text-[10px] font-mono tracking-wider text-down"
          title={error}
          aria-label="market-data provider not configured"
        >
          ⚠ configure provider in Settings
        </span>
      );
    }
    return (
      <span
        className="text-[10px] font-mono tracking-wider text-down"
        title={error}
        aria-label={`live quote error: ${error}`}
      >
        ⚠ live quote error
      </span>
    );
  }
  if (!lastUpdatedAt) {
    return (
      <span className="text-[10px] font-mono tracking-wider text-fg-muted">
        {isLoading ? 'loading…' : 'waiting…'}
      </span>
    );
  }
  const ageMs = Date.now() - lastUpdatedAt.getTime();
  const secs = Math.max(0, Math.floor(ageMs / 1000));
  const staleAfterMs = expectedCadenceMs(marketState) * STALE_MULTIPLIER;
  const stale = ageMs > staleAfterMs;
  return (
    <span className="inline-flex items-center gap-1">
      {stale && (
        <span
          data-testid="live-quote-stale-dot"
          className="inline-block h-1.5 w-1.5 rounded-full bg-warn"
          aria-label="quote updates stale"
          title={`stale (> ${Math.floor(staleAfterMs / 1000)}s cadence window)`}
        />
      )}
      <span
        className={`text-[10px] font-mono tracking-wider ${isLoading ? 'text-ai' : 'text-fg-muted'}`}
        aria-label={`updated ${secs} seconds ago`}
      >
        {isLoading ? 'live · refreshing…' : `live · updated ${secs}s ago`}
      </span>
    </span>
  );
}
