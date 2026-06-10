import { describe, expect, it, vi, afterEach } from 'vitest';
import { DuckDuckGoSearch, parseDdgHtml } from './web-search.js';

/**
 * Regression tests for the "ticker not found" bug.
 *
 * Background: the previous implementation POSTed to html.duckduckgo.com with
 * a custom RegardedTrader User-Agent. DDG responds to that combination with
 * an HTTP 202 JavaScript-only stub page that contains no result__a anchors,
 * so the parser returned [], and TickerValidator concluded the symbol did
 * not exist. The fix is GET + a real-browser User-Agent.
 *
 * We can't hit the real network in unit tests, so we assert the request
 * shape and the parser behavior separately.
 */

describe('DuckDuckGoSearch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues a GET with a desktop browser User-Agent (regression: add stock)', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const body =
        '<html><body>' +
        '<a class="result__a" href="https://example.com/nvda">NVIDIA Corp (NVDA)</a>' +
        '<a class="result__snippet" href="#">NVIDIA Corporation designs GPUs.</a>' +
        '</body></html>';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const ddg = new DuckDuckGoSearch();
    const results = await ddg.search('NVDA stock', { limit: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
    expect(calls[0]?.url).toContain('q=NVDA%20stock');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('user-agent') ?? '').toMatch(/Mozilla\/5\.0.*Chrome\//);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toContain('NVIDIA');
    expect(results[0]?.url).toBe('https://example.com/nvda');
  });

  it('throws on non-2xx so TickerValidator surfaces a clear error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    const ddg = new DuckDuckGoSearch();
    await expect(ddg.search('NVDA')).rejects.toThrow(/503/);
  });
});

describe('parseDdgHtml', () => {
  it('returns [] on the JS-only 202 stub page (the old buggy response)', () => {
    // Anything without result__a anchors should produce no results, and our
    // fix is to avoid this response shape entirely.
    expect(parseDdgHtml('<html><body><h1>Need JS</h1></body></html>')).toEqual([]);
  });

  it('unwraps DDG /l/?uddg=... redirect links', () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=' +
      encodeURIComponent('https://example.com/aapl') +
      '">Apple Inc.</a>' +
      '<a class="result__snippet" href="#">Designs iPhones.</a>';
    const out = parseDdgHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://example.com/aapl');
    expect(out[0]?.title).toBe('Apple Inc.');
  });
});
