import { describe, it, expect, vi } from 'vitest';
import { TickerValidator } from './ticker-validator.js';
import type { WebSearch, WebSearchResult } from '../clients/web-search.js';
import type { LLM } from './llm.js';

function fakeSearch(results: WebSearchResult[]): WebSearch {
  return { search: vi.fn().mockResolvedValue(results) };
}

function fakeLLM(reply: string): LLM {
  return { complete: vi.fn().mockResolvedValue(reply) };
}

const NVDA_RESULTS: WebSearchResult[] = [
  {
    title: 'NVIDIA Corporation (NVDA) Stock Price, News, Quote & History',
    url: 'https://finance.yahoo.com/quote/NVDA',
    snippet:
      'NVIDIA Corporation designs and supplies graphics processors and AI chips. Listed on NASDAQ.',
  },
  {
    title: 'NVIDIA Corp Common Stock (NVDA) Quote — Nasdaq',
    url: 'https://www.nasdaq.com/market-activity/stocks/nvda',
    snippet: 'Sector: Technology · Industry: Semiconductors',
  },
];

describe('TickerValidator', () => {
  it('returns a TickerProfile when LLM confirms a single match', async () => {
    const search = fakeSearch(NVDA_RESULTS);
    const llm = fakeLLM(
      JSON.stringify({
        match: true,
        profile: {
          symbol: 'NVDA',
          name: 'NVIDIA Corporation',
          exchange: 'NASDAQ',
          sector: 'Technology',
          industry: 'Semiconductors',
          description: 'Designs GPUs and AI accelerators.',
        },
      }),
    );
    const v = new TickerValidator({
      webSearch: search,
      llm,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const r = await v.validate('nvda');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.symbol).toBe('NVDA');
      expect(r.profile.exchange).toBe('NASDAQ');
      expect(r.profile.sources.length).toBeGreaterThan(0);
      expect(r.profile.validatedAt).toBe('2026-01-01T00:00:00.000Z');
    }
    expect(search.search).toHaveBeenCalledOnce();
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('rejects symbols with invalid shape without searching', async () => {
    const search = fakeSearch([]);
    const llm = fakeLLM('{}');
    const v = new TickerValidator({ webSearch: search, llm });
    const r = await v.validate('not a ticker!!!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid ticker shape/);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('returns suggestions when LLM says ambiguous', async () => {
    const search = fakeSearch(NVDA_RESULTS);
    const llm = fakeLLM(
      JSON.stringify({
        match: false,
        reason: 'Could refer to two different equities.',
        suggestions: [
          { symbol: 'meta', name: 'Meta Platforms' },
          { symbol: 'METB', name: 'Some other thing' },
        ],
      }),
    );
    const v = new TickerValidator({ webSearch: search, llm });
    const r = await v.validate('META');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.suggestions.map((s) => s.symbol)).toEqual(['META', 'METB']);
    }
  });

  it('flags canonical mismatch as ambiguous', async () => {
    const search = fakeSearch(NVDA_RESULTS);
    const llm = fakeLLM(
      JSON.stringify({
        match: true,
        profile: {
          symbol: 'AAPL',
          name: 'Apple',
          exchange: 'NASDAQ',
          sector: 'Tech',
          industry: 'Hardware',
          description: 'Apple Inc.',
        },
      }),
    );
    const v = new TickerValidator({ webSearch: search, llm });
    const r = await v.validate('NVDA');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Ambiguous/);
      expect(r.suggestions[0]?.symbol).toBe('AAPL');
    }
  });

  it('handles malformed LLM JSON gracefully', async () => {
    const search = fakeSearch(NVDA_RESULTS);
    const llm = fakeLLM('not json');
    const v = new TickerValidator({ webSearch: search, llm });
    const r = await v.validate('NVDA');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-JSON/);
  });

  it('returns an error when no search results come back', async () => {
    const search = fakeSearch([]);
    const llm = fakeLLM('{}');
    const v = new TickerValidator({ webSearch: search, llm });
    const r = await v.validate('ZZZZ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No web search results/);
  });

  it('surfaces web search failures', async () => {
    const search: WebSearch = { search: vi.fn().mockRejectedValue(new Error('boom')) };
    const llm = fakeLLM('{}');
    const v = new TickerValidator({ webSearch: search, llm });
    const r = await v.validate('NVDA');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Web search failed: boom/);
  });
});
