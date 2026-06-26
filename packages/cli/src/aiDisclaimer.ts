import { DISCLAIMER } from '@regardedtrader/core/constants';

/**
 * Canonical disclaimer line for CLI/Ink AI surfaces (issue #154).
 *
 * Returns the project-wide `DISCLAIMER` constant from `@regardedtrader/core`
 * (the same string baked into `AiOutputEnvelope` for issue #77) so every
 * `regard <subcommand>` that renders LLM-influenced output prints the
 * identical "not financial advice / educational" message.
 *
 * Exposed as a function (not just a re-export) so callers — and future
 * formatting variants (e.g. colour, prefix) — have a single seam to update.
 */
export function aiDisclaimerLine(): string {
  return DISCLAIMER;
}

export { DISCLAIMER };
