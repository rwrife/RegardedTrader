import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { computeIndicatorSeries } from '@regardedtrader/core/indicators';
import type { OHLCV, Quote } from '@regardedtrader/core/schemas';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

const SPARK_BARS = '▁▂▃▄▅▆▇█';

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return SPARK_BARS[0]!.repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.max(
        0,
        Math.min(
          SPARK_BARS.length - 1,
          Math.round(((v - lo) / (hi - lo)) * (SPARK_BARS.length - 1)),
        ),
      );
      return SPARK_BARS[idx]!;
    })
    .join('');
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function ChartScreen({
  symbol,
  serverUrl,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [history, setHistory] = useState<OHLCV[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setErr('Missing symbol. Usage: regard chart NVDA');
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    const sym = symbol.toUpperCase();
    Promise.all([api<OHLCV[]>(serverUrl, `/history/${encodeURIComponent(sym)}?days=90`), api<Quote>(serverUrl, `/quote/${encodeURIComponent(sym)}`)])
      .then(([bars, q]) => {
        setHistory(bars);
        setQuote(q);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => {
        setFinished(true);
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [symbol, serverUrl, exit, onDone]);

  const summary = useMemo(() => {
    if (!history || history.length === 0) return null;
    const closes = history.map((b) => b.c);
    const last = history[history.length - 1]!;
    const prev = history.length > 1 ? history[history.length - 2]! : last;
    const change = last.c - prev.c;
    const changePct = prev.c !== 0 ? (change / prev.c) * 100 : 0;
    const ind = computeIndicatorSeries(history);
    return {
      spark: sparkline(closes),
      change,
      changePct,
      last,
      rsi14: ind.rsi14[ind.rsi14.length - 1] ?? null,
      sma20: ind.sma20[ind.sma20.length - 1] ?? null,
      sma50: ind.sma50[ind.sma50.length - 1] ?? null,
      ema12: ind.ema12[ind.ema12.length - 1] ?? null,
      ema26: ind.ema26[ind.ema26.length - 1] ?? null,
      macd: ind.macd[ind.macd.length - 1] ?? null,
      macdSignal: ind.macdSignal[ind.macdSignal.length - 1] ?? null,
      macdHist: ind.macdHistogram[ind.macdHistogram.length - 1] ?? null,
    };
  }, [history]);

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && finished && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }
  if (!summary || !quote) {
    return (
      <Text>
        <Spinner type="dots" /> loading chart for {symbol.toUpperCase()}…
      </Text>
    );
  }

  const up = summary.change >= 0;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ━━━ {symbol.toUpperCase()} chart (90D) ━━━
      </Text>
      <Text>
        Price ${quote.price.toFixed(2)}{' '}
        <Text color={up ? 'green' : 'red'}>
          {up ? '+' : ''}
          {summary.change.toFixed(2)} ({up ? '+' : ''}
          {summary.changePct.toFixed(2)}%)
        </Text>{' '}
        • as of {quote.asOf}
      </Text>
      <Text> </Text>
      <Text>{summary.spark}</Text>
      <Text dimColor>
        O {fmt(summary.last.o)} · H {fmt(summary.last.h)} · L {fmt(summary.last.l)} · C{' '}
        {fmt(summary.last.c)} · V {summary.last.v.toLocaleString()}
      </Text>
      <Text> </Text>
      <Text>
        RSI14 {fmt(summary.rsi14, 1)} • SMA20 {fmt(summary.sma20)} • SMA50 {fmt(summary.sma50)}
      </Text>
      <Text>
        EMA12 {fmt(summary.ema12)} • EMA26 {fmt(summary.ema26)} • MACD {fmt(summary.macd, 3)} •
        Signal {fmt(summary.macdSignal, 3)} • Hist {fmt(summary.macdHist, 3)}
      </Text>
      {onDone && finished && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
