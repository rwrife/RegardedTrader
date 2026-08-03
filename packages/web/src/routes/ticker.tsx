import React, { useEffect, useMemo, useState } from 'react';
import type { OHLCV } from '@regardedtrader/core/schemas';
import { TickerChart } from '../components/TickerChart.js';
import { AiDisclaimer } from '../components/AiDisclaimer.js';
import { useHistory } from '../hooks/useHistory.js';
import { findSample } from '../sample-data.js';
import { buildTickerEarningsChip, type CalendarEventWire } from '../calendar-format.js';

export interface TickerRouteProps {
  symbol: string;
  demo: boolean;
  onClose?: () => void;
  fetchImpl?: typeof fetch;
}

export function TickerRoute({
  symbol,
  demo,
  onClose,
  fetchImpl,
}: TickerRouteProps): JSX.Element {
  const hist = useHistory(symbol, 180, { enabled: !demo, fetchImpl });
  const sample = findSample(symbol.toUpperCase());
  const [earningsEvents, setEarningsEvents] = useState<CalendarEventWire[]>([]);

  const candles: OHLCV[] = useMemo(() => {
    if (!demo && hist.rows && hist.rows.length > 0) return hist.rows;
    if (!sample) return [];
    const today = new Date();
    return sample.candles.map((c, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (sample.candles.length - 1 - i));
      return { ...c, t: d.toISOString().slice(0, 10) };
    });
  }, [demo, hist.rows, sample]);

  useEffect(() => {
    if (demo) return;
    const f = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await f(`/calendar/earnings/${encodeURIComponent(symbol)}?past=true&upcoming=true`);
        if (!r.ok) return;
        const data = (await r.json()) as { events?: CalendarEventWire[] };
        if (!cancelled && Array.isArray(data.events)) setEarningsEvents(data.events);
      } catch {
        // Ignore calendar read errors; chart route still works without the chip.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, fetchImpl, symbol]);

  const earningsChip = useMemo(
    () => buildTickerEarningsChip(earningsEvents),
    [earningsEvents],
  );

  return (
    <div className="min-h-screen bg-app text-fg">
      <div className="max-w-7xl mx-auto px-6 py-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight">{symbol.toUpperCase()} chart</h1>
              {earningsChip && (
                <span
                  data-testid="ticker-earnings-chip"
                  title={earningsChip.tooltip}
                  className="px-2 py-0.5 rounded bg-ai/10 text-ai text-[11px] border border-ai/40"
                >
                  {earningsChip.label}
                </span>
              )}
            </div>
            <div className="text-xs text-fg-muted">
              {demo ? 'Demo data' : 'Local market data'} · {candles.length} sessions
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 rounded border border-border-subtle text-sm"
            >
              ← Back
            </button>
          )}
        </header>

        {hist.error && !demo && (
          <div className="text-down text-sm border border-down/30 bg-down/10 rounded p-2">
            history fetch error: {hist.error}
          </div>
        )}
        {hist.isLoading && !demo && (
          <div className="text-fg-muted text-sm">Loading history…</div>
        )}

        {candles.length === 0 ? (
          <div className="border border-border-subtle bg-surface rounded p-4 text-fg-muted">
            No candle data for {symbol.toUpperCase()}.
          </div>
        ) : (
          <TickerChart symbol={symbol.toUpperCase()} candles={candles} />
        )}

        <AiDisclaimer marginTop="none" />
      </div>
    </div>
  );
}
