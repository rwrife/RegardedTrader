import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { computeIndicatorSeries } from '@regardedtrader/core/indicators';
import type { OHLCV } from '@regardedtrader/core/schemas';

export interface TickerChartProps {
  symbol: string;
  candles: OHLCV[];
}

type OverlayKey = 'sma20' | 'sma50' | 'ema12' | 'ema26';
type OverlayState = Record<OverlayKey, boolean>;

const CHART_HEIGHT = 340;
const PANE_HEIGHT = 120;
const BG = '#0F1620';
const GRID = '#1f2b3d';
const TEXT = '#94A3B8';
const UP = '#22C55E';
const DOWN = '#EF4444';
const ACCENT = '#22D3EE';
const AMBER = '#F59E0B';

function toTs(t: string): UTCTimestamp {
  return Math.floor(new Date(`${t}T00:00:00Z`).getTime() / 1000) as UTCTimestamp;
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtVol(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString();
}

function createBaseChart(container: HTMLElement, height: number): IChartApi {
  return createChart(container, {
    height,
    layout: {
      background: { color: BG },
      textColor: TEXT,
    },
    grid: {
      vertLines: { color: GRID },
      horzLines: { color: GRID },
    },
    crosshair: { mode: 1 },
    rightPriceScale: {
      borderColor: GRID,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: GRID,
      rightOffset: 4,
      barSpacing: 8,
      minBarSpacing: 4,
      timeVisible: true,
      secondsVisible: false,
    },
    localization: {
      priceFormatter: (price: number) => `$${price.toFixed(2)}`,
    },
  });
}

export function TickerChart({ symbol, candles }: TickerChartProps): JSX.Element {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);
  const macdRef = useRef<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>({
    sma20: true,
    sma50: true,
    ema12: true,
    ema26: true,
  });
  const [hover, setHover] = useState<OHLCV | null>(null);

  const series = useMemo(() => computeIndicatorSeries(candles), [candles]);

  useEffect(() => {
    if (!mainRef.current || !rsiRef.current || !macdRef.current || candles.length === 0) return;

    const mainChart = createBaseChart(mainRef.current, CHART_HEIGHT);
    const rsiChart = createBaseChart(rsiRef.current, PANE_HEIGHT);
    const macdChart = createBaseChart(macdRef.current, PANE_HEIGHT);

    rsiChart.timeScale().applyOptions({ visible: false });
    macdChart.timeScale().applyOptions({ visible: true });

    const candleSeries = mainChart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    const volumeSeries = mainChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: ACCENT,
    });
    mainChart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.72, bottom: 0 },
      borderVisible: false,
    });

    const sma20Series = mainChart.addLineSeries({ color: '#38BDF8', lineWidth: 2 });
    const sma50Series = mainChart.addLineSeries({ color: '#A78BFA', lineWidth: 2 });
    const ema12Series = mainChart.addLineSeries({ color: '#34D399', lineWidth: 1 });
    const ema26Series = mainChart.addLineSeries({ color: '#FB7185', lineWidth: 1 });

    const rsiSeries = rsiChart.addLineSeries({ color: ACCENT, lineWidth: 2 });
    rsiSeries.createPriceLine({
      price: 70,
      color: AMBER,
      lineStyle: 2,
      axisLabelVisible: true,
      title: '70',
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: AMBER,
      lineStyle: 2,
      axisLabelVisible: true,
      title: '30',
    });

    const macdLine = macdChart.addLineSeries({ color: '#22D3EE', lineWidth: 2 });
    const macdSignal = macdChart.addLineSeries({ color: '#F59E0B', lineWidth: 2 });
    const macdHist = macdChart.addHistogramSeries({ priceScaleId: '', base: 0 });

    const candleData: CandlestickData<UTCTimestamp>[] = candles.map((c) => ({
      time: toTs(c.t),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
    const volumeData: HistogramData<UTCTimestamp>[] = candles.map((c) => ({
      time: toTs(c.t),
      value: c.v,
      color: c.c >= c.o ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)',
    }));
    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData);

    const mapLine = (arr: (number | null)[]): LineData<UTCTimestamp>[] =>
      candles.flatMap((c, i) =>
        arr[i] == null ? [] : [{ time: toTs(c.t), value: arr[i] as number }],
      );
    const mapHist = (arr: (number | null)[]): HistogramData<UTCTimestamp>[] =>
      candles.flatMap((c, i) =>
        arr[i] == null
          ? []
          : [
              {
                time: toTs(c.t),
                value: arr[i] as number,
                color:
                  (arr[i] as number) >= 0
                    ? 'rgba(34,197,94,0.55)'
                    : 'rgba(239,68,68,0.55)',
              },
            ],
      );

    sma20Series.setData(mapLine(series.sma20));
    sma50Series.setData(mapLine(series.sma50));
    ema12Series.setData(mapLine(series.ema12));
    ema26Series.setData(mapLine(series.ema26));
    rsiSeries.setData(mapLine(series.rsi14));
    macdLine.setData(mapLine(series.macd));
    macdSignal.setData(mapLine(series.macdSignal));
    macdHist.setData(mapHist(series.macdHistogram));

    const syncRange = (): void => {
      const range = mainChart.timeScale().getVisibleRange();
      if (!range) return;
      rsiChart.timeScale().setVisibleRange(range);
      macdChart.timeScale().setVisibleRange(range);
    };
    mainChart.timeScale().subscribeVisibleTimeRangeChange(syncRange);
    syncRange();

    const overlayMap: Record<OverlayKey, ISeriesApi<'Line'>> = {
      sma20: sma20Series,
      sma50: sma50Series,
      ema12: ema12Series,
      ema26: ema26Series,
    };
    (Object.keys(overlayMap) as OverlayKey[]).forEach((key) => {
      overlayMap[key].applyOptions({ visible: overlay[key] });
    });

    mainChart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.size) {
        setHover(null);
        return;
      }
      const point = param.seriesData.get(candleSeries) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (!point) return;
      const idx = candleData.findIndex((x) => x.time === param.time);
      const matched = idx >= 0 ? candles[idx] : null;
      setHover(
        matched
          ? matched
          : {
              t: '',
              o: point.open,
              h: point.high,
              l: point.low,
              c: point.close,
              v: 0,
            },
      );
    });

    const ro = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width <= 0) return;
      mainChart.applyOptions({ width });
      rsiChart.applyOptions({ width });
      macdChart.applyOptions({ width });
    });
    ro.observe(mainRef.current);

    return () => {
      ro.disconnect();
      mainChart.remove();
      rsiChart.remove();
      macdChart.remove();
    };
  }, [candles, overlay, series]);

  const last = candles[candles.length - 1] ?? null;
  const legend = hover ?? last;
  const lastIdx = candles.length - 1;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px] font-mono tracking-wide uppercase text-fg-muted">
          {symbol} · Candles / Volume · Crosshair enabled
        </div>
        <div className="flex items-center gap-2 text-xs">
          {(Object.keys(overlay) as OverlayKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setOverlay((prev) => ({ ...prev, [key]: !prev[key] }))}
              className={`px-2 py-0.5 rounded border ${
                overlay[key]
                  ? 'border-ai text-ai bg-ai/10'
                  : 'border-border-subtle text-fg-muted'
              }`}
              aria-pressed={overlay[key]}
            >
              {key.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="relative border border-border-subtle bg-surface rounded p-2">
        <div className="absolute left-3 top-2 z-10 text-[11px] font-mono text-fg-secondary bg-app/70 px-2 py-1 rounded">
          O {fmt(legend?.o)} · H {fmt(legend?.h)} · L {fmt(legend?.l)} · C {fmt(legend?.c)} · V{' '}
          {fmtVol(legend?.v)}
        </div>
        <div ref={mainRef} className="w-full" />
      </div>

      <div className="border border-border-subtle bg-surface rounded p-2">
        <div className="text-[11px] font-mono text-fg-muted mb-1">
          RSI(14): {fmt(series.rsi14[lastIdx], 1)}
        </div>
        <div ref={rsiRef} className="w-full" />
      </div>

      <div className="border border-border-subtle bg-surface rounded p-2">
        <div className="text-[11px] font-mono text-fg-muted mb-1">
          MACD: {fmt(series.macd[lastIdx], 3)} · Signal {fmt(series.macdSignal[lastIdx], 3)} · Hist{' '}
          {fmt(series.macdHistogram[lastIdx], 3)}
        </div>
        <div ref={macdRef} className="w-full" />
      </div>
    </div>
  );
}
