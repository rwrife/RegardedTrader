/**
 * `useHistory(symbol, days)` — fetches `/api/history/:symbol?days=N` and
 * returns the OHLCV rows the chart tab needs. Pure-fetch on mount /
 * dependency change; no polling (intraday candles aren't valuable enough
 * here to justify the request rate, and Yahoo throttles aggressively —
 * see #88).
 */
import { useEffect, useState } from 'react';

export interface HistoryRow {
  t: string; // ISO date (YYYY-MM-DD)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface UseHistoryResult {
  rows: HistoryRow[] | null;
  isLoading: boolean;
  error: string | null;
}

export interface UseHistoryOptions {
  /** Override fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Override base URL prefix; defaults to `/api`. */
  base?: string;
  /** Disable fetching entirely (e.g. demo mode). */
  enabled?: boolean;
}

function isRow(x: unknown): x is HistoryRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.t === 'string' &&
    typeof r.o === 'number' &&
    typeof r.h === 'number' &&
    typeof r.l === 'number' &&
    typeof r.c === 'number' &&
    typeof r.v === 'number'
  );
}

export function useHistory(
  symbol: string | null | undefined,
  days = 90,
  opts: UseHistoryOptions = {},
): UseHistoryResult {
  const { fetchImpl, base = '/api', enabled = true } = opts;
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !symbol) {
      setRows(null);
      return;
    }
    const f = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await f(
          `${base}/history/${encodeURIComponent(symbol)}?days=${days}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as unknown;
        if (cancelled) return;
        if (!Array.isArray(raw) || !raw.every(isRow)) {
          throw new Error('unexpected history payload');
        }
        setRows(raw);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'unknown error');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, days, enabled, fetchImpl, base]);

  return { rows, isLoading, error };
}
