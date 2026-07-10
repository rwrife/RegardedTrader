import { z } from 'zod';

/**
 * Options + telemetry schemas for the recommender `ContextBuilder` char
 * budget guard (issue #125).
 *
 * `ContextBuilder` itself is called in-process by the recommender and both
 * agents (analyst, options-strategist). It does not cross a wire, so the
 * Zod schema here is *not* used to validate every call — it exists so that:
 *
 *   1. Wire-facing configs that expose these options (e.g. a future
 *      `POST /recommender/preview` endpoint or a debug dump) can validate
 *      them against a single source of truth.
 *   2. The size telemetry emitted through the `onTelemetry` hook can be
 *      re-serialized (for structured logs or the debug channel) and later
 *      validated without a manual duplicate.
 *
 * Keeping these under `core/src/schemas/` matches AGENTS.md rule 9:
 * "All server <-> client payloads have Zod schemas in `core/src/schemas/`."
 * Even in-process telemetry benefits from the same discipline so we never
 * grow a second, drifting shape.
 */

/**
 * Public knobs the caller can hand to `buildRecommendationContext` for
 * budgeting. `maxChars` is preferred over the legacy `budgetChars` name;
 * `maxTokens` is a convenience that gets converted via `charsPerToken`.
 * Zero and negative values are rejected: a 0-char budget would degenerate
 * to "drop everything" and mask real caller bugs.
 */
export const ContextBudgetOptionsSchema = z.object({
  /** Hard char cap on the variable-length sections. Preferred name. */
  maxChars: z.number().int().positive().optional(),
  /**
   * Approximate token cap. Converted to chars via `charsPerToken`
   * (default 4, matches OpenAI's rough "~4 chars per token" rule of
   * thumb). When both `maxChars` and `maxTokens` are supplied, the more
   * conservative (smaller) value wins.
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * Chars-per-token conversion factor. Default 4. Only used when
   * `maxTokens` is set.
   */
  charsPerToken: z.number().positive().optional(),
});
export type ContextBudgetOptions = z.infer<typeof ContextBudgetOptionsSchema>;

/**
 * Per-section char counts emitted alongside the built context.
 * Mirrors `ContextBudgetReport.chars` but promoted to a Zod schema so
 * telemetry consumers (debug log channel, future observability sinks)
 * can validate the payload independently of the internal TS type.
 */
export const ContextBudgetSectionCharsSchema = z.object({
  history: z.number().int().nonnegative(),
  indicators: z.number().int().nonnegative(),
  options: z.number().int().nonnegative(),
  sentiment: z.number().int().nonnegative(),
  news: z.number().int().nonnegative(),
  opinions: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ContextBudgetSectionChars = z.infer<typeof ContextBudgetSectionCharsSchema>;

/**
 * Single per-build size telemetry payload. Delivered via the
 * `onTelemetry` hook once the char budget has been applied.
 *
 * Contract:
 *   - No PII: `symbol` is a public ticker; no user identifiers travel here.
 *   - No key material: this payload never carries API keys or provider
 *     credentials. Producers must not add fields that could leak them.
 *   - `truncated` is `true` iff at least one section had entries dropped
 *     to fit the budget. `truncatedSections` lists which ones.
 *   - `approxTokens` is derived from `chars.total / charsPerToken` and is
 *     intentionally coarse; consumers that need exact token counts
 *     should tokenize themselves.
 */
export const ContextBudgetTelemetrySchema = z.object({
  symbol: z.string().min(1),
  builtAt: z.string(), // ISO
  budgetChars: z.number().int().positive(),
  chars: ContextBudgetSectionCharsSchema,
  approxTokens: z.number().int().nonnegative(),
  charsPerToken: z.number().positive(),
  truncated: z.boolean(),
  truncatedSections: z.array(z.string()),
});
export type ContextBudgetTelemetry = z.infer<typeof ContextBudgetTelemetrySchema>;

/** Default chars-per-token used when the caller doesn't override. */
export const DEFAULT_CHARS_PER_TOKEN = 4;
