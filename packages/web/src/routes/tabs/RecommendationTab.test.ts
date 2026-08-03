import { describe, expect, it } from 'vitest';
import {
  buildRecommendationHistoryUrl,
  buildRecommendationLatestUrl,
  buildRecommendationRecomputeUrl,
} from './RecommendationTab.js';

describe('RecommendationTab urls', () => {
  it('builds recommendation endpoints with normalized symbols', () => {
    expect(buildRecommendationLatestUrl('nvda')).toBe('/api/recommendations/NVDA/latest');
    expect(buildRecommendationHistoryUrl('brk.b', 30)).toBe('/api/recommendations/BRK.B?days=30');
    expect(buildRecommendationRecomputeUrl('msft')).toBe('/api/recommendations/MSFT/recompute');
  });
});
