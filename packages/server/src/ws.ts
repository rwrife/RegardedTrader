import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  StreamAckMessage,
  StreamChainMessage,
  StreamChannel,
  StreamClientMessage,
  StreamErrorMessage,
  StreamNewsMessage,
  StreamQuoteMessage,
  StreamReadyMessage,
  type OptionContract,
} from '@regardedtrader/core';
import type { PollEvent } from './polling.js';

type StreamListener = (event: PollEvent) => void;

export interface StreamBridge {
  subscribe: (listener: StreamListener) => () => void;
  loadChain: (symbol: string) => Promise<OptionContract[]>;
}

export interface StreamAuth {
  required: boolean;
  validate: (candidate: string | null) => boolean;
}

export interface AttachStreamServerOptions {
  server: HttpServer;
  bridge: StreamBridge;
  auth?: StreamAuth;
  chainRefreshMinMs?: number;
  now?: () => Date;
}

type ClientSubscriptions = Map<StreamChannel, Set<string>>;

const DEFAULT_CHAIN_REFRESH_MIN_MS = 15_000;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function authTokenFromRequest(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const raw = authHeader.trim();
    if (raw.toLowerCase().startsWith('bearer ')) return raw.slice(7).trim();
    return raw;
  }
  const host = req.headers.host ?? '127.0.0.1';
  const parsed = new URL(req.url ?? '/', `http://${host}`);
  const queryToken = parsed.searchParams.get('t');
  return queryToken && queryToken.trim().length > 0 ? queryToken.trim() : null;
}

function sendSocketMessage(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function parseStreamClientMessage(input: string): {
  ok: true;
  message: import('@regardedtrader/core').StreamClientMessage;
} | {
  ok: false;
  error: string;
} {
  try {
    const raw = JSON.parse(input) as unknown;
    const message = StreamClientMessage.parse(raw);
    return { ok: true, message };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid stream message payload.',
    };
  }
}

export class SubscriptionBook {
  private readonly byClient = new Map<WebSocket, ClientSubscriptions>();

  subscribe(client: WebSocket, channel: StreamChannel, symbol: string): void {
    const normalized = normalizeSymbol(symbol);
    let channels = this.byClient.get(client);
    if (!channels) {
      channels = new Map();
      this.byClient.set(client, channels);
    }
    const current = channels.get(channel) ?? new Set<string>();
    current.add(normalized);
    channels.set(channel, current);
  }

  unsubscribe(client: WebSocket, channel: StreamChannel, symbol: string): void {
    const normalized = normalizeSymbol(symbol);
    const channels = this.byClient.get(client);
    if (!channels) return;
    const current = channels.get(channel);
    if (!current) return;
    current.delete(normalized);
    if (current.size === 0) channels.delete(channel);
    if (channels.size === 0) this.byClient.delete(client);
  }

  has(client: WebSocket, channel: StreamChannel, symbol: string): boolean {
    const normalized = normalizeSymbol(symbol);
    return this.byClient.get(client)?.get(channel)?.has(normalized) ?? false;
  }

  removeClient(client: WebSocket): void {
    this.byClient.delete(client);
  }

  clientsFor(channel: StreamChannel, symbol: string): WebSocket[] {
    const normalized = normalizeSymbol(symbol);
    const out: WebSocket[] = [];
    for (const [client, channels] of this.byClient.entries()) {
      if (channels.get(channel)?.has(normalized)) out.push(client);
    }
    return out;
  }
}

export function attachStreamServer(opts: AttachStreamServerOptions): () => void {
  const now = opts.now ?? (() => new Date());
  const chainRefreshMinMs = opts.chainRefreshMinMs ?? DEFAULT_CHAIN_REFRESH_MIN_MS;
  const auth = opts.auth ?? { required: false, validate: () => true };
  const book = new SubscriptionBook();
  const wss = new WebSocketServer({ noServer: true });
  const chainInflight = new Set<string>();
  const chainLastRefreshMs = new Map<string, number>();

  async function refreshChain(symbol: string): Promise<void> {
    const normalized = normalizeSymbol(symbol);
    if (chainInflight.has(normalized)) return;
    const atMs = now().getTime();
    const lastMs = chainLastRefreshMs.get(normalized) ?? 0;
    if (atMs - lastMs < chainRefreshMinMs) return;
    if (book.clientsFor('chain', normalized).length === 0) return;

    chainInflight.add(normalized);
    try {
      const contracts = await opts.bridge.loadChain(normalized);
      chainLastRefreshMs.set(normalized, atMs);
      const payload = StreamChainMessage.parse({
        type: 'chain',
        channel: 'chain',
        symbol: normalized,
        data: {
          symbol: normalized,
          asOf: now().toISOString(),
          contracts,
        },
      });
      for (const client of book.clientsFor('chain', normalized)) {
        sendSocketMessage(client, payload);
      }
    } catch (error) {
      const message = StreamErrorMessage.parse({
        type: 'error',
        error: `Failed to refresh options chain for ${normalized}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      for (const client of book.clientsFor('chain', normalized)) {
        sendSocketMessage(client, message);
      }
    } finally {
      chainInflight.delete(normalized);
    }
  }

  const unsubscribePolling = opts.bridge.subscribe((event) => {
    if (event.type === 'quote') {
      const payload = StreamQuoteMessage.parse({
        type: 'quote',
        channel: 'quote',
        symbol: event.data.symbol,
        data: event.data,
      });
      for (const client of book.clientsFor('quote', event.data.symbol)) {
        sendSocketMessage(client, payload);
      }
      void refreshChain(event.data.symbol);
      return;
    }
    if (event.type === 'news') {
      const payload = StreamNewsMessage.parse({
        type: 'news',
        channel: 'news',
        symbol: event.data.symbol,
        data: event.data,
      });
      for (const client of book.clientsFor('news', event.data.symbol)) {
        sendSocketMessage(client, payload);
      }
    }
  });

  wss.on('connection', (socket) => {
    const ready = StreamReadyMessage.parse({
      type: 'ready',
      channels: StreamChannel.options,
    });
    sendSocketMessage(socket, ready);

    socket.on('message', (raw) => {
      const parsed = parseStreamClientMessage(String(raw));
      if (!parsed.ok) {
        const error = StreamErrorMessage.parse({ type: 'error', error: parsed.error });
        sendSocketMessage(socket, error);
        return;
      }

      const symbol = normalizeSymbol(parsed.message.symbol);
      if (parsed.message.type === 'sub') {
        book.subscribe(socket, parsed.message.channel, symbol);
        const ack = StreamAckMessage.parse({
          type: 'subscribed',
          channel: parsed.message.channel,
          symbol,
        });
        sendSocketMessage(socket, ack);
        if (parsed.message.channel === 'chain') {
          void refreshChain(symbol);
        }
        return;
      }

      book.unsubscribe(socket, parsed.message.channel, symbol);
      const ack = StreamAckMessage.parse({
        type: 'unsubscribed',
        channel: parsed.message.channel,
        symbol,
      });
      sendSocketMessage(socket, ack);
    });

    socket.on('close', () => {
      book.removeClient(socket);
    });
  });

  const onUpgrade = (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    const host = req.headers.host ?? '127.0.0.1';
    const parsed = new URL(req.url ?? '/', `http://${host}`);
    if (parsed.pathname !== '/stream') return;

    if (auth.required && !auth.validate(authTokenFromRequest(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };

  opts.server.on('upgrade', onUpgrade);

  const teardown = () => {
    opts.server.off('upgrade', onUpgrade);
    unsubscribePolling();
    wss.close();
  };
  opts.server.on('close', teardown);
  return teardown;
}
