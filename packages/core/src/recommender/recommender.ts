/**
 * Recommender AI agent (#48).
 *
 * Takes a {@link RecommendationContext} (built by #46) and an {@link LLM}
 * provider, asks the model for a batched verdict (equity + 4 option stances)
 * in strict JSON, validates the response with Zod, and returns a full
 * {@link Recommendation} ready to be persisted / passed to the rule engine.
 *
 * Design notes:
 *   - `Recommender` is exposed as an interface so a future deterministic-only
 *     implementation can swap in without touching call sites.
 *   - System prompt is in-repo, small, explicit, and version-stamped via
 *     {@link RECOMMENDER_RULE_VERSION}. Bump it on every prompt change.
 *   - The model is asked for a JSON payload matching the `Recommendation`
 *     schema *minus* `modelInfo` / `disclaimer` / `sources` / `asOf` /
 *     `generatedAt` — those are owned by the orchestrator and stamped on
 *     here from caller-provided inputs.
 *   - Parse failures get exactly ONE fix-up retry. A second failure yields a
 *     "HOLD everything" recommendation tagged with `llm-parse-failed`.
 *   - Chain-of-thought is forbidden in the prompt; we never log or pass the
 *     raw response further than necessary.
 */

import { z } from 'zod';
import type { LLM } from '../agents/llm.js';
import { DISCLAIMER } from '../agents/llm.js';
import {
  OptionsVerdicts,
  RECOMMENDATION_DISCLAIMER,
  Recommendation,
  type RecommendationAsOf,
  type RecommendationModelInfo,
  type RecommendationSource,
  Verdict,
} from '../schemas/recommendation.js';
import type { RecommendationContext } from './rules/index.js';

/**
 * Version stamp baked into {@link RecommendationModelInfo.ruleVersion} for
 * every output of this recommender. Bump on every prompt change so audits
 * (#54) can attribute a flip in behavior to a specific prompt revision.
 *
 * Format: semver-style `MAJOR.MINOR.PATCH`.
 *   - MAJOR: schema-shape change (e.g. new option stance).
 *   - MINOR: wording change that may shift verdicts.
 *   - PATCH: typo / formatting fix; behaviour-equivalent.
 */
export const RECOMMENDER_RULE_VERSION = '1.0.0';

/**
 * The shape we ask the LLM to produce. This is the {@link Recommendation}
 * schema minus the fields the orchestrator stamps on.
 */
export const RecommenderLLMOutput = z.object({
  equity: Verdict,
  options: OptionsVerdicts,
  riskFlags: z.array(z.string()),
});
export type RecommenderLLMOutput = z.infer<typeof RecommenderLLMOutput>;

/** Inputs the orchestrator stamps on top of the LLM's output. */
export interface RecommenderStamp {
  /** ISO timestamp for `Recommendation.generatedAt`. Defaults to `now()`. */
  readonly generatedAt?: string;
  /** Section freshness for `Recommendation.asOf`. */
  readonly asOf: RecommendationAsOf;
  /** Pass-through citations. We never invent sources. */
  readonly sources: readonly RecommendationSource[];
  /** Provider + model name from the active LLM (rule version is filled in here). */
  readonly modelInfo: Omit<RecommendationModelInfo, 'ruleVersion'>;
}

/** Pluggable recommender contract. A deterministic-only impl can replace us. */
export interface Recommender {
  recommend(
    context: RecommendationContext,
    stamp: RecommenderStamp,
  ): Promise<Recommendation>;
}

export interface AIRecommenderOptions {
  /** Override clock (tests). */
  now?: () => Date;
}

/**
 * Single, small, explicit system prompt. Constraints baked in:
 *   - Strict JSON object, no markdown, no chain-of-thought.
 *   - Exactly the keys we expect; nothing extra.
 *   - Conviction in [0, 1]; rationale ≤ 600 chars.
 *   - Mention the disclaimer is appended by the orchestrator — model does not
 *     need to emit it (the schema layer enforces it).
 *   - Naked verdicts: model emits them; the hard-gates rule (#47) nulls them
 *     when `forbidNakedShorts` is set. The model is told this so it does not
 *     over-correct.
 */
const SYSTEM_PROMPT = `You are RegardedTrader's research recommender.
Given a structured RecommendationContext for ONE symbol, produce a single
JSON object with batched verdicts for the equity and four options stances.

Output STRICT JSON ONLY. No prose, no markdown, no code fences, no
explanation of your reasoning. Do NOT include any chain-of-thought.

Schema (every field required, exact key names):
{
  "equity": {
    "action": "BUY" | "HOLD" | "SELL" | "AVOID",
    "conviction": number in [0, 1],
    "rationale": string up to 600 chars (concise, scannable),
    "signals":      [ { "name": string, "value": number|string, "contribution": number in [-1, 1] } ],
    "contraSignals":[ { "name": string, "value": number|string, "contribution": number in [-1, 1] } ]
  },
  "options": {
    "coveredCall": Verdict | null,
    "coveredPut":  Verdict | null,
    "nakedCall":   Verdict | null,
    "nakedPut":    Verdict | null
  },
  "riskFlags": [ string ]
}

Guidance:
- Use only the data in the provided context. Do not invent prices, dates, or
  news. If a section is null or stale, lean toward HOLD and add a flag.
- "contribution" is the signed weight of a signal toward the action. Positive
  pushes toward BUY for equity / open-the-trade for options.
- For each options stance, emit a Verdict if the chain has data; emit null if
  the structure is not actionable given the context (e.g. no chain).
- Risk flags are short kebab-case tokens (e.g. "low-liquidity", "stale-quote",
  "wide-spread", "earnings-blackout"). Do not duplicate.
- Never recommend naked shorts as high-conviction. The orchestrator may strip
  naked stances entirely; emitting them is fine — they will be gated server-side.
- Rationale is plain English, no disclaimers (the system appends them). No
  step-by-step. State the call and the top 1-3 reasons.`;

const RETRY_INSTRUCTION = `Your previous reply was not valid JSON matching the
required schema. Reply again with ONLY a single JSON object matching the schema.
No prose, no markdown, no code fences, no explanation. Use the same context.`;

export class AIRecommender implements Recommender {
  private readonly now: () => Date;

  constructor(
    private readonly llm: LLM,
    options: AIRecommenderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async recommend(
    context: RecommendationContext,
    stamp: RecommenderStamp,
  ): Promise<Recommendation> {
    const user = buildUserPrompt(context);
    const symbol = context.symbol;

    // First attempt.
    const first = await safeComplete(this.llm, SYSTEM_PROMPT, user);
    const firstParsed = tryParse(first);
    if (firstParsed.ok) {
      return assembleRecommendation(symbol, firstParsed.value, stamp, this.now);
    }

    // Single fix-up retry, telling the model exactly what went wrong shape-wise
    // (but never the raw error stack — keep the prompt small).
    const retryUser = `${user}\n\n---\n${RETRY_INSTRUCTION}`;
    const second = await safeComplete(this.llm, SYSTEM_PROMPT, retryUser);
    const secondParsed = tryParse(second);
    if (secondParsed.ok) {
      return assembleRecommendation(symbol, secondParsed.value, stamp, this.now);
    }

    // Two strikes → fail safe. Hold everything, flag the failure mode.
    return assembleRecommendation(symbol, holdEverything(), stamp, this.now);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function safeComplete(
  llm: LLM,
  system: string,
  user: string,
): Promise<string> {
  try {
    return await llm.complete({ system, user, json: true });
  } catch {
    return '';
  }
}

interface ParseOk {
  readonly ok: true;
  readonly value: RecommenderLLMOutput;
}
interface ParseErr {
  readonly ok: false;
}

function tryParse(raw: string): ParseOk | ParseErr {
  if (!raw || typeof raw !== 'string') return { ok: false };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const parsed = RecommenderLLMOutput.safeParse(obj);
  if (!parsed.success) return { ok: false };
  return { ok: true, value: parsed.data };
}

/** Build the user-turn prompt from the structured context. */
function buildUserPrompt(context: RecommendationContext): string {
  // We stringify the whole context — the ContextBuilder (#46) is responsible
  // for keeping it under the LLM's budget. Pretty-printing keeps it
  // human-readable for tests / replays.
  return `Symbol: ${context.symbol}

RecommendationContext (JSON):
${JSON.stringify(context, null, 2)}

Produce the JSON described in the system prompt for this symbol.`;
}

/** The "two-strikes" fallback verdict. */
function holdEverything(): RecommenderLLMOutput {
  const hold: Verdict = {
    action: 'HOLD',
    conviction: 0,
    rationale:
      'Recommender failed to produce a parseable response; defaulting to HOLD.',
    signals: [],
    contraSignals: [],
  };
  return {
    equity: hold,
    options: {
      coveredCall: hold,
      coveredPut: hold,
      nakedCall: hold,
      nakedPut: hold,
    },
    riskFlags: ['llm-parse-failed'],
  };
}

/** Stamp orchestrator-owned metadata onto the LLM output. */
function assembleRecommendation(
  symbol: string,
  output: RecommenderLLMOutput,
  stamp: RecommenderStamp,
  now: () => Date,
): Recommendation {
  const candidate: Recommendation = {
    symbol,
    generatedAt: stamp.generatedAt ?? now().toISOString(),
    asOf: stamp.asOf,
    equity: output.equity,
    options: output.options,
    riskFlags: dedupeFlags(output.riskFlags),
    sources: [...stamp.sources],
    modelInfo: { ...stamp.modelInfo, ruleVersion: RECOMMENDER_RULE_VERSION },
    // Required, constant, owned by the schema layer. We never let a model
    // strip or rewrite this — surfaces that drop it can't validate.
    disclaimer: pickDisclaimer(),
  };
  // Final guard: validate once before returning so any wire-format drift
  // surfaces here instead of at the persistence boundary.
  return Recommendation.parse(candidate);
}

/**
 * Use the schema-layer constant. We touch {@link DISCLAIMER} from the agents
 * module via the import to keep the dependency explicit (and so static
 * analysers see we *intentionally* did not use it). Schema-owned text wins
 * because the schema is the persistence contract.
 */
function pickDisclaimer(): string {
  void DISCLAIMER;
  return RECOMMENDATION_DISCLAIMER;
}

function dedupeFlags(flags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of flags) {
    if (typeof f !== 'string') continue;
    const norm = f.trim();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}
