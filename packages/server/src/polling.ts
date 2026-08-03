import { EventEmitter } from 'node:events';
import { computeIndicators, type MarketDataClient, type OHLCV, type WatchlistStore } from '@regardedtrader/core';

export type PollingJobState = 'idle' | 'running' | 'paused' | 'error';

export interface PollingJobStatus {
  id: string;
  state: PollingJobState;
  lastRun: string | null;
  nextRun: string | null;
  lastError: string | null;
}

export interface TapePoint {
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
  rsi: number | null;
  lastHeadline: string | null;
  asOf: string;
}

export interface TailNewsEvent {
  symbol: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface TailQuoteEvent {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  rsi: number | null;
  asOf: string;
}

type PollEvent =
  | { type: 'tape'; data: TapePoint }
  | { type: 'news'; data: TailNewsEvent }
  | { type: 'quote'; data: TailQuoteEvent };

interface PollingOptions {
  quoteEveryMs?: number;
  newsEveryMs?: number;
  now?: () => Date;
}

interface JobRuntime {
  id: string;
  state: PollingJobState;
  lastRun: string | null;
  nextRun: string | null;
  lastError: string | null;
  intervalMs: number;
  timer: ReturnType<typeof setInterval> | null;
  run: () => Promise<void>;
}

const DEFAULT_QUOTE_MS = 15_000;
const DEFAULT_NEWS_MS = 30_000;

export class PollingCoordinator {
  private readonly events = new EventEmitter();
  private readonly now: () => Date;
  private readonly quoteEveryMs: number;
  private readonly newsEveryMs: number;
  private readonly jobs: JobRuntime[];
  private paused = false;
  private readonly tape = new Map<string, TapePoint>();
  private readonly headlines = new Map<string, string>();
  private readonly seenNews = new Set<string>();

  constructor(
    private readonly watchlist: WatchlistStore,
    private readonly getClient: () => MarketDataClient,
    opts: PollingOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.quoteEveryMs = opts.quoteEveryMs ?? DEFAULT_QUOTE_MS;
    this.newsEveryMs = opts.newsEveryMs ?? DEFAULT_NEWS_MS;
    this.jobs = [
      this.makeJob('quotes', this.quoteEveryMs, () => this.runQuotes()),
      this.makeJob('news', this.newsEveryMs, () => this.runNews()),
    ];
  }

  start(): void {
    for (const job of this.jobs) this.startJob(job);
  }

  stop(): void {
    for (const job of this.jobs) {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
    }
  }

  pause(): void {
    this.paused = true;
    for (const job of this.jobs) {
      job.state = 'paused';
      job.nextRun = null;
    }
  }

  resume(): void {
    this.paused = false;
    const now = this.now().toISOString();
    for (const job of this.jobs) {
      job.state = 'idle';
      job.nextRun = new Date(Date.parse(now) + job.intervalMs).toISOString();
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  status(): PollingJobStatus[] {
    return this.jobs.map((j) => ({
      id: j.id,
      state: this.paused ? 'paused' : j.state,
      lastRun: j.lastRun,
      nextRun: this.paused ? null : j.nextRun,
      lastError: j.lastError,
    }));
  }

  getTape(symbols: readonly string[]): TapePoint[] {
    const normalized = symbols.map((s) => s.toUpperCase());
    return normalized.map((sym) => this.tape.get(sym)).filter((v): v is TapePoint => Boolean(v));
  }

  subscribe(listener: (event: PollEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  private makeJob(id: string, intervalMs: number, run: () => Promise<void>): JobRuntime {
    return {
      id,
      state: 'idle',
      lastRun: null,
      nextRun: null,
      lastError: null,
      intervalMs,
      timer: null,
      run,
    };
  }

  private startJob(job: JobRuntime): void {
    const tick = async () => {
      if (this.paused) return;
      job.state = 'running';
      try {
        await job.run();
        job.state = 'idle';
        job.lastError = null;
      } catch (e) {
        job.state = 'error';
        job.lastError = e instanceof Error ? e.message : String(e);
      } finally {
        job.lastRun = this.now().toISOString();
        job.nextRun = new Date(Date.now() + job.intervalMs).toISOString();
      }
    };
    job.nextRun = new Date(Date.now() + job.intervalMs).toISOString();
    job.timer = setInterval(() => {
      void tick();
    }, job.intervalMs);
    job.timer.unref?.();
    void tick();
  }

  private async watchedSymbols(): Promise<string[]> {
    const entries = await this.watchlist.list();
    return entries.map((e) => e.profile.symbol.toUpperCase());
  }

  private async runQuotes(): Promise<void> {
    const symbols = await this.watchedSymbols();
    if (symbols.length === 0) return;
    const client = this.getClient();
    await Promise.all(
      symbols.map(async (symbol) => {
        const [quote, history] = await Promise.all([
          client.quote(symbol),
          client.history(symbol, 60),
        ]);
        const rsi = computeRsi(history);
        const point: TapePoint = {
          symbol,
          last: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          rsi,
          lastHeadline: this.headlines.get(symbol) ?? null,
          asOf: quote.asOf,
        };
        this.tape.set(symbol, point);
        this.events.emit('event', { type: 'tape', data: point } satisfies PollEvent);
        this.events.emit('event', {
          type: 'quote',
          data: {
            symbol,
            price: quote.price,
            change: quote.change,
            changePercent: quote.changePercent,
            rsi,
            asOf: quote.asOf,
          },
        } satisfies PollEvent);
      }),
    );
  }

  private async runNews(): Promise<void> {
    const symbols = await this.watchedSymbols();
    if (symbols.length === 0) return;
    const client = this.getClient();
    await Promise.all(
      symbols.map(async (symbol) => {
        const items = await client.news(symbol);
        if (items.length === 0) return;
        const sorted = [...items].sort(
          (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
        );
        const top = sorted[0];
        if (!top) return;
        this.headlines.set(symbol, top.title);
        const existing = this.tape.get(symbol);
        if (existing) {
          const merged = { ...existing, lastHeadline: top.title };
          this.tape.set(symbol, merged);
          this.events.emit('event', { type: 'tape', data: merged } satisfies PollEvent);
        }
        for (const item of sorted.slice(0, 5)) {
          const key = `${symbol}:${item.url}`;
          if (this.seenNews.has(key)) continue;
          this.seenNews.add(key);
          this.events.emit('event', {
            type: 'news',
            data: {
              symbol,
              title: item.title,
              url: item.url,
              source: item.source,
              publishedAt: item.publishedAt,
            },
          } satisfies PollEvent);
        }
      }),
    );
  }
}

function computeRsi(history: OHLCV[]): number | null {
  const indicators = computeIndicators(history);
  return indicators.rsi14 ?? null;
}

export type { PollEvent };
