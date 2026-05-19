/**
 * `CandleChart` — pure-SVG candlestick + volume chart with no third-party
 * deps. Kept intentionally simple: scales fit the visible window, up/down
 * candles are colored, and a volume pane lives below the price pane.
 *
 * The component is dumb: callers supply the OHLCV rows; the parent
 * (`ChartTab`) is in charge of choosing demo vs. live data and of picking
 * the day range.
 */
import React from 'react';

export interface Candle {
  /** ISO date (YYYY-MM-DD) if known. Optional so demo fixtures still work. */
  t?: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleChartProps {
  candles: Candle[];
  width?: number;
  height?: number;
  /** Height of the volume pane in user-units (subtracted from total). */
  volumeHeight?: number;
  /** Optional className for the root <svg>. */
  className?: string;
}

export function CandleChart({
  candles,
  width = 720,
  height = 320,
  volumeHeight = 70,
  className,
}: CandleChartProps): React.ReactElement {
  if (candles.length === 0) {
    return (
      <div
        className="text-fg-muted text-xs text-center py-12"
        role="img"
        aria-label="No chart data"
      >
        No chart data.
      </div>
    );
  }

  // --- Layout ---------------------------------------------------------------
  const padL = 44; // left price/volume axis labels
  const padR = 8;
  const padT = 8;
  const padB = 18; // bottom date labels
  const gap = 6;
  const priceH = Math.max(60, height - volumeHeight - padT - padB - gap);
  const volTop = padT + priceH + gap;
  const volH = volumeHeight;
  const plotW = width - padL - padR;

  // --- Scales ---------------------------------------------------------------
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const pMin = Math.min(...lows);
  const pMax = Math.max(...highs);
  const pPad = (pMax - pMin) * 0.05 || 1;
  const yPriceMin = pMin - pPad;
  const yPriceMax = pMax + pPad;
  const priceToY = (p: number): number =>
    padT + priceH - ((p - yPriceMin) / (yPriceMax - yPriceMin)) * priceH;

  const vMax = Math.max(...candles.map((c) => c.v), 1);
  const volToH = (v: number): number => (v / vMax) * volH;

  const n = candles.length;
  // Reserve a small horizontal gap between candles; aim for ~70% body coverage.
  const slotW = plotW / n;
  const bodyW = Math.max(1, slotW * 0.7);

  // --- Axis helpers ---------------------------------------------------------
  const priceTicks = 4;
  const priceTickValues = Array.from({ length: priceTicks + 1 }, (_, i) =>
    yPriceMin + ((yPriceMax - yPriceMin) * i) / priceTicks,
  );

  const fmtPrice = (p: number): string =>
    Math.abs(p) >= 1000 ? p.toFixed(0) : p.toFixed(2);
  const fmtVol = (v: number): string => {
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return `${v}`;
  };
  const fmtDate = (iso?: string): string => {
    if (!iso) return '';
    // YYYY-MM-DD → MM/DD
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[2]}/${m[3]}` : iso;
  };

  // Pick up to 4 evenly-spaced x-axis labels so things don't crowd.
  const xLabelCount = Math.min(4, n);
  const xLabelStep = xLabelCount > 1 ? Math.max(1, Math.floor((n - 1) / (xLabelCount - 1))) : 1;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className ?? 'w-full h-full'}
      role="img"
      aria-label={`Candlestick chart of last ${n} sessions`}
    >
      {/* Price gridlines + Y-axis labels */}
      {priceTickValues.map((p, i) => {
        const y = priceToY(p);
        return (
          <g key={`pt-${i}`}>
            <line
              x1={padL}
              x2={width - padR}
              y1={y}
              y2={y}
              stroke="currentColor"
              className="text-border-subtle"
              strokeWidth={0.5}
            />
            <text
              x={padL - 4}
              y={y + 3}
              textAnchor="end"
              className="fill-current text-fg-muted"
              style={{ fontSize: 9 }}
            >
              {fmtPrice(p)}
            </text>
          </g>
        );
      })}

      {/* Candles */}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const cls = up ? 'text-up' : 'text-down';
        const xCenter = padL + slotW * (i + 0.5);
        const xBody = xCenter - bodyW / 2;
        const yHigh = priceToY(c.h);
        const yLow = priceToY(c.l);
        const yOpen = priceToY(c.o);
        const yClose = priceToY(c.c);
        const yBodyTop = Math.min(yOpen, yClose);
        const yBodyBot = Math.max(yOpen, yClose);
        const bodyH = Math.max(1, yBodyBot - yBodyTop);
        return (
          <g key={`c-${i}`} className={cls}>
            <line
              x1={xCenter}
              x2={xCenter}
              y1={yHigh}
              y2={yLow}
              stroke="currentColor"
              strokeWidth={1}
            />
            <rect
              x={xBody}
              y={yBodyTop}
              width={bodyW}
              height={bodyH}
              fill="currentColor"
              opacity={up ? 0.85 : 1}
            />
          </g>
        );
      })}

      {/* Volume pane separator */}
      <line
        x1={padL}
        x2={width - padR}
        y1={volTop - gap / 2}
        y2={volTop - gap / 2}
        stroke="currentColor"
        className="text-border-subtle"
        strokeWidth={0.5}
      />
      {/* Volume Y-axis label (peak only — keeps the pane uncluttered) */}
      <text
        x={padL - 4}
        y={volTop + 8}
        textAnchor="end"
        className="fill-current text-fg-muted"
        style={{ fontSize: 9 }}
      >
        {fmtVol(vMax)}
      </text>

      {/* Volume bars (colored by that day's candle direction) */}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const cls = up ? 'text-up' : 'text-down';
        const xCenter = padL + slotW * (i + 0.5);
        const xBody = xCenter - bodyW / 2;
        const h = volToH(c.v);
        const y = volTop + (volH - h);
        return (
          <rect
            key={`v-${i}`}
            x={xBody}
            y={y}
            width={bodyW}
            height={h}
            className={cls}
            fill="currentColor"
            opacity={0.55}
          />
        );
      })}

      {/* X-axis date labels */}
      {Array.from({ length: xLabelCount }, (_, i) => {
        const idx = Math.min(n - 1, i * xLabelStep);
        const c = candles[idx];
        if (!c) return null;
        const x = padL + slotW * (idx + 0.5);
        return (
          <text
            key={`x-${i}`}
            x={x}
            y={height - 4}
            textAnchor="middle"
            className="fill-current text-fg-muted"
            style={{ fontSize: 9 }}
          >
            {fmtDate(c.t) || `${idx + 1}`}
          </text>
        );
      })}
    </svg>
  );
}
