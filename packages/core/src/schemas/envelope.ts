import { z, type ZodTypeAny } from 'zod';
import { DISCLAIMER } from '../constants.js';

/**
 * `AiOutputEnvelope<T>` (issue #77) — shared schema mixin that wraps any
 * agent payload with the legally-required disclaimer and a `sourcesUsed`
 * audit trail.
 *
 * Hard rule #4 in AGENTS.md ("Not financial advice") is enforced *at the
 * schema boundary* by this envelope: an envelope with an empty
 * `disclaimer` is a Zod validation error, so no future refactor can
 * silently ship an LLM opinion without the disclaimer.
 *
 * Usage:
 *
 *     const Envelope = AiOutputEnvelope(MyPayloadSchema);
 *     type EnvelopeT = z.infer<typeof Envelope>;
 *
 * The factory is a function (not a generic class) so each agent can pick
 * its own payload shape while sharing the disclaimer/sourcesUsed contract.
 */
export function AiOutputEnvelope<T extends ZodTypeAny>(payload: T) {
  return z.object({
    disclaimer: z.string().min(1, 'disclaimer must be non-empty'),
    sourcesUsed: z.array(z.string()).default([]),
    data: payload,
  });
}

/**
 * Type helper for envelopes. `AiEnvelope<MyType>` is the static-typed shape
 * matching the Zod `AiOutputEnvelope(MyZodSchema)` output.
 */
export interface AiEnvelope<T> {
  disclaimer: string;
  sourcesUsed: string[];
  data: T;
}

/**
 * Wrap a payload with the canonical disclaimer. Convenience for in-process
 * code that builds envelopes by hand. The wire/storage seam should still
 * validate via `AiOutputEnvelope(...).parse(...)`.
 */
export function envelope<T>(data: T, sourcesUsed: string[] = []): AiEnvelope<T> {
  return { disclaimer: DISCLAIMER, sourcesUsed, data };
}
