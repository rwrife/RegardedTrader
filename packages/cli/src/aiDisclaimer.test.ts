import { describe, it, expect } from 'vitest';
import { aiDisclaimerLine } from './aiDisclaimer.js';
import { DISCLAIMER } from '@regardedtrader/core/constants';

describe('aiDisclaimerLine', () => {
  it('returns the canonical core DISCLAIMER string', () => {
    expect(aiDisclaimerLine()).toBe(DISCLAIMER);
  });

  it('contains the phrase "not financial advice" for audit greps', () => {
    expect(aiDisclaimerLine().toLowerCase()).toContain('not financial advice');
  });

  it('returns a non-empty string', () => {
    expect(aiDisclaimerLine().length).toBeGreaterThan(10);
  });
});
