import { describe, expect, it } from 'vitest';
import { parsePaperArgs } from './paper.js';

describe('parsePaperArgs', () => {
  it('parses submit with plan id', () => {
    expect(parsePaperArgs(['submit', 'NVDA-abc-1'])).toEqual({
      kind: 'submit',
      planId: 'NVDA-abc-1',
    });
  });

  it('parses orders and positions aliases', () => {
    expect(parsePaperArgs(['orders']).kind).toBe('orders');
    expect(parsePaperArgs(['fills']).kind).toBe('orders');
    expect(parsePaperArgs(['positions']).kind).toBe('positions');
    expect(parsePaperArgs(['pos']).kind).toBe('positions');
  });

  it('errors on missing or unknown subcommands', () => {
    expect(parsePaperArgs([]).kind).toBe('error');
    expect(parsePaperArgs(['submit']).kind).toBe('error');
    expect(parsePaperArgs(['burn']).kind).toBe('error');
  });
});

