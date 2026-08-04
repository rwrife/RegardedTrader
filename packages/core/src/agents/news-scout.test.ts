import { describe, expect, it } from 'vitest';
import type { LLM } from './llm.js';
import { NewsScout } from './news-scout.js';

const inputNews = [
  {
    title: 'NVIDIA announces new enterprise AI chips',
    url: 'https://example.com/nvda-ai',
    source: 'Reuters',
    publishedAt: '2026-08-03T10:00:00.000Z',
  },
  {
    title: 'Analyst raises NVIDIA target ahead of earnings',
    url: 'https://example.com/nvda-target',
    source: 'Bloomberg',
    publishedAt: '2026-08-03T09:00:00.000Z',
  },
];

function llmReply(json: object): LLM {
  return {
    async complete() {
      return JSON.stringify(json);
    },
  };
}

describe('NewsScout', () => {
  it('builds a scored headline bundle and preserves ranked order from the model', async () => {
    const scout = new NewsScout(
      llmReply({
        summary: 'Coverage is net positive into earnings with one macro risk.',
        headlines: [
          { id: 'h2', relevance: 5, materiality: 5, rationale: 'Direct earnings catalyst.' },
          { id: 'h1', relevance: 4, materiality: 3, rationale: 'Supports demand narrative.' },
        ],
      }),
      { now: () => new Date('2026-08-03T12:00:00.000Z') },
    );

    const bundle = await scout.bundle({ symbol: 'NVDA', news: inputNews });
    expect(bundle.symbol).toBe('NVDA');
    expect(bundle.headlines).toHaveLength(2);
    expect(bundle.headlines[0]?.id).toBe('h2');
    expect(bundle.headlines[0]?.title).toContain('Analyst raises');
    expect(bundle.headlines[0]?.relevance).toBe(5);
    expect(bundle.headlines[0]?.materiality).toBe(5);
    expect(bundle.summary).toMatch(/net positive/i);
    expect(bundle.disclaimer).toMatch(/Not financial advice/i);
  });

  it('maps scored headlines into briefing-shaped scout output', async () => {
    const scout = new NewsScout(
      llmReply({
        summary: 'Mixed setup; monitor earnings timing and guidance.',
        headlines: [{ id: 'h1', relevance: 5, materiality: 4, rationale: 'Near-term catalyst.' }],
      }),
    );

    const out = await scout.scout({ symbol: 'NVDA', news: inputNews });
    expect(out.summary).toMatch(/Mixed setup/i);
    expect(out.headlines[0]?.title).toContain('NVIDIA announces');
    expect(out.disclaimer).toMatch(/Not financial advice/i);
  });
});

