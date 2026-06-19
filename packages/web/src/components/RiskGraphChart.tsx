/**
 * `RiskGraphChart` — pure-SVG payoff-at-expiry chart for an options
 * `TradePlan.riskGraph` (issue #76, rendered for issue #113).
 *
 * Kept dependency-free (no charting library) so the web bundle stays small
 * and matches the rest of the dashboard's `CandleChart` approach. Renders:
 *
 * - the P/L curve sampled across the underlying range
 * - a zero baseline so debit/credit reads at a glance
 * - vertical break-even markers
 *
 * Negative P/L is rendered in the dashboard's "loss" red, positive in the
 * "gain" green, matching the data-not-decoration colour rule in AGENTS.md.
 */
import React from 'react';
import type { RiskGraphSeries } from '@regardedtrader/core';

export interface RiskGraphChartProps {
  series: RiskGraphSeries;
  width?: number;
  height?: number;
  className?: string;
}

const PAD = { top: 8, right: 12, bottom: 24, left: 44 };
const LOSS_COLOR = '#ef4444';
const GAIN_COLOR = '#10b981';
const ZERO_COLOR = '#94a3b8';
const AXIS_COLOR = '#475569';
const BE_COLOR = '#f59e0b';

export function RiskGraphChart({
  series,
  width = 560,
  height = 220,
  className,
}: RiskGraphChartProps): JSX.Element {
  const { underlying, pnl, breakevens } = series;
  const n = Math.min(underlying.length, pnl.length);
  if (n < 2) {
    return (
      <svg
        className={className}
        width={width}
        height={height}
        role="img"
        aria-label="Risk graph (insufficient data)"
      >
        <text x={width / 2} y={height / 2} textAnchor="middle" fill={AXIS_COLOR} fontSize={12}>
          (not enough points to render)
        </text>
      </svg>
    );
  }

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  let xMin = underlying[0]!;
  let xMax = underlying[n - 1]!;
  if (xMin === xMax) xMax = xMin + 1;

  let yMin = pnl[0]!;
  let yMax = pnl[0]!;
  for (let i = 1; i < n; i++) {
    const v = pnl[i]!;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  // Ensure the zero line is always visible so debit/credit reads correctly.
  if (yMin > 0) yMin = 0;
  if (yMax < 0) yMax = 0;
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }

  const xScale = (u: number): number => PAD.left + ((u - xMin) / (xMax - xMin)) * innerW;
  const yScale = (p: number): number => PAD.top + (1 - (p - yMin) / (yMax - yMin)) * innerH;
  const zeroY = yScale(0);

  // Split the polyline into positive and negative segments so colour
  // encodes sign without rendering a gradient.
  const segments: { sign: 1 | -1; points: string }[] = [];
  let currentSign: 1 | -1 = pnl[0]! >= 0 ? 1 : -1;
  let currentPts = `${xScale(underlying[0]!).toFixed(2)},${yScale(pnl[0]!).toFixed(2)}`;
  for (let i = 1; i < n; i++) {
    const u = underlying[i]!;
    const p = pnl[i]!;
    const sign: 1 | -1 = p >= 0 ? 1 : -1;
    if (sign !== currentSign) {
      // Linear interpolation to the crossover at p = 0 between i-1 and i.
      const u0 = underlying[i - 1]!;
      const p0 = pnl[i - 1]!;
      const t = p0 === p ? 0 : p0 / (p0 - p);
      const xCross = u0 + (u - u0) * t;
      const cx = xScale(xCross).toFixed(2);
      const cy = zeroY.toFixed(2);
      currentPts += ` ${cx},${cy}`;
      segments.push({ sign: currentSign, points: currentPts });
      currentSign = sign;
      currentPts = `${cx},${cy}`;
    }
    currentPts += ` ${xScale(u).toFixed(2)},${yScale(p).toFixed(2)}`;
  }
  segments.push({ sign: currentSign, points: currentPts });

  // Y-axis ticks: yMin, 0, yMax
  const yTicks = [yMin, 0, yMax];
  // X-axis ticks: xMin, midpoint, xMax
  const xTicks = [xMin, (xMin + xMax) / 2, xMax];

  return (
    <svg
      className={className}
      width={width}
      height={height}
      role="img"
      aria-label="Profit/loss at expiry"
      data-testid="risk-graph"
    >
      {/* Plot frame */}
      <rect
        x={PAD.left}
        y={PAD.top}
        width={innerW}
        height={innerH}
        fill="none"
        stroke={AXIS_COLOR}
        strokeWidth={1}
      />
      {/* Zero baseline */}
      <line
        x1={PAD.left}
        x2={PAD.left + innerW}
        y1={zeroY}
        y2={zeroY}
        stroke={ZERO_COLOR}
        strokeDasharray="3 3"
        strokeWidth={1}
      />
      {/* Y-axis labels */}
      {yTicks.map((t, i) => (
        <text
          key={`y${i}`}
          x={PAD.left - 6}
          y={yScale(t)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fontFamily="monospace"
          fill={AXIS_COLOR}
        >
          {fmtUsd(t)}
        </text>
      ))}
      {/* X-axis labels */}
      {xTicks.map((t, i) => (
        <text
          key={`x${i}`}
          x={xScale(t)}
          y={PAD.top + innerH + 14}
          textAnchor="middle"
          fontSize={10}
          fontFamily="monospace"
          fill={AXIS_COLOR}
        >
          {t.toFixed(2)}
        </text>
      ))}
      {/* Break-even markers */}
      {breakevens.map((be, i) => {
        if (be < xMin || be > xMax) return null;
        const x = xScale(be);
        return (
          <g key={`be${i}`}>
            <line
              x1={x}
              x2={x}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke={BE_COLOR}
              strokeDasharray="2 4"
              strokeWidth={1}
            />
            <text
              x={x}
              y={PAD.top - 1}
              textAnchor="middle"
              fontSize={9}
              fontFamily="monospace"
              fill={BE_COLOR}
            >
              BE {be.toFixed(2)}
            </text>
          </g>
        );
      })}
      {/* P/L polylines, one per sign-segment */}
      {segments.map((s, i) => (
        <polyline
          key={`seg${i}`}
          points={s.points}
          fill="none"
          stroke={s.sign === 1 ? GAIN_COLOR : LOSS_COLOR}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const rounded = abs >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(rounded).toLocaleString('en-US', {
    minimumFractionDigits: abs >= 100 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
