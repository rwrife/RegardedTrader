import { describe, expect, it } from 'vitest';
import { buildNewsUrl } from './NewsTab.js';

describe('buildNewsUrl', () => {
  it('creates /api/news path with upper-cased ticker', () => {
    expect(buildNewsUrl('nvda')).toBe('/api/news/NVDA');
    expect(buildNewsUrl('brk.b')).toBe('/api/news/BRK.B');
  });
});

