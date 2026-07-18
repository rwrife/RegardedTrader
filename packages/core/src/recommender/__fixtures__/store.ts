import type { Recommendation } from '../../schemas/recommendation.js';
import type { RecommendationStorePort } from '../orchestrator.js';

export interface TestRecommendationStore {
  readonly store: RecommendationStorePort;
  readonly appends: Recommendation[];
  setLatest(next: Recommendation | null): void;
  latest(): Recommendation | null;
}

/**
 * Typed in-memory store double for recommender tests.
 *
 * Prefer this over `as any` casts when wiring `RecommenderOrchestrator`.
 */
export function createTestRecommendationStore(
  initial: Recommendation | null = null,
): TestRecommendationStore {
  let current = initial;
  const appends: Recommendation[] = [];

  return {
    appends,
    setLatest(next) {
      current = next;
    },
    latest() {
      return current;
    },
    store: {
      async readLatest() {
        return current;
      },
      async append(_symbol, recommendation) {
        appends.push(recommendation);
        current = recommendation;
        return recommendation;
      },
    },
  };
}
