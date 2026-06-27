import React, { useEffect, useState } from 'react';

/**
 * Tiny "updated Ns ago" badge that lives in the price box. Re-renders once
 * a second to keep the label fresh, and translates the well-known "no
 * provider" 503 into an actionable hint. Extracted from App.tsx in #112.
 */
export function LiveQuoteIndicator({
  lastUpdatedAt,
  isLoading,
  error,
}: {
  lastUpdatedAt: Date | null;
  isLoading: boolean;
  error: string | null;
}): JSX.Element {
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
  const secs = Math.max(0, Math.floor((Date.now() - lastUpdatedAt.getTime()) / 1000));
  return (
    <span
      className={`text-[10px] font-mono tracking-wider ${isLoading ? 'text-ai' : 'text-fg-muted'}`}
      aria-label={`updated ${secs} seconds ago`}
    >
      {isLoading ? '↻ refreshing…' : `updated ${secs}s ago`}
    </span>
  );
}
