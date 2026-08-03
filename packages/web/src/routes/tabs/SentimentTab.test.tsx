import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SAMPLE_TICKERS } from '../../sample-data.js';
import { SentimentTab } from './SentimentTab.js';

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  private listeners = new Map<string, Set<(evt: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: EventListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb as (evt: MessageEvent<string>) => void);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, cb: EventListener): void {
    this.listeners.get(type)?.delete(cb as (evt: MessageEvent<string>) => void);
  }

  close(): void {}

  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  MockEventSource.instances = [];
  window.sessionStorage.clear();
});

describe('SentimentTab', () => {
  it('renders source links and sentiment badges in demo mode', () => {
    render(<SentimentTab t={SAMPLE_TICKERS[0]!} demo />);
    expect(screen.getByText('Source breakdown')).toBeDefined();
    expect(screen.getByText('Recent mentions')).toBeDefined();
    expect(screen.getAllByText('(reddit)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BULLISH').length).toBeGreaterThan(0);
    expect(screen.getByTestId('sentiment-gauge').textContent).toContain('-1');
    expect(screen.getByTestId('sentiment-gauge').textContent).toContain('+1');
  });

  it('loads live sentiment + mentions and reacts to sentiment.update SSE', async () => {
    window.sessionStorage.setItem('rt.auth', 'dash-token-40');
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/sentiment/NVDA/latest')) {
        return new Response(
          JSON.stringify({
            symbol: 'NVDA',
            asOf: '2026-08-03T16:00:00.000Z',
            score: 0.22,
            confidence: 0.7,
            volume: 99,
            bySource: { reddit: { score: 0.25, volume: 75 } },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/sentiment/NVDA?')) {
        return new Response(JSON.stringify({ items: [{ score: 0.11 }, { score: 0.22 }] }), {
          status: 200,
        });
      }
      if (url.includes('/mentions/NVDA?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                source: 'reddit',
                sourceId: 'abc',
                text: 'Still bullish into earnings.',
                publishedAt: '2026-08-03T15:58:00.000Z',
                url: 'https://example.com/reddit/abc',
                sentiment: { score: 0.45, label: 'bullish' },
                author: 'leakyUser',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<SentimentTab t={SAMPLE_TICKERS[0]!} demo={false} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(screen.getByText('+0.22')).toBeDefined();
    });
    expect(screen.queryByText('leakyUser')).toBeNull();
    expect(MockEventSource.instances[0]?.url).toContain('/api/events?t=dash-token-40');

    act(() => {
      MockEventSource.instances[0]!.emit('sentiment.update', {
        symbol: 'NVDA',
        snapshot: {
          symbol: 'NVDA',
          asOf: '2026-08-03T16:02:00.000Z',
          score: -0.44,
          confidence: 0.77,
          volume: 120,
          bySource: { reddit: { score: -0.52, volume: 84 } },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('-0.44')).toBeDefined();
      expect(screen.getByTestId('sentiment-gauge').className).toContain('sentiment-live-pulse');
    });
  });
});
