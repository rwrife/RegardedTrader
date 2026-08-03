import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarStrip } from './CalendarStrip.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CalendarStrip', () => {
  it('renders market bars and per-symbol earnings dots from /calendar/events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fromEt: '2026-08-03',
        toEtExclusive: '2026-08-17',
        days: 14,
        events: [
          {
            id: 'h1',
            kind: 'market_holiday',
            symbol: null,
            startUtc: '2026-08-04T00:00:00.000Z',
            endUtc: '2026-08-04T23:59:59.999Z',
            allDay: true,
            title: 'Independence Day (observed)',
            sources: [{ name: 'NYSE', url: 'https://www.nyse.com' }],
            fetchedAt: '2026-08-01T00:00:00.000Z',
          },
          {
            id: 'e1',
            kind: 'earnings',
            symbol: 'NVDA',
            startUtc: '2026-08-05T12:30:00.000Z',
            endUtc: '2026-08-05T12:30:00.000Z',
            allDay: false,
            title: 'NVDA earnings',
            details: { when: 'bmo', epsEstimate: 1.42 },
            sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
            fetchedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<CalendarStrip />);

    await waitFor(() => {
      expect(screen.getByText('Independence Day (observed)')).toBeDefined();
      expect(screen.getByText('NVDA')).toBeDefined();
      expect(screen.getByTestId('calendar-strip-market-bar')).toBeDefined();
      expect(screen.getByTestId('calendar-strip-earnings-dot')).toBeDefined();
    });
  });
});
