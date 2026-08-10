import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TickerRoute } from './ticker.js';

vi.mock('../components/TickerChart.js', () => ({
  TickerChart: ({ symbol }: { symbol: string }) => <div data-testid="mock-ticker-chart">{symbol}</div>,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TickerRoute earnings chip', () => {
  it('renders upcoming earnings chip with source tooltip', async () => {
    const eventStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const eventFetchedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/history/NVDA')) {
        return {
          ok: true,
          json: async () => [
            { t: '2026-08-01', o: 100, h: 105, l: 99, c: 103, v: 1_000_000 },
          ],
        } as unknown as Response;
      }
      if (url.includes('/calendar/earnings/NVDA')) {
        return {
          ok: true,
          json: async () => ({
            symbol: 'NVDA',
            events: [
              {
                id: 'e1',
                kind: 'earnings',
                symbol: 'NVDA',
                startUtc: eventStart,
                endUtc: eventStart,
                allDay: false,
                title: 'NVIDIA earnings',
                details: { when: 'bmo', epsEstimate: 1.42 },
                sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
                fetchedAt: eventFetchedAt,
              },
            ],
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TickerRoute symbol="NVDA" demo={false} />);

    await waitFor(() => {
      const chip = screen.getByTestId('ticker-earnings-chip');
      expect(chip.textContent).toContain('Earnings in');
      expect(chip.getAttribute('title')).toContain('Yahoo');
    });
  });
});
