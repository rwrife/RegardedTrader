import { z } from 'zod';
import { DISCLAIMER } from '../constants.js';

export const NewsScore = z.number().int().min(1).max(5);

export const NewsScoutHeadlineScore = z.object({
  id: z.string().min(1),
  relevance: NewsScore,
  materiality: NewsScore,
  rationale: z.string().min(1),
});
export type NewsScoutHeadlineScore = z.infer<typeof NewsScoutHeadlineScore>;

/**
 * Raw JSON wire shape the NewsScout LLM must return (issue #75).
 */
export const NewsScoutOutputSchema = z.object({
  summary: z.string().min(1),
  headlines: z.array(NewsScoutHeadlineScore).default([]),
});
export type NewsScoutOutput = z.infer<typeof NewsScoutOutputSchema>;

export const ScoredHeadline = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  source: z.string().min(1),
  publishedAt: z.string(),
  summary: z.string().optional(),
  relevance: NewsScore,
  materiality: NewsScore,
  rationale: z.string().min(1),
});
export type ScoredHeadline = z.infer<typeof ScoredHeadline>;

/**
 * Server/CLI/web shared payload for `GET /news/:symbol` (issue #75).
 */
export const HeadlineBundle = z.object({
  symbol: z.string().min(1),
  asOf: z.string(),
  headlines: z.array(ScoredHeadline),
  summary: z.string().min(1),
  sourcesUsed: z.array(z.string()).default([]),
  disclaimer: z.string().min(1).default(DISCLAIMER),
});
export type HeadlineBundle = z.infer<typeof HeadlineBundle>;

