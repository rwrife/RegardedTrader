import { describe, expect, it } from 'vitest';
import { sparkline } from './chart.js';

describe('sparkline', () => {
  it('maps an increasing series to rising bars', () => {
    expect(sparkline([1, 2, 3, 4, 5])).toBe('▁▃▅▆█');
  });

  it('handles flat values', () => {
    expect(sparkline([7, 7, 7])).toBe('▁▁▁');
  });
});

