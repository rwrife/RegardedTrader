import { z } from 'zod';
import { Ticker } from './index.js';
import { DISCLAIMER } from '../constants.js';

/**
 * Canonical research disclaimer baked into every Recommendation. Surfaces
 * are required to render this verbatim. Defined here (rather than in
 * `agents/llm.ts`) so the schema layer owns its own constants and doesn't
 * pull in any agent code.
 */
export const RECOMMENDATION_DISCLAIMER =
  DISCLAIMER;

/** Strategy buckets a single `Recommendation` covers per symbol. */
export const RecommendationKind = z.enum([
  'equity',
  'covered_call',
  'covered_put',
  'naked_call',
  'naked_put',
]);
export type RecommendationKind = z.infer<typeof RecommendationKind>;

/** A single named signal feeding into a Verdict. `contribution` is signed. */
export const Signal = z.object({
  name: z.string().min(1),
  value: z.union([z.number(), z.string()]),
  contribution: z.number().min(-1).max(1),
});
export type Signal = z.infer<typeof Signal>;

/**
 * A single rated opinion: action + conviction + the signals that produced it.
 * `rationale` is intentionally short — surfaces render it as scannable copy.
 */
export const Verdict = z.object({
  action: z.enum(['BUY', 'HOLD', 'SELL', 'AVOID']),
  conviction: z.number().min(0).max(1),
  rationale: z.string().max(600),
  signals: z.array(Signal),
  contraSignals: z.array(Signal),
});
export type Verdict = z.infer<typeof Verdict>;

/** Bundle of Verdicts for the four option-style stances around a symbol. */
export const OptionsVerdicts = z.object({
  coveredCall: Verdict.nullable(),
  coveredPut: Verdict.nullable(),
  /** Hard-gated null when `RiskOfficer.forbidNakedShorts === true`. */
  nakedCall: Verdict.nullable(),
  nakedPut: Verdict.nullable(),
});
export type OptionsVerdicts = z.infer<typeof OptionsVerdicts>;

/** ISO timestamps of the underlying snapshot kinds that fed this rec. */
export const RecommendationAsOf = z.object({
  quote: z.string(),
  options: z.string().nullable(),
  sentiment: z.string().nullable(),
  news: z.string().nullable(),
});
export type RecommendationAsOf = z.infer<typeof RecommendationAsOf>;

/** Pass-through citation; we never invent these — they come from inputs. */
export const RecommendationSource = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});
export type RecommendationSource = z.infer<typeof RecommendationSource>;

/** Provenance — which model / rule version produced this. */
export const RecommendationModelInfo = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  ruleVersion: z.string().min(1),
});
export type RecommendationModelInfo = z.infer<typeof RecommendationModelInfo>;

/**
 * A full recommendation for one symbol at one point in time. Persisted
 * append-only by `RecommendationStore` (#45) for self-evaluation later.
 *
 * The `disclaimer` field is required and constrained at the schema layer so
 * a surface that strips it can't pass validation. Use `RECOMMENDATION_DISCLAIMER`
 * as the canonical value.
 */
export const Recommendation = z.object({
  symbol: Ticker,
  generatedAt: z.string(),
  asOf: RecommendationAsOf,
  equity: Verdict,
  options: OptionsVerdicts,
  riskFlags: z.array(z.string()),
  sources: z.array(RecommendationSource),
  modelInfo: RecommendationModelInfo,
  disclaimer: z.string().min(1),
});
export type Recommendation = z.infer<typeof Recommendation>;
