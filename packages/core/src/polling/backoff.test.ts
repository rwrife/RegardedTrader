import { describe, it, expect } from 'vitest';
import { BackoffPolicy, parseRetryAfter } from './backoff.js';

describe('parseRetryAfter', () => {
  it('returns null for missing values', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
  });

  it('treats numbers and numeric strings as seconds', () => {
    expect(parseRetryAfter(2)).toBe(2_000);
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter('1.5')).toBe(1_500);
  });

  it('parses HTTP-date deltas relative to now', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const future = new Date('2026-05-15T12:00:30Z').toUTCString();
    expect(parseRetryAfter(future, now)).toBe(30_000);
  });

  it('clamps negative deltas to 0', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const past = new Date('2026-05-15T11:59:00Z').toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('returns null for unparseable strings', () => {
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('BackoffPolicy', () => {
  it('grows exponentially up to the cap', () => {
    const policy = new BackoffPolicy({
      baseMs: 100,
      maxMs: 800,
      factor: 2,
      jitterRatio: 0,
    });
    expect(policy.nextDelay()).toBe(100);
    expect(policy.nextDelay()).toBe(200);
    expect(policy.nextDelay()).toBe(400);
    expect(policy.nextDelay()).toBe(800);
    expect(policy.nextDelay()).toBe(800); // capped
    expect(policy.attempts).toBe(5);
  });

  it('applies symmetric jitter inside ±jitterRatio', () => {
    const samples = [0.0, 0.5, 1.0];
    let i = 0;
    const random = () => samples[i++ % samples.length] ?? 0.5;
    const policy = new BackoffPolicy({
      baseMs: 1_000,
      maxMs: 10_000,
      factor: 1,
      jitterRatio: 0.5,
      random,
    });
    // factor=1 keeps the base flat, isolating the jitter math.
    expect(policy.nextDelay()).toBe(500); // (1 + (0*2-1)*0.5) = 0.5
    expect(policy.nextDelay()).toBe(1_000); // (1 + 0) = 1
    expect(policy.nextDelay()).toBe(1_500); // (1 + 0.5) = 1.5
  });

  it('honours Retry-After hints when provided', () => {
    const policy = new BackoffPolicy({ baseMs: 100, maxMs: 60_000, jitterRatio: 0 });
    expect(policy.nextDelay({ retryAfter: 3 })).toBe(3_000);
  });

  it('clamps Retry-After to maxMs', () => {
    const policy = new BackoffPolicy({ baseMs: 100, maxMs: 5_000, jitterRatio: 0 });
    expect(policy.nextDelay({ retryAfter: 600 })).toBe(5_000);
  });

  it('reset() clears the attempt counter', () => {
    const policy = new BackoffPolicy({ baseMs: 100, jitterRatio: 0 });
    policy.nextDelay();
    policy.nextDelay();
    expect(policy.attempts).toBe(2);
    policy.reset();
    expect(policy.attempts).toBe(0);
    expect(policy.nextDelay()).toBe(100);
  });
});
