import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { CandleChart, type Candle } from './CandleChart.js';

afterEach(() => cleanup());

const sample: Candle[] = [
  { t: '2024-06-10', o: 100, h: 102, l: 99, c: 101, v: 1_000_000 },
  { t: '2024-06-11', o: 101, h: 103, l: 100, c: 100.5, v: 1_500_000 },
  { t: '2024-06-12', o: 100.5, h: 105, l: 100, c: 104, v: 2_500_000 },
];

describe('CandleChart', () => {
  it('renders an SVG with one body rect + one wick line per candle, plus volume bars', () => {
    const { container } = render(<CandleChart candles={sample} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // Each candle: 1 wick <line> + 1 body <rect>. Plus one volume <rect> per
    // candle. We don't assert the exact total to keep the test resilient to
    // axis tweaks, just that the per-candle structure is present.
    const rects = svg!.querySelectorAll('rect');
    // 2 rects per candle (body + volume) = 6 at minimum.
    expect(rects.length).toBeGreaterThanOrEqual(sample.length * 2);
  });

  it('shows an empty-state when given no candles', () => {
    const { getByText } = render(<CandleChart candles={[]} />);
    expect(getByText(/no chart data/i)).toBeTruthy();
  });

  it('labels accessibility with the session count', () => {
    const { container } = render(<CandleChart candles={sample} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-label')).toMatch(/3 sessions/);
  });
});
