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
import { streamUrl } from '../api.js';

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
  /** Transport selector. Defaults to HTTP polling for compatibility. */
  transport?: 'http' | 'ws';
  /** Disable polling entirely (e.g. demo mode). */
  enabled?: boolean;
  /** Optional WebSocket factory override (tests). */
  createWebSocket?: (url: string) => WebSocket;
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
  const {
    fetchImpl,
    base = '/api',
    enabled = true,
    transport = 'http',
    createWebSocket,
  } = opts;
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
    if (transport === 'http' && !f) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (!f) return;
      // Pause when tab is hidden; visibilitychange listener (below) will
      // re-prime the chain when the tab becomes visible again.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      setIsLoading(true);
      let next: LiveQuote | null = quoteRef.current;
      try {
        const res = await f(`${base}/tickers/${encodeURIComponent(symbol)}/quote`);
        if (!res.ok) {
          // Try to surface the server's structured error message (e.g. the
          // 503 "No market-data provider configured" we emit from /api/...).
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body && typeof body.error === 'string') detail = body.error;
          } catch {
            /* non-JSON body — keep the status code as the message */
          }
          throw new Error(detail);
        }
        const raw = (await res.json()) as unknown;
        const parsed = QuoteSchema.parse(raw);
        if (cancelled) return;
        next = parsed;
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
      // Use the freshly-fetched quote (not quoteRef.current) since React
      // hasn't re-rendered yet between setState and this line, so the ref
      // would still hold the stale previous value.
      const delay = intervalFor(next);
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    const startWebSocket = (): void => {
      const wsFactory = createWebSocket ?? ((url: string) => new WebSocket(url));
      socket = wsFactory(streamUrl(base));
      socket.addEventListener('open', () => {
        socket?.send(
          JSON.stringify({
            type: 'sub',
            channel: 'quote',
            symbol: symbol.toUpperCase(),
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(String(event.data)) as unknown;
          if (!parsed || typeof parsed !== 'object') return;
          const payload = parsed as { type?: string; data?: unknown };
          if (payload.type !== 'quote') return;
          const validated = QuoteSchema.parse(payload.data);
          setQuote(validated);
          setError(null);
          setLastUpdatedAt(new Date());
          setIsLoading(false);
        } catch (error) {
          setError(error instanceof Error ? error.message : 'unknown error');
        }
      });
      socket.addEventListener('error', () => {
        if (!cancelled) setError('WebSocket stream error');
      });
    };

    const onVisibility = (): void => {
      if (cancelled) return;
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        if (transport === 'ws') {
          if (!socket || socket.readyState === socket.CLOSED) {
            startWebSocket();
          }
          return;
        }
        // Resume immediately when the tab regains focus.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void tick();
      } else {
        if (transport === 'ws') {
          socket?.close();
          socket = null;
          return;
        }
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

    if (transport === 'ws') {
      setIsLoading(true);
      startWebSocket();
    } else {
      void tick();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try {
          socket.send(
            JSON.stringify({
              type: 'unsub',
              channel: 'quote',
              symbol: symbol.toUpperCase(),
            }),
          );
        } catch {
          // no-op
        }
        socket.close();
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [symbol, enabled, fetchImpl, base, transport, createWebSocket]);

  return { quote, isLoading, error, lastUpdatedAt };
}
