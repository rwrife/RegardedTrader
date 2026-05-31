/**
 * HardGates — v1 non-negotiable guardrails for recommender output.
 *
 * See `./index.ts` for the `Rule` interface and the epic spec (#44, #47).
 *
 * Application order matters and is deliberate:
 *   1. `no-options-chain` — strip every options verdict when we have no chain.
 *   2. `naked-shorts-forbidden` — null naked verdicts when caps forbid them.
 *   3. `stale-quote` — clamp every remaining verdict's conviction.
 *   4. `low-confidence` — force HOLD when aggregate confidence < 0.3.
 *
 * Why this order: stripping verdicts (1, 2) BEFORE computing the aggregate
 * confidence (4) avoids letting a high-confidence naked-short bump the
 * average above the gate when the verdict itself is about to be nulled.
 * Clamping (3) before the aggregate intentionally lowers the average for
 * stale data so weak signals collapse to HOLD instead of riding through.
 */

import type {
  OptionsVerdicts,
  Recommendation,
  Verdict,
} from '../../schemas/recommendation.js';
import type { RecommendationContext, Rule } from './index.js';

/** Bumped whenever the gate logic changes; surfaces in audit/eval tools. */
export const HARD_GATES_VERSION = '1.0.0';

/** Constants kept explicit so they show up in tests and audits. */
const LOW_CONFIDENCE_THRESHOLD = 0.3;
const STALE_QUOTE_CONVICTION_CAP = 0.5;

export const HARD_GATE_FLAGS = {
  noOptionsChain: 'no-options-chain',
  nakedShortsForbidden: 'naked-shorts-forbidden',
  staleQuote: 'stale-quote',
  lowConfidence: 'low-confidence',
} as const;

export interface HardGatesOptions {
  /** Override the low-confidence cutoff. Default: 0.3. */
  readonly lowConfidenceThreshold?: number;
  /** Override the stale-quote conviction clamp. Default: 0.5. */
  readonly staleConvictionCap?: number;
}

export class HardGates implements Rule {
  readonly name = 'HardGates';
  readonly version = HARD_GATES_VERSION;

  private readonly lowConfidenceThreshold: number;
  private readonly staleConvictionCap: number;

  constructor(options: HardGatesOptions = {}) {
    this.lowConfidenceThreshold =
      options.lowConfidenceThreshold ?? LOW_CONFIDENCE_THRESHOLD;
    this.staleConvictionCap =
      options.staleConvictionCap ?? STALE_QUOTE_CONVICTION_CAP;
  }

  apply(ctx: RecommendationContext, draft: Recommendation): Recommendation {
    let next: Recommendation = draft;
    const flags: string[] = [];

    // 1. No options chain — null every options verdict.
    if (!ctx.options || !ctx.options.hasChain) {
      next = {
        ...next,
        options: {
          coveredCall: null,
          coveredPut: null,
          nakedCall: null,
          nakedPut: null,
        },
      };
      flags.push(HARD_GATE_FLAGS.noOptionsChain);
    }

    // 2. Naked-shorts cap — null naked verdicts (only meaningful if a
    //    chain exists; the previous gate already nulled everything).
    if (
      ctx.risk.forbidNakedShorts &&
      (next.options.nakedCall !== null || next.options.nakedPut !== null)
    ) {
      next = {
        ...next,
        options: { ...next.options, nakedCall: null, nakedPut: null },
      };
      flags.push(HARD_GATE_FLAGS.nakedShortsForbidden);
    }

    // 3. Stale quote — clamp conviction across every remaining verdict.
    if (ctx.quote.stale) {
      next = {
        ...next,
        equity: clampConviction(next.equity, this.staleConvictionCap),
        options: clampOptionsConviction(next.options, this.staleConvictionCap),
      };
      flags.push(HARD_GATE_FLAGS.staleQuote);
    }

    // 4. Low aggregate confidence — force equity HOLD; collapse non-null
    //    option verdicts to HOLD as well so surfaces don't show stale BUYs.
    const aggregate = aggregateConviction(next);
    if (aggregate !== null && aggregate < this.lowConfidenceThreshold) {
      next = {
        ...next,
        equity: forceHold(next.equity, 'aggregate confidence below threshold'),
        options: forceHoldAcrossOptions(
          next.options,
          'aggregate confidence below threshold',
        ),
      };
      flags.push(HARD_GATE_FLAGS.lowConfidence);
    }

    if (flags.length === 0) return next;
    return { ...next, riskFlags: mergeFlags(next.riskFlags, flags) };
  }
}

/** Convenience singleton with default thresholds. */
export const hardGatesRule: Rule = new HardGates();

// ---------- helpers ---------------------------------------------------------

function clampConviction(v: Verdict, cap: number): Verdict {
  if (v.conviction <= cap) return v;
  return { ...v, conviction: cap };
}

function clampOptionsConviction(o: OptionsVerdicts, cap: number): OptionsVerdicts {
  return {
    coveredCall: o.coveredCall ? clampConviction(o.coveredCall, cap) : null,
    coveredPut: o.coveredPut ? clampConviction(o.coveredPut, cap) : null,
    nakedCall: o.nakedCall ? clampConviction(o.nakedCall, cap) : null,
    nakedPut: o.nakedPut ? clampConviction(o.nakedPut, cap) : null,
  };
}

/**
 * Mean of conviction across the equity verdict and every non-null options
 * verdict. Returns `null` when nothing has been left to average (which
 * can't happen in practice — `equity` is always present — but the
 * defensive check keeps the gate honest if the schema ever changes).
 */
function aggregateConviction(r: Recommendation): number | null {
  const convictions: number[] = [r.equity.conviction];
  for (const v of [
    r.options.coveredCall,
    r.options.coveredPut,
    r.options.nakedCall,
    r.options.nakedPut,
  ]) {
    if (v !== null) convictions.push(v.conviction);
  }
  if (convictions.length === 0) return null;
  const sum = convictions.reduce((a, b) => a + b, 0);
  return sum / convictions.length;
}

function forceHold(v: Verdict, reason: string): Verdict {
  if (v.action === 'HOLD') return v;
  const prefix = `[HardGates: ${reason}] `;
  // Verdict.rationale has a 600-char cap (per schema); guard the slice.
  const rationale = (prefix + v.rationale).slice(0, 600);
  return { ...v, action: 'HOLD', rationale };
}

function forceHoldAcrossOptions(
  o: OptionsVerdicts,
  reason: string,
): OptionsVerdicts {
  return {
    coveredCall: o.coveredCall ? forceHold(o.coveredCall, reason) : null,
    coveredPut: o.coveredPut ? forceHold(o.coveredPut, reason) : null,
    nakedCall: o.nakedCall ? forceHold(o.nakedCall, reason) : null,
    nakedPut: o.nakedPut ? forceHold(o.nakedPut, reason) : null,
  };
}

function mergeFlags(existing: readonly string[], added: readonly string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const f of added) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
