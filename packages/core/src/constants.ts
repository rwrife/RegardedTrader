/**
 * Canonical project-wide constants (issue #77).
 *
 * The `DISCLAIMER` string is the single source of truth for the
 * "not financial advice / educational" message required by AGENTS.md hard
 * rule #4. Every user-facing surface that emits an LLM opinion must include
 * this exact string (via the `AiOutputEnvelope` schema in
 * `schemas/envelope.ts`), so omitting it becomes a Zod validation error.
 */
export const DISCLAIMER =
  'Educational/research output. Not financial advice. You are responsible for your own trades.';
