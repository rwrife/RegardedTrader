import React from 'react';

/**
 * 24h sentiment sparkline. Uses a single SVG polyline with a zero-line
 * baseline so a single +/- score reads at a glance. Extracted from App.tsx
 * in #112.
 */
export function Sparkline({ values }: { values: number[] }): JSX.Element {
  const w = 320;
  const h = 36;
  const min = Math.min(...values, -0.1);
  const max = Math.max(...values, 0.1);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / (max - min)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const zeroY = h - ((0 - min) / (max - min)) * h;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-9">
      <line
        x1="0"
        x2={w}
        y1={zeroY}
        y2={zeroY}
        stroke="currentColor"
        className="text-border-subtle"
        strokeWidth="1"
      />
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        className="text-ai"
        strokeWidth="1.5"
      />
    </svg>
  );
}
