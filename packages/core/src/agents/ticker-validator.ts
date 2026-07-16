import { z } from 'zod';
import type { LLM } from './llm.js';
import type { WebSearch, WebSearchResult } from '../clients/web-search.js';
import {
  TickerProfile,
  TickerProfileExtraction,
  type TickerSuggestion,
  type ValidationResult,
} from '../schemas/index.js';
import { TickerValidatorPrompts } from '../prompts/index.js';

/** Internal LLM-output schema (Zod-parsed, never `any`). */
const LlmReply = z.discriminatedUnion('match', [
  z.object({ match: z.literal(true), profile: TickerProfileExtraction }),
  z.object({
    match: z.literal(false),
    reason: z.string().min(1),
    suggestions: z
      .array(
        z.object({
          symbol: z.string(),
          name: z.string().optional(),
          reason: z.string().optional(),
        }),
      )
      .default([]),
  }),
]);

export interface TickerValidatorDeps {
  webSearch: WebSearch;
  llm: LLM;
  /** Override clock for tests. */
  now?: () => Date;
}

export class TickerValidator {
  constructor(private readonly deps: TickerValidatorDeps) {}

  async validate(rawSymbol: string): Promise<ValidationResult> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!/^[A-Z.\-]{1,10}$/.test(symbol)) {
      return {
        ok: false,
        symbol,
        error: `"${rawSymbol}" is not a valid ticker shape (1-10 chars, A-Z . - only).`,
        suggestions: [],
      };
    }

    let results: WebSearchResult[] = [];
    try {
      results = await this.deps.webSearch.search(
        `${symbol} stock ticker company NYSE OR NASDAQ exchange sector`,
        { limit: 6 },
      );
    } catch (e) {
      return {
        ok: false,
        symbol,
        error: `Web search failed: ${(e as Error).message}`,
        suggestions: [],
      };
    }

    if (results.length === 0) {
      return {
        ok: false,
        symbol,
        error: `No web search results found for "${symbol}". The symbol may not exist.`,
        suggestions: [],
      };
    }

    const userPrompt = TickerValidatorPrompts.buildUserPrompt({ symbol, results });

    let raw: string;
    try {
      raw = await this.deps.llm.complete({
        system: TickerValidatorPrompts.SYSTEM_PROMPT,
        user: userPrompt,
        json: true,
      });
    } catch (e) {
      return {
        ok: false,
        symbol,
        error: `LLM call failed: ${(e as Error).message}`,
        suggestions: [],
      };
    }

    let parsed: z.infer<typeof LlmReply>;
    try {
      const json: unknown = JSON.parse(raw);
      const r = LlmReply.safeParse(json);
      if (!r.success) {
        return {
          ok: false,
          symbol,
          error: `LLM returned malformed JSON for ${symbol}: ${r.error.issues
            .map((i) => i.message)
            .join('; ')}`,
          suggestions: [],
        };
      }
      parsed = r.data;
    } catch {
      return {
        ok: false,
        symbol,
        error: `LLM returned non-JSON for ${symbol}.`,
        suggestions: [],
      };
    }

    if (!parsed.match) {
      const suggestions: TickerSuggestion[] = parsed.suggestions.map((s) => ({
        symbol: s.symbol.toUpperCase(),
        name: s.name,
        reason: s.reason,
      }));
      return {
        ok: false,
        symbol,
        error: parsed.reason,
        suggestions,
      };
    }

    const ext = parsed.profile;
    const canonical = ext.symbol.toUpperCase();
    if (!/^[A-Z.\-]{1,10}$/.test(canonical)) {
      return {
        ok: false,
        symbol,
        error: `LLM returned canonical symbol "${ext.symbol}" which is not a valid ticker shape.`,
        suggestions: [],
      };
    }
    // Reject canonical mismatches: if the LLM rewrote NVDA -> AAPL, that's
    // not a confirmation of NVDA, that's a different stock.
    if (canonical !== symbol) {
      return {
        ok: false,
        symbol,
        error: `Ambiguous: search results best match "${canonical}", not "${symbol}".`,
        suggestions: [{ symbol: canonical, name: ext.name }],
      };
    }

    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const sources = uniq(results.map((r) => r.url)).slice(0, 6);
    const profile = TickerProfile.parse({
      symbol: canonical,
      name: ext.name,
      exchange: ext.exchange,
      sector: ext.sector,
      industry: ext.industry,
      description: ext.description,
      sources,
      validatedAt: now,
    });

    return { ok: true, profile, cached: false };
  }
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
