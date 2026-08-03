import { EventEmitter } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { PollEvent } from './polling.js';
import { attachStreamServer, parseStreamClientMessage, SubscriptionBook } from './ws.js';

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (error) => reject(error));
  });
}

function waitForUnexpectedResponse(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.once('error', (error) => reject(error));
  });
}

function createMessageQueue(socket: WebSocket): {
  next: <T>(timeoutMs?: number) => Promise<T>;
  nextOfType: <T extends { type?: string }>(type: string, timeoutMs?: number) => Promise<T>;
} {
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  socket.on('message', (raw: WebSocket.RawData) => {
    const parsed = JSON.parse(String(raw)) as unknown;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    queue.push(parsed);
  });
  return {
    next<T>(timeoutMs = 2_000): Promise<T> {
      return new Promise((resolve, reject) => {
        if (queue.length > 0) {
          resolve(queue.shift() as T);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for websocket message')),
          timeoutMs,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value as T);
        });
      });
    },
    async nextOfType<T extends { type?: string }>(type: string, timeoutMs = 2_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(50, deadline - Date.now());
        const frame = await this.next<T>(remaining);
        if (frame && frame.type === type) return frame;
      }
      throw new Error(`timed out waiting for websocket message of type ${type}`);
    },
  };
}

async function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as import('node:net').AddressInfo).port);
    });
  });
}

describe('parseStreamClientMessage', () => {
  it('parses a valid subscribe frame', () => {
    const parsed = parseStreamClientMessage(
      JSON.stringify({ type: 'sub', channel: 'quote', symbol: 'NVDA' }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toEqual({ type: 'sub', channel: 'quote', symbol: 'NVDA' });
    }
  });

  it('rejects malformed JSON payloads', () => {
    const parsed = parseStreamClientMessage('{invalid');
    expect(parsed.ok).toBe(false);
  });
});

describe('SubscriptionBook', () => {
  it('tracks sub/unsub operations by channel and symbol', () => {
    const book = new SubscriptionBook();
    const ws = {} as WebSocket;
    book.subscribe(ws, 'quote', 'nvda');
    expect(book.has(ws, 'quote', 'NVDA')).toBe(true);
    expect(book.clientsFor('quote', 'nvda')).toEqual([ws]);
    book.unsubscribe(ws, 'quote', 'nvda');
    expect(book.has(ws, 'quote', 'NVDA')).toBe(false);
  });
});

describe('attachStreamServer', () => {
  let server: HttpServer | null = null;
  let teardown: (() => void) | null = null;

  afterEach(async () => {
    teardown?.();
    teardown = null;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('streams quote/news/chain events to subscribed clients', async () => {
    const events = new EventEmitter();
    server = createServer((_, res) => {
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);

    teardown = attachStreamServer({
      server,
      bridge: {
        subscribe: (listener) => {
          events.on('poll', listener);
          return () => events.off('poll', listener);
        },
        loadChain: async (symbol) => [
          {
            symbol: `${symbol}240920C00100000`,
            underlying: symbol,
            expiry: '2026-09-20',
            strike: 100,
            type: 'call',
            bid: 1,
            ask: 1.1,
            last: 1.05,
            volume: 10,
            openInterest: 12,
            iv: 0.3,
            delta: 0.5,
            gamma: 0.1,
            theta: -0.01,
            vega: 0.09,
          },
        ],
      },
      auth: { required: false, validate: () => true },
      chainRefreshMinMs: 0,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    const q = createMessageQueue(ws);
    await waitForOpen(ws);
    const ready = await q.nextOfType<{ type: string; channels: string[] }>('ready');
    expect(ready.type).toBe('ready');
    expect(ready.channels).toContain('quote');

    ws.send(JSON.stringify({ type: 'sub', channel: 'quote', symbol: 'NVDA' }));
    const quoteAck = await q.nextOfType<{ type: string; channel: string }>('subscribed');
    expect(quoteAck).toMatchObject({ type: 'subscribed', channel: 'quote' });

    ws.send(JSON.stringify({ type: 'sub', channel: 'news', symbol: 'NVDA' }));
    const newsAck = await q.nextOfType<{ type: string; channel: string }>('subscribed');
    expect(newsAck).toMatchObject({ type: 'subscribed', channel: 'news' });

    ws.send(JSON.stringify({ type: 'sub', channel: 'chain', symbol: 'NVDA' }));
    const chainAck = await q.nextOfType<{ type: string; channel: string }>('subscribed');
    expect(chainAck).toMatchObject({ type: 'subscribed', channel: 'chain' });
    const chainData = await q.nextOfType<{ type: string; channel: string }>('chain');
    expect(chainData).toMatchObject({ type: 'chain', channel: 'chain' });

    events.emit('poll', {
      type: 'quote',
      data: {
        symbol: 'NVDA',
        price: 100,
        change: 1,
        changePercent: 1,
        rsi: 55,
        asOf: new Date().toISOString(),
      },
    } satisfies PollEvent);
    const quoteData = await q.nextOfType<{ type: string; channel: string }>('quote');
    expect(quoteData).toMatchObject({ type: 'quote', channel: 'quote' });

    events.emit('poll', {
      type: 'news',
      data: {
        symbol: 'NVDA',
        title: 'Headline',
        url: 'https://example.com/nvda',
        source: 'example',
        publishedAt: new Date().toISOString(),
      },
    } satisfies PollEvent);
    const newsData = await q.nextOfType<{ type: string; channel: string }>('news');
    expect(newsData).toMatchObject({ type: 'news', channel: 'news' });
    ws.close();
  });

  it('enforces auth tokens when configured', async () => {
    server = createServer((_, res) => {
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    teardown = attachStreamServer({
      server,
      bridge: {
        subscribe: () => () => undefined,
        loadChain: async () => [],
      },
      auth: { required: true, validate: (candidate) => candidate === 'token-1' },
    });

    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    const status = await waitForUnexpectedResponse(unauthorized);
    expect(status).toBe(401);

    const authorized = new WebSocket(`ws://127.0.0.1:${port}/stream?t=token-1`);
    const q = createMessageQueue(authorized);
    await waitForOpen(authorized);
    const ready = await q.nextOfType<{ type: string }>('ready');
    expect(ready.type).toBe('ready');
    authorized.close();
  });
});
