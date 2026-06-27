import React, { useMemo } from 'react';
import type { SampleTicker } from '../sample-data.js';
import { useLiveQuote } from '../hooks/useLiveQuote.js';
import { computeRating } from '@regardedtrader/core/rating';
import { RatingBadge } from './RatingBadge.js';
import { LiveQuoteIndicator } from './LiveQuoteIndicator.js';

/**
 * The big price/indicators header at the top of the main column. Renders
 * live price + change, RSI/SMA/ATR/Vol, an "earnings in Nd" warning pill,
 * the AI rating badge, and the `LiveQuoteIndicator`. Extracted from
 * App.tsx in #112.
 */
export function QuoteHeader({
  t,
  demo,
}: {
  t: SampleTicker;
  demo: boolean;
}): JSX.Element {
  // Live quote (#81): polls the local server when the backend is reachable;
  // falls back to the static sample data in demo mode.
  const live = useLiveQuote(t.symbol, { enabled: !demo });
  const price = live.quote?.price ?? t.quote.price;
  const change = live.quote?.change ?? t.quote.change;
  const changePercent = live.quote?.changePercent ?? t.quote.changePercent;
  const up = change >= 0;
  const toneText = up ? 'text-up' : 'text-down';
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '';
  // Rating (#82): prefer the live server-computed rating; fall back to a
  // locally-computed one from the sample-data signals so the badge stays
  // visible in demo mode.
  const rating = useMemo(() => {
    if (live.quote?.rating) return live.quote.rating;
    return computeRating({
      symbol: t.symbol,
      changePercent,
      rsi: t.indicators.rsi14,
    });
  }, [live.quote?.rating, t.symbol, t.indicators.rsi14, changePercent]);
  return (
    <div className="border border-border-subtle bg-surface rounded p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-4 flex-wrap">
          <div className="flex items-baseline gap-3">
            <span className="text-xl font-semibold tracking-tight">{t.symbol}</span>
            <span className="text-xs text-fg-muted">{t.name}</span>
          </div>
          <span className={`num text-2xl ${toneText}`}>${price.toFixed(2)}</span>
          <span className={`num text-sm ${toneText}`}>
            {arrow} {sign}
            {change.toFixed(2)} ({sign}
            {changePercent.toFixed(2)}%)
          </span>
          {!demo && (
            <LiveQuoteIndicator
              lastUpdatedAt={live.lastUpdatedAt}
              isLoading={live.isLoading}
              error={live.error}
            />
          )}
          {t.earnings.daysUntil !== null && t.earnings.daysUntil <= 14 && (
            <span className="px-2 py-0.5 rounded bg-warn/10 text-warn text-[10px] font-mono tracking-wider">
              EARNINGS IN {t.earnings.daysUntil}D · {t.earnings.when.toUpperCase()}
            </span>
          )}
        </div>
        {/* Rating badge (#82) — top-right of the price box. */}
        <RatingBadge rating={rating} className="mt-0.5 shrink-0" />
      </div>
      <div className="mt-3 flex gap-5 text-xs text-fg-secondary num">
        <span>
          RSI <span className="text-fg">{t.indicators.rsi14.toFixed(1)}</span>
        </span>
        <span>
          SMA20 <span className="text-fg">{t.indicators.sma20.toFixed(2)}</span>
        </span>
        <span>
          SMA50 <span className="text-fg">{t.indicators.sma50.toFixed(2)}</span>
        </span>
        <span>
          ATR <span className="text-fg">{t.indicators.atr14.toFixed(2)}</span>
        </span>
        <span>
          Vol <span className="text-fg">{(t.quote.volume / 1e6).toFixed(1)}M</span>
        </span>
        <span className="ml-auto">
          Day <span className="text-fg">${t.quote.dayLow.toFixed(2)}</span>
          {' – '}
          <span className="text-fg">${t.quote.dayHigh.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}
