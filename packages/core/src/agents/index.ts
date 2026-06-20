export { Analyst } from './analyst.js';
export { Technician } from './technician.js';
export type { TechnicianInput } from './technician.js';
export { OptionsStrategist } from './options-strategist.js';
export { RiskOfficer } from './risk-officer.js';
export type { RiskCaps } from './risk-officer.js';
export { OpenAILLM, DISCLAIMER } from './llm.js';
export type { LLM } from './llm.js';
export { CliLLM, buildLLM, activeLLM } from './providers.js';
export { TickerValidator } from './ticker-validator.js';
export type { TickerValidatorDeps } from './ticker-validator.js';

import type {
  BriefingTechnical,
  BriefingNews,
  Indicators,
  NewsItem,
  Quote,
} from '../schemas/index.js';

/**
 * Minimal interface for an optional `Technician` agent slot in the
 * Orchestrator briefing pipeline (issue #126). The full agent will be
 * delivered in issue #74; for now we only require the briefing-shaped output
 * so the registry can stay pluggable.
 */
export interface TechnicianAgent {
  analyze(input: {
    symbol: string;
    quote: Quote;
    indicators: Indicators;
  }): Promise<BriefingTechnical>;
}

/**
 * Minimal interface for an optional `NewsScout` agent slot (issue #126; full
 * agent is #75).
 */
export interface NewsScoutAgent {
  scout(input: { symbol: string; news: NewsItem[] }): Promise<BriefingNews>;
}

