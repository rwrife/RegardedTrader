/**
 * AiSentimentScorer tests (issue #37).
 *
 * All tests use a deterministic stub LLM so we exercise:
 *   - happy-path single + batch scoring,
 *   - `{provider, model, version}` provenance stamping,
 *   - rationale truncation to <= 240 chars,
 *   - StockTwits prior propagation into the prompt payload,
 *   - batch splitting past `batchSize`,
 *   - typed AgentParseError on malformed JSON / wrong shape / wrong length
 *     / duplicate ids / out-of-range ids,
 *   - defensive label/score coercion when the model disagrees with itself.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AiSentimentScorer,
  AI_SENTIMENT_SCORER_VERSION,
  SENTIMENT_SCORER_BATCH_SIZE,
} from './sentiment-scorer.js';
import type { LLM } from './llm.js';
import { AgentParseError, isAgentParseError } from './errors.js';
import type { MentionItem } from '../schemas/sentiment.js';

function fakeLLM(reply: string | ((system: string, user: string) => string)): {
  llm: LLM;
  calls: Array<{ system: string; user: string; json?: boolean }>;
} {
  const calls: Array<{ system: string; user: string; json?: boolean }> = [];
  const llm: LLM = {
    complete: vi.fn(async ({ system, user, json }) => {
      calls.push({ system, user, json });
      return typeof reply === 'function' ? reply(system, user) : reply;
    }),
  };
  return { llm, calls };
}

function mention(overrides: Partial<MentionItem> = {}): MentionItem {
  return {
    source: 'reddit',
    sourceId: overrides.sourceId ?? 'r-1',
    symbol: 'NVDA',
    text: 'Loading up on calls into earnings.',
    publishedAt: '2026-05-01T12:00:00.000Z',
    fetchedAt: '2026-05-01T12:00:05.000Z',
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-05-01T12:00:10.000Z');

function makeScorer(reply: string | ((s: string, u: string) => string), opts: {
  provider?: string;
  model?: string;
  batchSize?: number;
} = {}) {
  const { llm, calls } = fakeLLM(reply);
  const scorer = new AiSentimentScorer(llm, {
    provider: opts.provider ?? 'openai',
    model: opts.model ?? 'gpt-4o-mini',
    now: () => FIXED_NOW,
    batchSize: opts.batchSize,
  });
  return { scorer, calls };
}

describe('AiSentimentScorer', () => {
  it('scores a single mention and stamps provider/model/version + scoredAt', async () => {
    const { scorer } = makeScorer(
      JSON.stringify({
        scores: [
          {
            id: 0,
            score: 0.7,
            confidence: 0.8,
            label: 'bullish',
            rationale: 'Bought calls into ER — clearly bullish stance.',
          },
        ],
      }),
    );
    const [out] = await scorer.scoreBatch([mention()]);
    expect(out).toBeDefined();
    if (!out) throw new Error('unreachable');
    expect(out.symbol).toBe('NVDA');
    expect(out.sentiment.score).toBe(0.7);
    expect(out.sentiment.confidence).toBe(0.8);
    expect(out.sentiment.label).toBe('bullish');
    expect(out.sentiment.rationale).toMatch(/bullish stance/);
    expect(out.scoredAt).toBe(FIXED_NOW.toISOString());
    expect(out.scorer).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      version: AI_SENTIMENT_SCORER_VERSION,
    });
  });

  it('score() (single) wraps scoreBatch() and returns the single result', async () => {
    const { scorer } = makeScorer(
      JSON.stringify({
        scores: [{ id: 0, score: -0.6, confidence: 0.7, label: 'bearish' }],
      }),
    );
    const out = await scorer.score(mention({ text: 'This is done, puts loaded.' }));
    expect(out.sentiment.label).toBe('bearish');
    expect(out.sentiment.score).toBe(-0.6);
  });

  it('returns [] for an empty input array without calling the LLM', async () => {
    const { scorer, calls } = makeScorer('should-not-be-called');
    const out = await scorer.scoreBatch([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('propagates StockTwits self-declared bull/bear as a prompt prior', async () => {
    const { scorer, calls } = makeScorer(
      JSON.stringify({
        scores: [
          { id: 0, score: 0.5, confidence: 0.6, label: 'bullish' },
          { id: 1, score: -0.4, confidence: 0.6, label: 'bearish' },
        ],
      }),
    );
    await scorer.scoreBatch([
      mention({
        source: 'stocktwits',
        sourceId: 'st-1',
        text: 'To the moon',
        meta: { sentimentLabel: 'bullish' },
      }),
      mention({
        source: 'stocktwits',
        sourceId: 'st-2',
        text: 'Overextended',
        meta: { sentimentLabel: 'bearish' },
      }),
    ]);
    expect(calls).toHaveLength(1);
    const first = calls[0];
    if (!first) throw new Error('unreachable');
    const user = first.user;
    expect(user).toContain('"prior": "bullish"');
    expect(user).toContain('"prior": "bearish"');
    // System prompt is small and explicit and mentions the prior rule.
    expect(first.system).toMatch(/prior/i);
    expect(first.json).toBe(true);
  });

  it('honors the batch-size cap and splits large inputs across multiple LLM calls', async () => {
    // 25 mentions, batchSize=10 -> 3 calls of 10/10/5.
    const totals = [10, 10, 5];
    let callIdx = 0;
    const { scorer, calls } = makeScorer(() => {
      const n = totals[callIdx++] ?? 0;
      return JSON.stringify({
        scores: Array.from({ length: n }, (_, i) => ({
          id: i,
          score: 0,
          confidence: 0.4,
          label: 'neutral',
        })),
      });
    }, { batchSize: 10 });
    const inputs: MentionItem[] = Array.from({ length: 25 }, (_, i) =>
      mention({ sourceId: `r-${i}` }),
    );
    const out = await scorer.scoreBatch(inputs);
    expect(out).toHaveLength(25);
    expect(calls).toHaveLength(3);
    // Sourceids preserved 1:1 with inputs.
    expect(out.map((m) => m.sourceId)).toEqual(inputs.map((m) => m.sourceId));
  });

  it('caps configured batchSize at SENTIMENT_SCORER_BATCH_SIZE (20)', () => {
    expect(SENTIMENT_SCORER_BATCH_SIZE).toBe(20);
    expect(
      () =>
        new AiSentimentScorer(
          { complete: vi.fn() },
          { provider: 'p', model: 'm', batchSize: 21 },
        ),
    ).toThrow(/<= 20/);
    expect(
      () =>
        new AiSentimentScorer(
          { complete: vi.fn() },
          { provider: 'p', model: 'm', batchSize: 0 },
        ),
    ).toThrow(/>= 1/);
  });

  it('truncates rationale to 240 chars (with ellipsis) if the model overruns', async () => {
    const long = 'x'.repeat(500);
    const { scorer } = makeScorer(
      JSON.stringify({
        scores: [
          { id: 0, score: 0.3, confidence: 0.5, label: 'bullish', rationale: long },
        ],
      }),
    );
    const [out] = await scorer.scoreBatch([mention()]);
    expect(out).toBeDefined();
    if (!out) throw new Error('unreachable');
    expect(out.sentiment.rationale).toBeDefined();
    expect(out.sentiment.rationale!.length).toBeLessThanOrEqual(240);
    expect(out.sentiment.rationale!.endsWith('...')).toBe(true);
  });

  it('coerces label to agree with score when the model contradicts itself', async () => {
    const { scorer } = makeScorer(
      JSON.stringify({
        scores: [
          // Strongly bearish score but label claims bullish.
          { id: 0, score: -0.8, confidence: 0.9, label: 'bullish' },
        ],
      }),
    );
    const [out] = await scorer.scoreBatch([mention()]);
    expect(out).toBeDefined();
    if (!out) throw new Error('unreachable');
    expect(out.sentiment.label).toBe('bearish');
    expect(out.sentiment.score).toBe(-0.8);
  });

  it('throws AgentParseError on invalid JSON', async () => {
    const { scorer } = makeScorer('not json {');
    await expect(scorer.scoreBatch([mention()])).rejects.toSatisfy((e) =>
      isAgentParseError(e),
    );
  });

  it('throws AgentParseError when the reply shape is wrong', async () => {
    const { scorer } = makeScorer(JSON.stringify({ not: 'right' }));
    await expect(scorer.scoreBatch([mention()])).rejects.toBeInstanceOf(
      AgentParseError,
    );
  });

  it('throws AgentParseError when scored array length disagrees with input', async () => {
    const { scorer } = makeScorer(
      JSON.stringify({
        scores: [
          { id: 0, score: 0, confidence: 0.5, label: 'neutral' },
          { id: 1, score: 0, confidence: 0.5, label: 'neutral' },
        ],
      }),
    );
    await expect(
      scorer.scoreBatch([mention({ sourceId: 'only-one' })]),
    ).rejects.toBeInstanceOf(AgentParseError);
  });

  it('throws AgentParseError on duplicate or out-of-range ids', async () => {
    const dup = makeScorer(
      JSON.stringify({
        scores: [
          { id: 0, score: 0, confidence: 0.5, label: 'neutral' },
          { id: 0, score: 0, confidence: 0.5, label: 'neutral' },
        ],
      }),
    );
    await expect(
      dup.scorer.scoreBatch([mention({ sourceId: 'a' }), mention({ sourceId: 'b' })]),
    ).rejects.toThrow(/duplicate id/);

    const oor = makeScorer(
      JSON.stringify({
        scores: [{ id: 5, score: 0, confidence: 0.5, label: 'neutral' }],
      }),
    );
    await expect(oor.scorer.scoreBatch([mention()])).rejects.toThrow(/out of range/);
  });

  it('requests JSON mode from the LLM (json: true)', async () => {
    const { scorer, calls } = makeScorer(
      JSON.stringify({
        scores: [{ id: 0, score: 0, confidence: 0.5, label: 'neutral' }],
      }),
    );
    await scorer.scoreBatch([mention()]);
    const first = calls[0];
    if (!first) throw new Error('unreachable');
    expect(first.json).toBe(true);
  });
});
