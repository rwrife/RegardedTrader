import type { PartialTickerProfile } from '../schemas/ticker.js';

/**
 * A pluggable source of ticker information. Implementations live in their own
 * modules (Yahoo Finance, Nasdaq Trader, SEC EDGAR, ...). The resolver runs
 * sources in parallel and reconciles their partials.
 */
export interface TickerSource {
  /** Human-readable, stable name for the source (e.g. `'yahoo'`). */
  readonly name: string;
  /**
   * Baseline confidence weight in [0, 1]. The reconciler uses this to break
   * ties between disagreeing sources and to compute an overall confidence.
   */
  readonly weight: number;
  /**
   * Free-text search (company name, partial symbol, etc.). Returns zero or
   * more candidate partial profiles. May throw on transport errors.
   */
  search(query: string): Promise<PartialTickerProfile[]>;
  /**
   * Look up a specific canonical symbol. Returns `null` if the source does
   * not know the symbol. May throw on transport errors.
   */
  fetch(symbol: string): Promise<PartialTickerProfile | null>;
}
