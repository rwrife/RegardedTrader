/**
 * `useLiveQuote(symbol)` — polls `/api/tickers/:symbol/quote` on a cadence
 * driven by the latest response's `marketState` (or a calendar fallback when
 * the field is missing).
 *
 * Implementation notes:
 *
 * - We use a recursive `setTimeout` chain (not `setInterval`). The next tick
 *   is only scheduled after the prior fetch settles, which prevents request
 *   pile-up on slow networks and keeps the cadence honest.
 * - Polling pauses when the document is hidden (`visibilitychange`) and
 *   resumes on visible — no work happens in a background tab.
 * - Cancelled on unmount via a `cancelled` flag + clearTimeout; we never
 *   call `setState` after teardown.
 * - All wire payloads are validated against the shared `QuoteSchema` so the
 *   hook can never hand bogus shapes to the UI.
 */
import { useEffect, useRef, useState } from 'react';
import { QuoteSchema, type LiveQuote } from '@regardedtrader/core/schemas';
import { isUsMarketOpen } from '@regardedtrader/core/marketHours';

const INTERVAL_MARKET_MS = 10_000;
const INTERVAL_OFF_HOURS_MS = 60_000;

export interface UseLiveQuoteResult {
  quote: LiveQuote | null;
  isLoading: boolean;
  error: string | null;
  lastUpdatedAt: Date | null;
}

export interface UseLiveQuoteOptions {
  /** Override fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Override base URL prefix; defaults to `/api`. */
  base?: string;
  /** Disable polling entirely (e.g. demo mode). */
  enabled?: boolean;
}

function intervalFor(quote: LiveQuote | null): number {
  if (quote?.marketState === 'REGULAR') return INTERVAL_MARKET_MS;
  if (quote?.marketState) return INTERVAL_OFF_HOURS_MS;
  // No quote yet — fall back to calendar so the first tick still picks a sane
  // cadence even before the response lands.
  return isUsMarketOpen() ? INTERVAL_MARKET_MS : INTERVAL_OFF_HOURS_MS;
}

export function useLiveQuote(
  symbol: string | null | undefined,
  opts: UseLiveQuoteOptions = {},
): UseLiveQuoteResult {
  const { fetchImpl, base = '/api', enabled = true } = opts;
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  // Track the latest quote without re-binding the polling effect each render.
  const quoteRef = useRef<LiveQuote | null>(null);
  quoteRef.current = quote;

  useEffect(() => {
    if (!enabled || !symbol) return;
    const f = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // Pause when tab is hidden; visibilitychange listener (below) will
      // re-prime the chain when the tab becomes visible again.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      setIsLoading(true);
      try {
        const res = await f(`${base}/tickers/${encodeURIComponent(symbol)}/quote`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as unknown;
        const parsed = QuoteSchema.parse(raw);
        if (cancelled) return;
        setQuote(parsed);
        setError(null);
        setLastUpdatedAt(new Date());
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'unknown error');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
      if (cancelled) return;
      const delay = intervalFor(quoteRef.current);
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    const onVisibility = (): void => {
      if (cancelled) return;
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        // Resume immediately when the tab regains focus.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void tick();
      } else {
        // Hidden — cancel the pending wakeup so we don't fire while hidden.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [symbol, enabled, fetchImpl, base]);

  return { quote, isLoading, error, lastUpdatedAt };
}
