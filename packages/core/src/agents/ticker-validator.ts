import { z } from 'zod';
import type { LLM } from './llm.js';
import type { WebSearch, WebSearchResult } from '../clients/web-search.js';
import {
  TickerProfile,
  TickerProfileExtraction,
  type TickerSuggestion,
  type ValidationResult,
} from '../schemas/index.js';

const SYSTEM = `You are a US-equities reference librarian. Given a candidate
ticker symbol and a few web search snippets, you decide whether the symbol
unambiguously refers to ONE publicly traded US equity (NYSE, NASDAQ, NYSE
American, OTC). If yes, you extract a structured profile. If not, you say so
and propose alternatives. You never invent facts that are not visible in the
provided snippets. You only output JSON.`;

const VALID_INSTRUCTION = `Reply with strict JSON in ONE of these two shapes.

Shape A — confident match:
{
  "match": true,
  "profile": {
    "symbol": "<canonical uppercase ticker, 1-10 chars, A-Z . - only>",
    "name": "<official company name>",
    "exchange": "<NYSE | NASDAQ | NYSE American | OTC | ...>",
    "sector": "<GICS-style sector, e.g. Technology>",
    "industry": "<GICS-style industry, e.g. Semiconductors>",
    "description": "<1-2 sentence plain-English company description>"
  }
}

Shape B — ambiguous, wrong, or insufficient info:
{
  "match": false,
  "reason": "<one short sentence explaining why>",
  "suggestions": [
    { "symbol": "<TICKER>", "name": "<company>", "reason": "<why it might be what the user meant>" }
  ]
}

Rules:
- Only output JSON. No prose, no markdown.
- "symbol" must be uppercase, 1-10 chars, only letters / dot / hyphen.
- If the snippets are about a private company, an ETF, a crypto coin, a person,
  or a non-US listing, return Shape B.
- If two different US equities plausibly match the input, return Shape B with
  both as suggestions.
- "description" must be derived from the snippets, not memorized.`;

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

    const userPrompt = [
      `Candidate ticker: ${symbol}`,
      '',
      'Web search snippets:',
      ...results.map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n    ${r.snippet}\n    URL: ${r.url}`,
      ),
      '',
      VALID_INSTRUCTION,
    ].join('\n');

    let raw: string;
    try {
      raw = await this.deps.llm.complete({ system: SYSTEM, user: userPrompt, json: true });
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
