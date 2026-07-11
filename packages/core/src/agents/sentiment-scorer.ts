/**
 * AI sentiment scorer (issue #37, parent #30).
 *
 * Given raw ticker mentions harvested by the polling layer (Reddit,
 * StockTwits, HN, news), score each one on a signed `[-1, 1]` sentiment
 * axis with a `[0, 1]` confidence and a `<=240` char rationale.
 *
 * The scorer is deliberately behind a small `SentimentScorer` interface so
 * a future local FinBERT-style model can replace the LLM call without
 * touching callers (recommender context, sentiment aggregator job).
 *
 * Design notes:
 * - System prompt is small, explicit, and lives in this file. We ask for
 *   a JSON *array* even when scoring a single mention so batch and single
 *   paths use the same code.
 * - Up to 20 mentions per call to keep cost bounded (batches beyond 20 are
 *   split by the scorer itself, not the caller).
 * - StockTwits self-declared bull/bear labels are surfaced to the model
 *   as a **prior**, not a decision. The model can override them when the
 *   text disagrees.
 * - Malformed JSON, wrong array length, or Zod failures raise a typed
 *   {@link AgentParseError} so callers can distinguish a hard parse
 *   failure from a real empty result (same pattern as Analyst — #165).
 * - `scorer: { provider, model, version }` is stamped on every
 *   `ScoredMention` so aggregate consumers can invalidate stale scores
 *   when the prompt/model changes.
 */
import type { LLM } from './llm.js';
import { AgentParseError } from './errors.js';
import {
  MentionItem,
  ScoredMention,
  SentimentLabel,
} from '../schemas/sentiment.js';
import { z } from 'zod';

/** Max mentions per LLM call. */
export const SENTIMENT_SCORER_BATCH_SIZE = 20;

/** Version tag stamped on every scored mention. Bump when SYSTEM changes. */
export const AI_SENTIMENT_SCORER_VERSION = 'ai-sentiment-scorer@1';

/**
 * Pluggable scorer contract. Callers depend on this — not on
 * `AiSentimentScorer` — so a local FinBERT scorer can be dropped in later
 * without changing the aggregator or recommender code paths.
 */
export interface SentimentScorer {
  score(mention: MentionItem): Promise<ScoredMention>;
  scoreBatch(mentions: readonly MentionItem[]): Promise<ScoredMention[]>;
}

/**
 * Wire schema the LLM is asked to produce. One entry per input mention,
 * same order, addressed by the caller-supplied `id` so the model can't
 * accidentally reorder or drop items silently.
 */
const ScoredEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  label: SentimentLabel,
  /**
   * The scorer prompt asks for <=240 chars. We defensively truncate on
   * output rather than reject a slightly-over reply, so the pipeline
   * doesn't stall on a chatty model.
   */
  rationale: z.string().max(2_000).optional(),
});

const ScorerReplySchema = z.object({
  scores: z.array(ScoredEntrySchema),
});

const SYSTEM = `You score short investor-facing text snippets about a single stock ticker for market sentiment.

For each input snippet, return exactly one JSON object with:
- id: the integer id you were given (do not renumber, do not skip)
- score: signed sentiment in [-1, 1] (-1 = strongly bearish, 0 = neutral, +1 = strongly bullish)
- confidence: how sure you are in [0, 1] (short/ambiguous text -> low confidence)
- label: one of "bearish" | "neutral" | "bullish" (must agree in sign with score)
- rationale: <= 240 characters, plain prose, no chain-of-thought, no lists, no markdown

Rules:
- Ground the score ONLY in the given snippet text and any prior. Never invent facts.
- The optional \`prior\` field is a self-declared bull/bear tag from the source (e.g. StockTwits). Treat it as weak evidence, not truth: if the text clearly contradicts the prior, follow the text and note it briefly in the rationale.
- Neutral covers factual/off-topic/spam. If the snippet doesn't actually express a view on the ticker, use label="neutral", score=0, confidence<=0.3.
- Output a single JSON object of the shape {"scores": [ ... ]} with one entry per input, in the same order. No extra keys, no prose outside the JSON.`;

interface ScorerInput {
  id: number;
  symbol: string;
  source: string;
  title?: string;
  text: string;
  prior?: 'bullish' | 'bearish' | 'neutral';
}

function toScorerInput(mention: MentionItem, id: number): ScorerInput {
  const prior = mention.meta?.sentimentLabel;
  return {
    id,
    symbol: mention.symbol,
    source: mention.source,
    title: mention.title,
    text: mention.text,
    prior,
  };
}

function truncateRationale(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export interface AiSentimentScorerOptions {
  /** Provider label recorded on every scored mention (e.g. "openai"). */
  provider: string;
  /** Model id recorded on every scored mention (e.g. "gpt-4o-mini"). */
  model: string;
  /** Override clock (tests). */
  now?: () => Date;
  /** Override version tag (tests / future prompt bumps). */
  version?: string;
  /** Override batch size (tests). */
  batchSize?: number;
}

/**
 * LLM-backed {@link SentimentScorer}. Batches inputs, validates the reply
 * shape, and stamps `{ provider, model, version }` on every result.
 */
export class AiSentimentScorer implements SentimentScorer {
  private readonly provider: string;
  private readonly model: string;
  private readonly version: string;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly llm: LLM,
    opts: AiSentimentScorerOptions,
  ) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.version = opts.version ?? AI_SENTIMENT_SCORER_VERSION;
    this.batchSize = opts.batchSize ?? SENTIMENT_SCORER_BATCH_SIZE;
    this.now = opts.now ?? (() => new Date());
    if (this.batchSize < 1) {
      throw new Error('AiSentimentScorer batchSize must be >= 1');
    }
    if (this.batchSize > SENTIMENT_SCORER_BATCH_SIZE) {
      throw new Error(
        `AiSentimentScorer batchSize must be <= ${SENTIMENT_SCORER_BATCH_SIZE}`,
      );
    }
  }

  async score(mention: MentionItem): Promise<ScoredMention> {
    const [scored] = await this.scoreBatch([mention]);
    if (!scored) {
      throw new AgentParseError(
        'AiSentimentScorer',
        ['scorer returned no entries for a single-mention call'],
      );
    }
    return scored;
  }

  async scoreBatch(
    mentions: readonly MentionItem[],
  ): Promise<ScoredMention[]> {
    if (mentions.length === 0) return [];
    const out: ScoredMention[] = [];
    for (const batch of chunk(mentions, this.batchSize)) {
      const scored = await this.scoreOneBatch(batch);
      out.push(...scored);
    }
    return out;
  }

  private async scoreOneBatch(
    batch: readonly MentionItem[],
  ): Promise<ScoredMention[]> {
    const payload: ScorerInput[] = batch.map((m, i) => toScorerInput(m, i));
    const user = `Score the following ${payload.length} snippet(s). Return {"scores":[...]} with exactly ${payload.length} entries, one per id, in order.

${JSON.stringify(payload, null, 2)}`;

    const raw = await this.llm.complete({ system: SYSTEM, user, json: true });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new AgentParseError(
        'AiSentimentScorer',
        [(err as Error).message ?? 'invalid JSON'],
        raw,
      );
    }

    const result = ScorerReplySchema.safeParse(parsedJson);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
      );
      throw new AgentParseError('AiSentimentScorer', issues, raw);
    }

    const entries = result.data.scores;
    if (entries.length !== batch.length) {
      throw new AgentParseError(
        'AiSentimentScorer',
        [
          `expected ${batch.length} scored entries, got ${entries.length}`,
        ],
        raw,
      );
    }

    // Index entries by id and require every input id to appear exactly once.
    const byId = new Map<number, (typeof entries)[number]>();
    for (const e of entries) {
      if (e.id < 0 || e.id >= batch.length) {
        throw new AgentParseError(
          'AiSentimentScorer',
          [`entry id ${e.id} out of range (0..${batch.length - 1})`],
          raw,
        );
      }
      if (byId.has(e.id)) {
        throw new AgentParseError(
          'AiSentimentScorer',
          [`duplicate id ${e.id} in scorer reply`],
          raw,
        );
      }
      byId.set(e.id, e);
    }

    const scoredAt = this.now().toISOString();
    const out: ScoredMention[] = [];
    for (let i = 0; i < batch.length; i++) {
      const source = batch[i];
      if (!source) {
        // Unreachable given the for-loop bound, but the strict
        // noUncheckedIndexedAccess compiler flag doesn't know that.
        throw new AgentParseError(
          'AiSentimentScorer',
          [`missing mention for id ${i}`],
          raw,
        );
      }
      const entry = byId.get(i);
      if (!entry) {
        throw new AgentParseError(
          'AiSentimentScorer',
          [`missing scored entry for id ${i}`],
          raw,
        );
      }
      // Enforce sign/label agreement defensively; if the model contradicts
      // itself, trust `score` and coerce the label so downstream aggregate
      // code can rely on both fields.
      const label = coerceLabel(entry.score, entry.label);
      const scored: ScoredMention = {
        ...source,
        sentiment: {
          score: entry.score,
          confidence: entry.confidence,
          label,
          ...(entry.rationale !== undefined
            ? { rationale: truncateRationale(entry.rationale) }
            : {}),
        },
        scoredAt,
        scorer: {
          provider: this.provider,
          model: this.model,
          version: this.version,
        },
      };
      // Belt-and-braces: validate the emitted object against the outward
      // schema so a future refactor can't silently break the wire shape.
      out.push(ScoredMention.parse(scored));
    }
    return out;
  }
}

function coerceLabel(
  score: number,
  label: SentimentLabel,
): SentimentLabel {
  if (score > 0.15 && label !== 'bullish') return 'bullish';
  if (score < -0.15 && label !== 'bearish') return 'bearish';
  if (score >= -0.15 && score <= 0.15 && label !== 'neutral') return 'neutral';
  return label;
}
