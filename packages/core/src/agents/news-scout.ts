import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import { AgentParseError } from './errors.js';
import {
  BriefingNews,
  HeadlineBundle,
  NewsScoutOutputSchema,
  type BriefingNews as BriefingNewsT,
  type HeadlineBundle as HeadlineBundleT,
  type NewsItem,
} from '../schemas/index.js';
import { NewsScoutPrompts } from '../prompts/index.js';

export interface NewsScoutInput {
  symbol: string;
  news: NewsItem[];
}

export interface NewsScoutOptions {
  now?: () => Date;
}

export class NewsScout {
  constructor(
    private readonly llm: LLM,
    private readonly opts: NewsScoutOptions = {},
  ) {}

  async bundle(input: NewsScoutInput): Promise<HeadlineBundleT> {
    const symbol = input.symbol.toUpperCase();
    const labeled = labelHeadlines(input.news);
    if (labeled.length === 0) {
      return HeadlineBundle.parse({
        symbol,
        asOf: this.nowIso(),
        headlines: [],
        summary: 'No fresh traditional headlines found for this ticker.',
        sourcesUsed: [],
        disclaimer: DISCLAIMER,
      });
    }

    const raw = await this.llm.complete({
      system: NewsScoutPrompts.SYSTEM_PROMPT,
      user: NewsScoutPrompts.buildUserPrompt({ symbol, headlines: labeled }),
      json: true,
    });
    const scored = parseScoutOutput(raw);
    const byId = new Map(labeled.map((h) => [h.id, h] as const));

    const ranked = scored.headlines
      .map((h) => {
        const base = byId.get(h.id);
        if (!base) return null;
        return {
          ...base,
          relevance: h.relevance,
          materiality: h.materiality,
          rationale: h.rationale,
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    const fallback =
      ranked.length > 0
        ? ranked
        : labeled.slice(0, 5).map((h) => ({
            ...h,
            relevance: 3,
            materiality: 3,
            rationale: 'Fallback score used because model returned no valid ranking.',
          }));

    return HeadlineBundle.parse({
      symbol,
      asOf: this.nowIso(),
      headlines: fallback,
      summary: scored.summary,
      sourcesUsed: fallback.map((h) => h.url),
      disclaimer: DISCLAIMER,
    });
  }

  async scout(input: NewsScoutInput): Promise<BriefingNewsT> {
    const bundle = await this.bundle(input);
    return BriefingNews.parse({
      headlines: bundle.headlines.map((h) => ({
        id: h.id,
        title: h.title,
        url: h.url,
        source: h.source,
        publishedAt: h.publishedAt,
        summary: h.rationale,
      })),
      summary: bundle.summary,
      sourcesUsed: bundle.sourcesUsed,
      disclaimer: DISCLAIMER,
    });
  }

  private nowIso(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
}

function labelHeadlines(news: NewsItem[]): NewsItem[] {
  return news.map((h, i) => ({ ...h, id: h.id && h.id.trim() ? h.id : `h${i + 1}` }));
}

function parseScoutOutput(raw: string) {
  let jsonValue: unknown;
  try {
    jsonValue = JSON.parse(raw);
  } catch (err) {
    throw new AgentParseError('NewsScout', [(err as Error).message ?? 'invalid JSON'], raw);
  }
  const result = NewsScoutOutputSchema.safeParse(jsonValue);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
    );
    throw new AgentParseError('NewsScout', issues, raw);
  }
  return result.data;
}

