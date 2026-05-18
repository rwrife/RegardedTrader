import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLiveQuote } from './useLiveQuote.js';
import type { LiveQuote } from '@regardedtrader/core/schemas';

function makeQuote(over: Partial<LiveQuote> = {}): LiveQuote {
  return {
    symbol: 'NVDA',
    price: 100,
    change: 1,
    changePercent: 1,
    currency: 'USD',
    marketState: 'REGULAR',
    asOf: new Date('2024-06-12T15:30:00Z').toISOString(),
    ...over,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useLiveQuote', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default to "visible" so the polling chain advances.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches on mount, validates the payload, and uses a 10s cadence during REGULAR hours', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeQuote()));
    const { result, unmount } = renderHook(() =>
      useLiveQuote('NVDA', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    // Let the initial fetch resolve.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.current.quote?.price).toBe(100);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);

    // 9s later — still no second fetch (cadence is 10s for REGULAR).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Crossing 10s should trigger the next tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('switches to a 60s cadence when marketState is CLOSED', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(makeQuote({ marketState: 'CLOSED' })),
    );
    const { unmount } = renderHook(() =>
      useLiveQuote('NVDA', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 11s — not enough to trigger the slow cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Push past 60s — should fire again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('cancels polling on unmount', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeQuote()));
    const { unmount } = renderHook(() =>
      useLiveQuote('NVDA', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    unmount();

    // Even way past the next cadence boundary, no further fetches happen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error message when the request fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const { result, unmount } = renderHook(() =>
      useLiveQuote('NVDA', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(result.current.error).toMatch(/HTTP 500/);
    });
    expect(result.current.quote).toBeNull();
    unmount();
  });

  it('does not fetch when disabled', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeQuote()));
    renderHook(() =>
      useLiveQuote('NVDA', { fetchImpl: fetchImpl as unknown as typeof fetch, enabled: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
