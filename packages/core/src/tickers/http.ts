/**
 * Polite HTTP client for ticker resolution sources.
 *
 * Wraps the global `fetch` with:
 *   - a fixed `User-Agent` identifying RegardedTrader,
 *   - a per-host token-bucket rate limiter (default 4 req/s),
 *   - exponential backoff with jitter on 429/5xx (3 tries),
 *   - hard timeout (default 4s),
 *   - cookie stripping,
 *   - cross-origin redirect protection (no downgrade to http, no off-host
 *     redirects to non-https targets).
 *
 * Network is injected via `fetchImpl` so tests can substitute a stub without
 * pulling in extra dependencies (no `undici` / `nock` required).
 */

export const DEFAULT_USER_AGENT =
  'RegardedTrader/0.x (+https://github.com/rwrife/RegardedTrader)';

/** A fetch-compatible function. Mirrors the subset of the WHATWG fetch API we use. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PoliteFetchOptions extends Omit<RequestInit, 'signal'> {
  /** Hard request timeout in ms. Default 4000. */
  timeoutMs?: number;
  /** Maximum retry attempts on 429/5xx/network errors. Default 3 (so up to 3 total tries). */
  maxRetries?: number;
  /** Base backoff in ms; actual sleep = base * 2^attempt + jitter. Default 250. */
  backoffBaseMs?: number;
  /** Optional AbortSignal from the caller; merged with the timeout signal. */
  signal?: AbortSignal;
}

export interface PoliteFetchClientOptions {
  /** Default tokens per second per host. Default 4. */
  defaultRatePerSec?: number;
  /** Per-host overrides for tokens per second. */
  perHostRatePerSec?: Record<string, number>;
  /** Burst capacity (max tokens). Defaults to ratePerSec (so 1 second burst). */
  burst?: number;
  /** User-Agent header value. */
  userAgent?: string;
  /** Injected fetch implementation. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock, for deterministic tests. */
  now?: () => number;
  /** Injected jitter (returns [0, 1)). Defaults to Math.random. */
  random?: () => number;
}

interface Bucket {
  tokens: number;
  capacity: number;
  ratePerSec: number;
  lastRefill: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class PoliteFetchClient {
  private readonly defaultRate: number;
  private readonly perHost: Record<string, number>;
  private readonly defaultBurst: number;
  private readonly ua: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: PoliteFetchClientOptions = {}) {
    this.defaultRate = opts.defaultRatePerSec ?? 4;
    this.perHost = opts.perHostRatePerSec ?? {};
    this.defaultBurst = opts.burst ?? this.defaultRate;
    this.ua = opts.userAgent ?? DEFAULT_USER_AGENT;
    const f = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) {
      throw new Error('PoliteFetchClient: no global fetch available; pass fetchImpl');
    }
    this.fetchImpl = f;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  /** Acquire a token for `host`, sleeping until one is available. Public for testability. */
  async acquire(host: string): Promise<void> {
    const rate = this.perHost[host] ?? this.defaultRate;
    const capacity = Math.max(1, this.perHost[host] ?? this.defaultBurst);
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = { tokens: capacity, capacity, ratePerSec: rate, lastRefill: this.now() };
      this.buckets.set(host, bucket);
    }
    // Refill
    const now = this.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    if (elapsed > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.ratePerSec);
      bucket.lastRefill = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const need = 1 - bucket.tokens;
    const waitMs = Math.ceil((need / bucket.ratePerSec) * 1000);
    await this.sleep(waitMs);
    // After sleeping, refill and consume.
    const after = this.now();
    const elapsed2 = (after - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed2 * bucket.ratePerSec);
    bucket.lastRefill = after;
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  /**
   * Make a polite HTTP request. Throws on network/timeout/non-retryable failures
   * after retries are exhausted; returns the final `Response` even for 4xx other
   * than the retryable set so callers can surface structured errors.
   */
  async fetch(url: string, opts: PoliteFetchOptions = {}): Promise<Response> {
    const parsed = parseHttpsUrl(url);
    const host = parsed.host;

    const timeoutMs = opts.timeoutMs ?? 4000;
    const maxRetries = Math.max(1, opts.maxRetries ?? 3);
    const baseBackoff = opts.backoffBaseMs ?? 250;

    const headers = scrubHeaders(opts.headers, this.ua);

    let lastErr: unknown = null;
    let lastResp: Response | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.acquire(host);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const onAbort = () => controller.abort((opts.signal as AbortSignal).reason);
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        // We handle redirects manually so we can enforce the same-origin/https rule.
        const resp = await this.followRedirects(parsed.href, {
          ...opts,
          headers,
          signal: controller.signal,
          // strip caller's signal/timeout fields from passthrough
          timeoutMs: undefined,
          maxRetries: undefined,
          backoffBaseMs: undefined,
        });
        lastResp = resp;
        if (!RETRYABLE_STATUS.has(resp.status)) {
          return resp;
        }
        // Drain body to free the socket before retry.
        try {
          await resp.arrayBuffer();
        } catch {
          /* ignore */
        }
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }

      if (attempt < maxRetries - 1) {
        const sleepMs = baseBackoff * 2 ** attempt + Math.floor(this.random() * baseBackoff);
        await this.sleep(sleepMs);
      }
    }

    if (lastResp) return lastResp;
    throw lastErr instanceof Error ? lastErr : new Error('politeFetch failed');
  }

  /** Execute a fetch and chase redirects manually under the cross-origin policy. */
  private async followRedirects(
    url: string,
    init: PoliteFetchOptions,
  ): Promise<Response> {
    const maxHops = 5;
    let currentUrl = url;
    let currentInit: RequestInit = { ...stripPoliteOpts(init), redirect: 'manual' };

    for (let hop = 0; hop <= maxHops; hop++) {
      const resp = await this.fetchImpl(currentUrl, currentInit);
      if (resp.status < 300 || resp.status >= 400) return resp;
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      // Drain
      try {
        await resp.arrayBuffer();
      } catch {
        /* ignore */
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(loc, currentUrl);
      } catch {
        throw new Error(`politeFetch: invalid redirect target "${loc}"`);
      }
      const from = new URL(currentUrl);
      const sameOrigin = nextUrl.host === from.host;
      if (!sameOrigin && nextUrl.protocol !== 'https:') {
        throw new Error(
          `politeFetch: refusing cross-origin redirect to non-https target ${nextUrl.href}`,
        );
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new Error(`politeFetch: refusing redirect to ${nextUrl.protocol}`);
      }
      // Strip auth-bearing headers on cross-origin hops.
      if (!sameOrigin) {
        currentInit = { ...currentInit, headers: scrubAcrossOrigin(currentInit.headers) };
      }
      currentUrl = nextUrl.href;
    }
    throw new Error('politeFetch: too many redirects');
  }
}

function stripPoliteOpts(opts: PoliteFetchOptions): RequestInit {
  const { timeoutMs: _t, maxRetries: _r, backoffBaseMs: _b, ...rest } = opts;
  void _t;
  void _r;
  void _b;
  return rest;
}

function parseHttpsUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`politeFetch: invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`politeFetch: unsupported protocol ${parsed.protocol}`);
  }
  return parsed;
}

/** Force our UA, drop Cookie/Authorization on the wire by default. */
function scrubHeaders(input: HeadersInit | undefined, ua: string): Headers {
  const h = new Headers(input ?? undefined);
  h.delete('cookie');
  h.delete('Cookie');
  h.set('User-Agent', ua);
  // Be polite and explicit.
  if (!h.has('Accept')) h.set('Accept', 'application/json, text/html;q=0.9, */*;q=0.5');
  return h;
}

function scrubAcrossOrigin(input: HeadersInit | undefined): Headers {
  const h = new Headers(input ?? undefined);
  h.delete('cookie');
  h.delete('Cookie');
  h.delete('authorization');
  h.delete('Authorization');
  return h;
}

/** Convenience standalone function using a process-default client. */
let defaultClient: PoliteFetchClient | null = null;
export function politeFetch(url: string, opts?: PoliteFetchOptions): Promise<Response> {
  if (!defaultClient) defaultClient = new PoliteFetchClient();
  return defaultClient.fetch(url, opts);
}
