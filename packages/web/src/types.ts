// Shared types for the web dashboard. Extracted from App.tsx in #112 so the
// per-tab components and the ticker-intake surface can import the same
// validated-ticker shapes without dragging in the whole shell.

/** Tab id rendered by the main dashboard. */
export type Tab =
  | 'briefing'
  | 'sentiment'
  | 'news'
  | 'recommendation'
  | 'calendar'
  | 'chart'
  | 'tech';

/** M1 ticker profile shape (mirrors `core/src/schemas/ticker-profile.ts`). */
export interface TickerProfile {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  industry: string;
  description: string;
  sources: string[];
  validatedAt: string;
}

/** A validated ticker plus the time it was added to the local watchlist. */
export interface WatchlistEntry {
  profile: TickerProfile;
  addedAt: string;
}

/**
 * Result of `POST /api/tickers/validate` for one input symbol. Mirrors the
 * server response shape so both the intake form and result rendering share
 * the same discriminated union.
 */
export type ValidationResult =
  | { ok: true; profile: TickerProfile; cached?: boolean }
  | {
      ok: false;
      symbol: string;
      error: string;
      suggestions?: { symbol: string; name?: string; reason?: string }[];
    };
