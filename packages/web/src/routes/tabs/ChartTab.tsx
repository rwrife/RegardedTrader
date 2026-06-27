import React, { useMemo, useState } from 'react';
import type { SampleTicker } from '../../sample-data.js';
import { useHistory } from '../../hooks/useHistory.js';
import { CandleChart, type Candle } from '../../components/CandleChart.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';
import { Stat } from '../../components/primitives/Stat.js';

type Range = 30 | 90 | 180;

/**
 * Chart tab: range toggles + today's OHLCV stats strip + the candle chart.
 * Pulls live history from the backend when reachable; falls back to the
 * sample candles (with synthesized dates) in demo mode. Extracted from
 * App.tsx in #112.
 */
export function ChartTab({ t, demo }: { t: SampleTicker; demo: boolean }): JSX.Element {
  const [days, setDays] = useState<Range>(90);
  const history = useHistory(t.symbol, days, { enabled: !demo });

  // Pick the data source: live history when the backend is reachable,
  // otherwise fall back to the sample candles. Sample data is undated, so
  // we synthesize a trailing date series so the X-axis still labels.
  const candles: Candle[] = useMemo(() => {
    if (!demo && history.rows && history.rows.length > 0) {
      const slice = history.rows.slice(-days);
      return slice.map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
    }
    const slice = t.candles.slice(-days);
    const today = new Date();
    return slice.map((c, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (slice.length - 1 - i));
      return { ...c, t: d.toISOString().slice(0, 10) };
    });
  }, [demo, history.rows, days, t.candles]);

  const today = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const change = today && prev ? today.c - prev.c : 0;
  const changePct = today && prev && prev.c !== 0 ? (change / prev.c) * 100 : 0;
  const up = change >= 0;

  // Average volume across the visible window minus today, so today's volume
  // ratio is comparable to a true "recent average".
  const avgVol = useMemo(() => {
    if (candles.length <= 1) return 0;
    const prior = candles.slice(0, -1);
    const sum = prior.reduce((a, c) => a + c.v, 0);
    return sum / prior.length;
  }, [candles]);
  const volRatio = today && avgVol > 0 ? today.v / avgVol : null;

  const fmtVol = (v: number): string => {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return `${v}`;
  };

  const ranges: Range[] = [30, 90, 180];

  return (
    <div className="border border-border-subtle bg-surface rounded p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
          Price & Volume
        </h3>
        <div className="flex items-center gap-1 text-[11px]">
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className={`px-2 py-0.5 rounded border ${
                days === r
                  ? 'border-ai text-ai bg-ai/10'
                  : 'border-border-subtle text-fg-muted hover:text-fg-secondary'
              }`}
              aria-pressed={days === r}
              aria-label={`Show last ${r} days`}
            >
              {r}D
            </button>
          ))}
          {history.isLoading && <span className="ml-2 text-fg-muted">loading…</span>}
          {history.error && !demo && (
            <span
              className="ml-2 text-down"
              title={history.error}
              aria-label={`history fetch error: ${history.error}`}
            >
              ⚠ history error
            </span>
          )}
        </div>
      </div>

      {/* Today's stats strip */}
      {today && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <Stat label="Open" value={`$${today.o.toFixed(2)}`} />
          <Stat label="High" value={`$${today.h.toFixed(2)}`} />
          <Stat label="Low" value={`$${today.l.toFixed(2)}`} />
          <Stat
            label="Close"
            value={`$${today.c.toFixed(2)}`}
            sub={`${up ? '+' : ''}${change.toFixed(2)} (${up ? '+' : ''}${changePct.toFixed(2)}%)`}
            subClass={up ? 'text-up' : 'text-down'}
          />
          <Stat
            label="Volume"
            value={fmtVol(today.v)}
            sub={volRatio !== null ? `${volRatio.toFixed(2)}× avg` : undefined}
            subClass={
              volRatio !== null && volRatio >= 1.25
                ? 'text-up'
                : volRatio !== null && volRatio <= 0.75
                  ? 'text-down'
                  : 'text-fg-muted'
            }
          />
        </div>
      )}

      <div className="w-full">
        <CandleChart candles={candles} className="w-full h-[340px]" />
      </div>

      <AiDisclaimer marginTop="none" />
    </div>
  );
}
