/**
 * CNBC adapter for the quote poller (#22).
 *
 * CNBC exposes an undocumented but widely-used JSON quote endpoint at
 * `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol`
 * (`?symbols=NVDA&requestMethod=quick&output=json`). The payload is shaped:
 *
 *     {
 *       "QuickQuoteResult": {
 *         "QuickQuote": [
 *           {
 *             "symbol": "NVDA",
 *             "last": "1187.50",
 *             "change": "12.34",
 *             "change_pct": "1.05",
 *             "volume": "123456789",
 *             "FundamentalData": { "mktcap": "29191000000000" }
 *           }
 *         ]
 *       }
 *     }
 *
 * The fields are typed `string` upstream — we coerce with `Number(...)` and
 * fall through to `0` so the schema validation in `pollQuote` still passes
 * (the snapshot just reflects whatever the upstream gave us).
 *
 * CNBC's single-symbol endpoint has historically been resilient to the same
 * 429 storms that hit Yahoo, which is why it's wired as the fallback per the
 * issue spec (#22). HTML scraping is explicitly avoided; only the documented
 * JSON endpoint is touched.
 */

import { z } from 'zod';
import type { Quote } from '../../schemas/index.js';
import type { QuoteSource } from './quote.js';

export const DEFAULT_CNBC_QUOTE_URL =
  'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';

const CnbcFundamentalData = z
  .object({
    mktcap: z.union([z.string(), z.number()]).optional(),
  })
  .partial();

const CnbcQuote = z
  .object({
    symbol: z.string().optional(),
    last: z.union([z.string(), z.number()]).optional(),
    change: z.union([z.string(), z.number()]).optional(),
    change_pct: z.union([z.string(), z.number()]).optional(),
    volume: z.union([z.string(), z.number()]).optional(),
    FundamentalData: CnbcFundamentalData.optional(),
  })
  .passthrough();

const CnbcResponse = z.object({
  QuickQuoteResult: z.object({
    QuickQuote: z.union([CnbcQuote, z.array(CnbcQuote)]).optional(),
  }),
});

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function intNonNeg(v: unknown): number {
  const n = Math.floor(num(v));
  return n < 0 ? 0 : n;
}

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = num(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface CnbcQuoteSourceOptions {
  /** Injectable fetch (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Override base URL (tests / proxies). */
  readonly baseUrl?: string;
}

/**
 * Build a CNBC-backed {@link QuoteSource}. Used by {@link pollQuote} as the
 * Yahoo fallback to share rate-limit headroom with the ticker resolver's
 * source registry.
 */
export function createCnbcQuoteSource(
  opts: CnbcQuoteSourceOptions = {},
): QuoteSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_CNBC_QUOTE_URL;

  return {
    name: 'cnbc',
    async quote(symbol: string): Promise<Quote> {
      const sym = symbol.toUpperCase();
      const url = `${baseUrl}?symbols=${encodeURIComponent(sym)}&requestMethod=quick&output=json`;
      const res = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'RegardedTrader/0.1 (+local quote poller)',
        },
      });
      if (!res.ok) {
        throw new Error(`cnbc quote HTTP ${res.status}`);
      }
      const json = (await res.json()) as unknown;
      const parsed = CnbcResponse.safeParse(json);
      if (!parsed.success) {
        throw new Error(`cnbc quote: malformed response`);
      }
      const rawList = parsed.data.QuickQuoteResult.QuickQuote;
      const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
      const row = list[0];
      if (!row) {
        throw new Error(`cnbc quote: no rows for ${sym}`);
      }
      return {
        symbol: sym,
        price: num(row.last),
        change: num(row.change),
        changePercent: num(row.change_pct),
        volume: intNonNeg(row.volume),
        marketCap: optNum(row.FundamentalData?.mktcap),
        asOf: new Date().toISOString(),
      };
    },
  };
}
