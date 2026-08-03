import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { TopBar } from './TopBar.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TopBar version chip (#179)', () => {
  it('renders the srv/core version chip from GET /version', async () => {
    const payload = {
      server: '0.2.1',
      core: '0.2.1',
      node: 'v20.11.0',
      api: 1,
      startedAt: '2026-07-17T09:00:00.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/version')) {
        return {
          ok: true,
          json: async () => payload,
        } as unknown as Response;
      }
      if (url.startsWith('/calendar/upcoming')) {
        return {
          ok: true,
          json: async () => ({ today: '2026-11-27', events: [] }),
        } as unknown as Response;
      }
      if (url.startsWith('/calendar/status')) {
        return {
          ok: true,
          json: async () => ({ stale: false }),
        } as unknown as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TopBar demo={false} onOpenSettings={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('version-chip').textContent).toBe(
        `srv 0.2.1 \u00b7 core 0.2.1`,
      );
    });
    expect(fetchMock).toHaveBeenCalledWith('/version');
  });

  it('falls back to "srv ?" on a 404 without going red', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<TopBar demo={false} onOpenSettings={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('version-chip').textContent).toBe('srv ?');
    });
    // Neutral chrome: chip must not carry a "down" / red utility class.
    const chip = screen.getByTestId('version-chip');
    expect(chip.className).not.toMatch(/text-down/);
    expect(chip.className).not.toMatch(/bg-down/);
  });

  it('falls back to "srv ?" on a malformed payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nope: true }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<TopBar demo={false} onOpenSettings={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('version-chip').textContent).toBe('srv ?');
    });
  });

  it('shows early-close pill and stale warning dot from calendar endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/version')) {
        return {
          ok: true,
          json: async () => ({ server: '0.2.1', core: '0.2.1', node: 'v20', api: 1, startedAt: '2026-07-17T09:00:00.000Z' }),
        } as unknown as Response;
      }
      if (url.startsWith('/calendar/upcoming')) {
        return {
          ok: true,
          json: async () => ({
            today: '2026-11-27',
            events: [
              {
                dateOffset: 0,
                kind: 'market_early_close',
                title: 'Day after Thanksgiving',
                details: { closeTimeEt: '13:00' },
              },
            ],
          }),
        } as unknown as Response;
      }
      if (url.startsWith('/calendar/status')) {
        return {
          ok: true,
          json: async () => ({ stale: true }),
        } as unknown as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<TopBar demo={false} onOpenSettings={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Early close 13:00 ET/)).toBeDefined();
      expect(screen.getByTestId('market-stale-dot').className).toMatch(/bg-warn/);
    });
  });

  it('shows holiday name in muted text style', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/version')) {
        return {
          ok: true,
          json: async () => ({ server: '0.2.1', core: '0.2.1', node: 'v20', api: 1, startedAt: '2026-07-17T09:00:00.000Z' }),
        } as unknown as Response;
      }
      if (url.startsWith('/calendar/upcoming')) {
        return {
          ok: true,
          json: async () => ({
            today: '2026-12-25',
            events: [{ dateOffset: 0, kind: 'market_holiday', title: 'Christmas Day' }],
          }),
        } as unknown as Response;
      }
      if (url.startsWith('/calendar/status')) {
        return { ok: true, json: async () => ({ stale: false, marketState: 'holiday' }) } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<TopBar demo={false} onOpenSettings={() => {}} />);
    await waitFor(() => {
      const note = screen.getByText(/Christmas Day/);
      expect(note.className).toMatch(/text-fg-muted/);
    });
  });
});
