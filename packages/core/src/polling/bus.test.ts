import { describe, expect, it, vi } from 'vitest';
import { PollingEventBus } from './bus.js';

describe('PollingEventBus', () => {
  it('emits to channel listeners and wildcard listeners', () => {
    const bus = new PollingEventBus();
    const onQuote = vi.fn();
    const onAny = vi.fn();

    bus.on('quote.update', onQuote);
    bus.onAny(onAny);

    bus.emit({
      type: 'quote.update',
      symbol: 'NVDA',
      quote: {
        symbol: 'NVDA',
        price: 900,
        change: 5,
        changePercent: 0.56,
        volume: 123,
        asOf: '2026-07-30T15:00:00.000Z',
      },
      indicators: null,
      source: 'test',
    });

    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onAny).toHaveBeenCalledTimes(1);
    expect(onQuote.mock.calls[0]?.[0]).toMatchObject({ type: 'quote.update', symbol: 'NVDA' });
  });

  it('does not deliver mismatched channels', () => {
    const bus = new PollingEventBus();
    const onNews = vi.fn();
    const onOptions = vi.fn();

    bus.on('news.new', onNews);
    bus.on('options.update', onOptions);

    bus.emit({
      type: 'job.state',
      jobId: 'quote:NVDA',
      status: 'running',
      at: '2026-07-30T15:00:00.000Z',
      symbols: ['NVDA'],
    });

    expect(onNews).not.toHaveBeenCalled();
    expect(onOptions).not.toHaveBeenCalled();
  });

  it('supports idempotent unsubscribe', () => {
    const bus = new PollingEventBus();
    const onQuote = vi.fn();
    const off = bus.on('quote.update', onQuote);

    expect(bus.listenerCount('quote.update')).toBe(1);
    off();
    off();

    expect(bus.listenerCount('quote.update')).toBe(0);

    bus.emit({
      type: 'quote.update',
      symbol: 'NVDA',
      quote: {
        symbol: 'NVDA',
        price: 900,
        change: 5,
        changePercent: 0.56,
        volume: 123,
        asOf: '2026-07-30T15:00:00.000Z',
      },
      indicators: null,
      source: 'test',
    });

    expect(onQuote).not.toHaveBeenCalled();
  });

  it('swallows listener errors and continues fan-out', () => {
    const onErr = vi.fn();
    const bus = new PollingEventBus({ onListenerError: onErr });
    const healthy = vi.fn();

    bus.on('quote.update', () => {
      throw new Error('boom');
    });
    bus.on('quote.update', healthy);

    bus.emit({
      type: 'quote.update',
      symbol: 'NVDA',
      quote: {
        symbol: 'NVDA',
        price: 900,
        change: 5,
        changePercent: 0.56,
        volume: 123,
        asOf: '2026-07-30T15:00:00.000Z',
      },
      indicators: null,
      source: 'test',
    });

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(onErr).toHaveBeenCalledTimes(1);
    const call = onErr.mock.calls[0];
    expect(call?.[0]).toBe('quote.update');
  });
});
