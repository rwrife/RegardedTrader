import { describe, expect, it } from 'vitest';
import { buildNewsPath } from './news.js';

describe('buildNewsPath', () => {
  it('upper-cases and URL-encodes symbols', () => {
    expect(buildNewsPath('nvda')).toBe('/news/NVDA');
    expect(buildNewsPath('brk.b')).toBe('/news/BRK.B');
  });
});

