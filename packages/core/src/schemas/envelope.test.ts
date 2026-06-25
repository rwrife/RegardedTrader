import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AiOutputEnvelope, envelope } from './envelope.js';
import { DISCLAIMER } from '../constants.js';

const Payload = z.object({ value: z.string() });

describe('AiOutputEnvelope', () => {
  it('accepts a non-empty disclaimer + payload', () => {
    const env = AiOutputEnvelope(Payload).parse({
      disclaimer: DISCLAIMER,
      sourcesUsed: ['unit-test'],
      data: { value: 'hi' },
    });
    expect(env.disclaimer).toBe(DISCLAIMER);
    expect(env.sourcesUsed).toEqual(['unit-test']);
    expect(env.data.value).toBe('hi');
  });

  it('rejects an empty disclaimer (issue #77 schema enforcement)', () => {
    expect(() =>
      AiOutputEnvelope(Payload).parse({
        disclaimer: '',
        sourcesUsed: [],
        data: { value: 'hi' },
      }),
    ).toThrow();
  });

  it('rejects a missing disclaimer', () => {
    expect(() =>
      AiOutputEnvelope(Payload).parse({
        sourcesUsed: [],
        data: { value: 'hi' },
      }),
    ).toThrow();
  });

  it('rejects a malformed inner payload', () => {
    expect(() =>
      AiOutputEnvelope(Payload).parse({
        disclaimer: DISCLAIMER,
        sourcesUsed: [],
        data: { value: 123 },
      }),
    ).toThrow();
  });

  it('defaults sourcesUsed to []', () => {
    const env = AiOutputEnvelope(Payload).parse({
      disclaimer: DISCLAIMER,
      data: { value: 'hi' },
    });
    expect(env.sourcesUsed).toEqual([]);
  });

  it('envelope() helper attaches the canonical disclaimer', () => {
    const e = envelope({ value: 'hello' }, ['s1']);
    expect(e.disclaimer).toBe(DISCLAIMER);
    expect(e.sourcesUsed).toEqual(['s1']);
    expect(e.data.value).toBe('hello');
    // And round-trips through the schema.
    expect(() => AiOutputEnvelope(Payload).parse(e)).not.toThrow();
  });
});
