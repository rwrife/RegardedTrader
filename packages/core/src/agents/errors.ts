/**
 * Typed error surfaced by agents when the LLM returns a payload that fails
 * Zod validation (malformed JSON, missing required keys, wrong types).
 *
 * Callers can rely on `instanceof AgentParseError` to distinguish a hard
 * agent-parse failure from an agent that ran and returned a valid-but-empty
 * briefing (issue #165). The optional `raw` field carries the offending
 * LLM output for downstream logging; it is deliberately kept short in
 * error messages to avoid leaking large prompts into UI surfaces.
 */
export class AgentParseError extends Error {
  readonly agent: string;
  readonly issues: readonly string[];
  readonly raw?: string;

  constructor(agent: string, issues: readonly string[], raw?: string) {
    const detail = issues.length > 0 ? issues.join('; ') : 'invalid JSON';
    super(`${agent} produced an unparseable LLM response: ${detail}`);
    this.name = 'AgentParseError';
    this.agent = agent;
    this.issues = issues;
    this.raw = raw;
  }
}

export function isAgentParseError(e: unknown): e is AgentParseError {
  return e instanceof AgentParseError;
}
