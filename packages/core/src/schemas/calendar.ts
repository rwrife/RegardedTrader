import { z } from 'zod';
import { Ticker } from './index.js';

/**
 * Kinds of calendar events tracked by the Calendar subsystem (issue #55, #56).
 *
 * - `market_holiday` — US equity market full close (NYSE/NASDAQ).
 * - `market_early_close` — Early close (typically 13:00 ET).
 * - `earnings` — A per-symbol earnings event (past or future).
 * - `earnings_estimate_revision` — A change in the consensus EPS estimate for
 *   an upcoming earnings event. Tracked separately so downstream consumers can
 *   decide whether to surface revisions vs the raw event.
 */
export const EventKind = z.enum([
  'market_holiday',
  'market_early_close',
  'earnings',
  'earnings_estimate_revision',
]);
export type EventKind = z.infer<typeof EventKind>;

/**
 * A single source used to derive a CalendarEvent. Tracked as an array on the
 * event so the highest-trust source can win conflicts while still recording
 * what every source said (NYSE > Fed; SEC 8-K > Yahoo > Nasdaq, per #55).
 */
export const CalendarSource = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});
export type CalendarSource = z.infer<typeof CalendarSource>;

/**
 * Optional structured details. Loose-typed because the shape varies by kind.
 * The schema constrains the union of allowed keys; consumers should not rely
 * on a field being present for the wrong `kind`.
 */
export const CalendarEventDetails = z
  .object({
    /** Early-close time in ET, e.g. "13:00". Only meaningful for `market_early_close`. */
    closeTimeEt: z.string().optional(),
    /** Consensus EPS estimate ahead of an earnings event. */
    epsEstimate: z.number().optional(),
    /** Reported EPS for a past earnings event. */
    epsActual: z.number().optional(),
    /** Timing hint for earnings releases. */
    when: z.enum(['bmo', 'amc', 'during']).optional(),
  })
  .strict();
export type CalendarEventDetails = z.infer<typeof CalendarEventDetails>;

/**
 * Canonical wire-format for a single calendar event. `id` is a stable hash
 * over (kind + symbol + dateUtc + sources) so re-fetching the same source
 * yields the same id and `upsertEvents` becomes idempotent.
 *
 * All times are UTC strings (ISO-8601). Display layers render ET for
 * market-wide events.
 */
export const CalendarEvent = z.object({
  id: z.string().min(1),
  kind: EventKind,
  /** `null` for market-wide events (holidays / early closes). */
  symbol: Ticker.nullable(),
  startUtc: z.string(),
  endUtc: z.string(),
  allDay: z.boolean(),
  title: z.string().min(1),
  details: CalendarEventDetails.optional(),
  sources: z.array(CalendarSource).min(1),
  /** ISO timestamp the event was last fetched/refreshed. */
  fetchedAt: z.string(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

/**
 * State of the US equity market on a given calendar day.
 */
export const MarketDayState = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('open'),
    rthOpenUtc: z.string(),
    rthCloseUtc: z.string(),
  }),
  z.object({
    state: z.literal('early'),
    rthOpenUtc: z.string(),
    rthCloseUtc: z.string(),
  }),
  z.object({
    state: z.literal('closed'),
    reason: z.string().min(1),
  }),
]);
export type MarketDayState = z.infer<typeof MarketDayState>;
