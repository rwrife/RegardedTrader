export {
  RecommendationStore,
  RecommendationRetentionPolicy,
  DEFAULT_RECOMMENDATION_RETENTION,
  type RecommendationStoreOptions,
} from './store.js';
export {
  applyRules,
  HardGates,
  HARD_GATES_VERSION,
  hardGatesRule,
  type HardGatesOptions,
  type RecommendationContext,
  type Rule,
} from './rules/index.js';
export { HARD_GATE_FLAGS } from './rules/hard-gates.js';
export {
  buildRecommendationContext,
  DEFAULT_CADENCES_MS,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  DEFAULT_NEWS_LIMIT,
  DEFAULT_OPINIONS_LIMIT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_SENTIMENT_SPARK_HOURS,
  DEFAULT_NEWS_LOOKBACK_HOURS,
  DEFAULT_OPINIONS_LOOKBACK_HOURS,
  type BuildContextOptions,
  type CadenceKey,
  type ContextLatestSnapshot,
  type SnapshotReader,
  type MentionReader,
} from './context.js';
export type {
  ContextBudgetReport,
  ContextHeadline,
  ContextHistoryBar,
  ContextHistorySection,
  ContextIndicatorsSection,
  ContextNewsSection,
  ContextOpinionItem,
  ContextOpinionsSection,
  ContextOptionsExpiryDigest,
  ContextOptionsSection,
  ContextQuoteSection,
  ContextSectionMeta,
  ContextSentimentSection,
  ContextSentimentSparkPoint,
} from './rules/index.js';
