import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { RiskGraphChart } from './RiskGraphChart.js';

describe('<RiskGraphChart />', () => {
  afterEach(() => cleanup());

  it('renders a fallback for insufficient data', () => {
    render(
      <RiskGraphChart
        series={{
          underlying: [],
          pnl: [],
          breakevens: [],
          maxLoss: null,
          maxGain: null,
          netDebit: 0,
        }}
      />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/insufficient/i);
  });

  it('renders gain and loss segments plus break-even markers', () => {
    const { container } = render(
      <RiskGraphChart
        series={{
          underlying: [100, 110, 120, 130],
          pnl: [-200, 0, 300, 300],
          breakevens: [110],
          maxLoss: -200,
          maxGain: 300,
          netDebit: 200,
        }}
      />,
    );
    const polylines = container.querySelectorAll('polyline');
    // One segment for the loss side, one for the gain side.
    expect(polylines.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/BE 110\.00/)).toBeTruthy();
  });
});
