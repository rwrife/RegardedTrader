/**
 * Calendar scheduler jobs (issue #60).
 *
 * Two jobs hand the orchestrator (`orchestrator.ts`) off to the polling
 * scheduler from #20:
 *
 *  - {@link createCalendarHolidaysJob} — `id: 'calendar.holidays'`, runs
 *    daily at 03:15 ET by default. When disabled, falls back to a weekly
 *    cadence so the calendar never goes fully stale silently.
 *  - {@link createCalendarEarningsJob} — `id: 'calendar.earnings'`, runs
 *    every 6 hours by default. Reads the current watchlist via the
 *    injected `getWatchlist` callback on each run.
 *
 * Both jobs are `singleFlight: true` (the default) and rely on the
 * scheduler's built-in ±10% jitter (see `scheduler.ts`). Errors are
 * swallowed inside each `run()` after being reported through `onError`
 * because the scheduler — per the AGENTS rule "never crashes the
 * scheduler" — should treat calendar refreshes as best-effort. The
 * orchestrator already records `stale` state internally; surface it via
 * `/health` separately.
 *
 * For the immediate-refresh-on-watchlist-add path called out by #16, the
 * orchestrator is exposed directly (just call
 * `orchestrator.refreshEarnings(newSymbols)`) — this file does not couple
 * to a watchlist subsystem that doesn't exist yet.
 */

import type { Job } from '../polling/scheduler.js';
import type { CalendarOrchestrator } from './orchestrator.js';

export const CALENDAR_HOLIDAYS_JOB_ID = 'calendar.holidays';
export const CALENDAR_EARNINGS_JOB_ID = 'calendar.earnings';

/** Default earnings refresh cadence: every 6 hours. */
export const DEFAULT_EARNINGS_CADENCE_MS = 6 * 60 * 60 * 1000;

/** Default holidays-disabled fallback cadence: weekly. */
export const DEFAULT_HOLIDAYS_WEEKLY_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Spec default: 03:15 ET. */
export const DEFAULT_HOLIDAYS_DAILY_ET = { hour: 3, minute: 15 } as const;

/** Minimum cadence the scheduler is willing to see (matches `MIN_INTERVAL_MS`). */
const MIN_CADENCE_MS = 1;

export interface CalendarHolidaysJobOptions {
  readonly orchestrator: CalendarOrchestrator;
  /**
   * Configurable daily-time target in US Eastern Time (handles DST). The
   * job's cadence returns ms-until-next instance of this time. Default:
   * 03:15 ET.
   */
  readonly dailyAtET?: { readonly hour: number; readonly minute: number };
  /**
   * Disable the daily cadence and fall back to {@link weeklyFallbackMs}.
   * When enabled, this is a hard guard against the daily slot being
   * misconfigured; the scheduler will still pick up the holiday calendar
   * eventually.
   */
  readonly disabled?: boolean;
  /** Cadence used when `disabled=true`. Default: 7 days. */
  readonly weeklyFallbackMs?: number;
  /** Clock override (tests). */
  readonly now?: () => Date;
  /** Error hook for the run; never thrown. */
  readonly onError?: (err: unknown) => void;
}

export interface CalendarEarningsJobOptions {
  readonly orchestrator: CalendarOrchestrator;
  /** Returns the current watchlist symbols. Called on every run. */
  readonly getWatchlist: () => ReadonlyArray<string>;
  /** Cadence override (ms). Default: 6h. */
  readonly cadenceMs?: number;
  /** Error hook for the run; never thrown. */
  readonly onError?: (err: unknown) => void;
}

/**
 * Build the `calendar.holidays` scheduler job.
 *
 * The cadence is **not** a function of `MarketState`: holidays don't care
 * whether the market is open right now, they care about wall-clock time in
 * Eastern. The job ignores the `MarketState` arg and computes
 * ms-until-next 03:15 ET (or the configured time).
 */
export function createCalendarHolidaysJob(opts: CalendarHolidaysJobOptions): Job {
  const target = opts.dailyAtET ?? DEFAULT_HOLIDAYS_DAILY_ET;
  validateTimeOfDay(target);
  const weeklyFallbackMs = Math.max(
    MIN_CADENCE_MS,
    opts.weeklyFallbackMs ?? DEFAULT_HOLIDAYS_WEEKLY_FALLBACK_MS,
  );
  const now = opts.now ?? (() => new Date());

  return {
    id: CALENDAR_HOLIDAYS_JOB_ID,
    singleFlight: true,
    cadence: () => {
      if (opts.disabled) return weeklyFallbackMs;
      return msUntilNextEt(now(), target);
    },
    async run() {
      try {
        await opts.orchestrator.refreshHolidays();
      } catch (e) {
        // refreshHolidays() is documented as never-throw, but defend
        // against future regressions — the scheduler must never see
        // an exception from this job (AGENTS: "never crashes the
        // scheduler").
        opts.onError?.(e);
      }
    },
  };
}

/**
 * Build the `calendar.earnings` scheduler job. The cadence is constant
 * (default 6h) and the run pulls the watchlist on demand via
 * {@link CalendarEarningsJobOptions.getWatchlist}.
 *
 * Immediate-refresh-on-watchlist-add (#16) is NOT wired here: callers with
 * access to the orchestrator can simply
 * `await orchestrator.refreshEarnings(newSymbols)` inline from the hook.
 */
export function createCalendarEarningsJob(opts: CalendarEarningsJobOptions): Job {
  const cadenceMs = Math.max(MIN_CADENCE_MS, opts.cadenceMs ?? DEFAULT_EARNINGS_CADENCE_MS);
  return {
    id: CALENDAR_EARNINGS_JOB_ID,
    singleFlight: true,
    cadence: () => cadenceMs,
    async run() {
      try {
        const symbols = opts.getWatchlist();
        await opts.orchestrator.refreshEarnings(symbols);
      } catch (e) {
        opts.onError?.(e);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* ET time-of-day cadence                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compute ms until the next instance of `target` (hour:minute) in
 * `America/New_York`, given `now`. Handles DST transparently by reading
 * `now`'s ET wall-clock components via `Intl.DateTimeFormat`.
 *
 * Algorithm:
 *   1. Format `now` in `America/New_York` → ET y/m/d/h/m/s/ms.
 *   2. Compute "ms elapsed today in ET" from ET h/m/s/ms.
 *   3. Compute "ms target into the day" from `target` h/m.
 *   4. If target > elapsed: return `target - elapsed`.
 *      Else: return `(24h - elapsed) + target`.
 *
 * This avoids constructing an actual `Date` in ET (which would need a
 * timezone-aware library), and the answer is correct across DST in
 * practice: on the "spring forward" day there is no 02:30 ET, but 03:15 ET
 * always exists; on "fall back" 01:30 ET happens twice but we don't care
 * which side we land on, only that the next 03:15 ET is reached within a
 * single tick. The scheduler's jitter (±10%) absorbs the residual.
 *
 * Returns a value clamped to >= {@link MIN_CADENCE_MS}.
 *
 * Exported for tests.
 */
export function msUntilNextEt(
  now: Date,
  target: { hour: number; minute: number },
): number {
  validateTimeOfDay(target);
  const et = etComponents(now);
  const dayMs = 24 * 60 * 60 * 1000;

  const elapsedMs =
    et.hour * 60 * 60 * 1000 + et.minute * 60 * 1000 + et.second * 1000 + et.ms;
  const targetMs = target.hour * 60 * 60 * 1000 + target.minute * 60 * 1000;

  let delta: number;
  if (targetMs > elapsedMs) {
    delta = targetMs - elapsedMs;
  } else {
    delta = dayMs - elapsedMs + targetMs;
  }
  return Math.max(MIN_CADENCE_MS, delta);
}

interface EtComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly ms: number;
}

/**
 * Read the components of `date` in `America/New_York`. Sub-second precision
 * comes from the input `date` directly because `Intl.DateTimeFormat` doesn't
 * surface milliseconds.
 */
function etComponents(date: Date): EtComponents {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) return 0;
    const n = Number(part.value);
    return Number.isFinite(n) ? n : 0;
  };
  // `hour12: false` can yield "24" for midnight on some runtimes — normalize.
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
    ms: date.getUTCMilliseconds(),
  };
}

function validateTimeOfDay(t: { hour: number; minute: number }): void {
  if (!Number.isInteger(t.hour) || t.hour < 0 || t.hour > 23) {
    throw new RangeError(`Invalid hour for daily cadence: ${t.hour}`);
  }
  if (!Number.isInteger(t.minute) || t.minute < 0 || t.minute > 59) {
    throw new RangeError(`Invalid minute for daily cadence: ${t.minute}`);
  }
}
