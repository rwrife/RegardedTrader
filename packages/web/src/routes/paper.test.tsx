import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Paper } from './paper.js';

afterEach(() => cleanup());

describe('<Paper />', () => {
  it('renders orders/positions and the paper banner', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/paper/orders')) {
        return new Response(
          JSON.stringify({
            orders: [{ id: 'o1', planId: 'NVDA-1', symbol: 'NVDA', mode: 'paper', submittedAt: '2026-08-03T00:00:00Z', plan: { name: 'x', thesis: 'x', legs: [], maxLoss: 1, maxGain: null, breakEvens: [] } }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          positions: [{ id: 'p1', planId: 'NVDA-1', symbol: 'NVDA', openedAt: '2026-08-03T00:00:00Z', netPremiumUsd: 120, maxLossUsd: 120, maxGainUsd: null, status: 'open' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    render(<Paper fetchImpl={fetchImpl} />);
    await waitFor(() => {
      expect(screen.getByText(/PAPER — simulated, no real orders/i)).toBeDefined();
      expect(screen.getAllByText('NVDA-1').length).toBe(2);
      expect(screen.getByText(/Not financial advice/i)).toBeDefined();
    });
  });
});
