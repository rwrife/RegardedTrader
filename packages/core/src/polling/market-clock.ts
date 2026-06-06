/**
 * MarketClock — pure, no network.
 *
 * Knows US equity Regular Trading Hours (RTH; 09:30–16:00 ET), pre-market
 * (04:00–09:30 ET), after-hours (16:00–20:00 ET), early closes, and market
 * holidays. The holiday/early-close table is loaded from
 * `core/src/data/market-calendar.json` and refreshed annually.
 */

import calendarData from '../data/market-calendar.json' with { type: 'json' };

export type MarketState = 'rth' | 'pre' | 'post' | 'closed' | 'holiday';

export interface MarketCalendar {
  readonly timezone: string;
  readonly regularHours: { readonly open: string; readonly close: string };
  readonly holidays: ReadonlySet<string>;
  readonly earlyCloses: ReadonlyMap<string, string>;
}

/**
 * Minimal structural contract MarketClock needs from a CalendarStore so the
 * polling package doesn't import `calendar/store` directly (and so tests can
 * inject a fake without spinning up the JSON-backed store).
 */
export interface CalendarStoreLike {
  eventsBetween(
    fromUtc: string,
    toUtc: string,
    query?: {
      symbol?: string | null;
      kinds?: ReadonlyArray<'market_holiday' | 'market_early_close' | string>;
    },
  ): Promise<
    ReadonlyArray<{
      readonly kind: string;
      readonly startUtc: string;
      readonly details?: { readonly closeTimeEt?: string } | undefined;
    }>
  >;
}

export type CalendarUpdateListener = () => void;

export interface MarketClockOptions {
  /** Override the calendar (mostly for tests). */
  readonly calendar?: MarketCalendar;
  /** Override the time source (mostly for tests). */
  readonly now?: () => Date;
  /**
   * Optional CalendarStore-like source. When provided, callers can invoke
   * `refreshFromStore()` to swap the active calendar for one derived from the
   * store; the bundled list remains the last-known-good fallback.
   */
  readonly store?: CalendarStoreLike;
}

interface RawCalendar {
  timezone: string;
  regularHours: { open: string; close: string };
  holidays: string[];
  earlyCloses: Record<string, string>;
}

function loadDefaultCalendar(): MarketCalendar {
  const raw = calendarData as unknown as RawCalendar;
  return {
    timezone: raw.timezone,
    regularHours: raw.regularHours,
    holidays: new Set(raw.holidays),
    earlyCloses: new Map(Object.entries(raw.earlyCloses)),
  };
}

const PRE_OPEN = '04:00';
const POST_CLOSE = '20:00';

interface ETParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  weekday: number; // 0=Sun..6=Sat
}

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function partsInET(d: Date, timezone: string): ETParts {
  // We use America/New_York unconditionally; the timezone field is informational.
  void timezone;
  const parts = ET_FORMATTER.formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const date = `${lookup.year}-${lookup.month}-${lookup.day}`;
  let hour = lookup.hour ?? '00';
  if (hour === '24') hour = '00';
  const time = `${hour}:${lookup.minute}`;
  const weekday = WEEKDAY_INDEX[lookup.weekday ?? 'Sun'] ?? 0;
  return { date, time, weekday };
}

function cmpTime(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class MarketClock {
  /** Last-known-good calendar used when the store is empty/unavailable. */
  private readonly bundled: MarketCalendar;
  private calendar: MarketCalendar;
  private readonly now: () => Date;
  private readonly store?: CalendarStoreLike;
  private readonly listeners = new Set<CalendarUpdateListener>();

  constructor(options: MarketClockOptions = {}) {
    this.bundled = options.calendar ?? loadDefaultCalendar();
    this.calendar = this.bundled;
    this.now = options.now ?? (() => new Date());
    this.store = options.store;
  }

  /** Current market state, derived purely from the wall clock + calendar. */
  state(at: Date = this.now()): MarketState {
    const { date, time, weekday } = partsInET(at, this.calendar.timezone);

    if (weekday === 0 || weekday === 6) return 'closed';
    if (this.calendar.holidays.has(date)) return 'holiday';

    const open = this.calendar.regularHours.open;
    const close = this.calendar.earlyCloses.get(date) ?? this.calendar.regularHours.close;

    if (cmpTime(time, PRE_OPEN) < 0) return 'closed';
    if (cmpTime(time, open) < 0) return 'pre';
    if (cmpTime(time, close) < 0) return 'rth';
    if (cmpTime(time, POST_CLOSE) < 0) return 'post';
    return 'closed';
  }

  /** True when we're inside RTH (excluding early-close cutoff and holidays). */
  isOpen(at: Date = this.now()): boolean {
    return this.state(at) === 'rth';
  }

  /** True if the given calendar date (YYYY-MM-DD ET) is a market holiday. */
  isHoliday(date: string): boolean {
    return this.calendar.holidays.has(date);
  }

  /** Returns the ET close time for a given date (early close if applicable). */
  closeTimeFor(date: string): string {
    return this.calendar.earlyCloses.get(date) ?? this.calendar.regularHours.close;
  }

  /** Read-only view of the active calendar (useful for diagnostics). */
  getCalendar(): MarketCalendar {
    return this.calendar;
  }

  /**
   * Replace the active calendar with one derived from the configured store.
   *
   * Falls back to the bundled (last-known-good) list when:
   *   - no store was configured
   *   - the store returns no events (e.g. first boot before the cron runs)
   *   - the store throws (transient IO error / schema fallback)
   *
   * Notifies `onCalendarUpdate` listeners only when the active calendar
   * actually changes, so the scheduler doesn't reapply cadences on a no-op
   * refresh.
   */
  async refreshFromStore(): Promise<MarketCalendar> {
    if (!this.store) return this.calendar;

    let events: ReadonlyArray<{
      readonly kind: string;
      readonly startUtc: string;
      readonly details?: { readonly closeTimeEt?: string } | undefined;
    }> = [];
    try {
      events = await this.store.eventsBetween(
        '1970-01-01T00:00:00.000Z',
        '9999-12-31T23:59:59.999Z',
        { symbol: null, kinds: ['market_holiday', 'market_early_close'] },
      );
    } catch {
      // Schema/IO failure — keep the active calendar (which may already be the
      // bundled fallback). Never throw out of a clock refresh.
      return this.calendar;
    }

    if (events.length === 0) {
      const next = this.bundled;
      this.swapCalendar(next);
      return next;
    }

    const holidays = new Set<string>();
    const earlyCloses = new Map<string, string>();
    for (const ev of events) {
      const etDate = etDateFromUtc(ev.startUtc);
      if (etDate === null) continue;
      if (ev.kind === 'market_holiday') {
        holidays.add(etDate);
      } else if (ev.kind === 'market_early_close') {
        const time = ev.details?.closeTimeEt;
        if (typeof time === 'string' && /^\d{2}:\d{2}$/.test(time)) {
          earlyCloses.set(etDate, time);
        }
      }
    }

    const next: MarketCalendar = {
      timezone: this.bundled.timezone,
      regularHours: this.bundled.regularHours,
      holidays,
      earlyCloses,
    };
    this.swapCalendar(next);
    return next;
  }

  /**
   * Subscribe to calendar updates. Returns an unsubscribe function. The
   * scheduler uses this hook to reapply cadences when an early-close /
   * holiday boundary moves underneath an in-flight job.
   */
  onCalendarUpdate(listener: CalendarUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private swapCalendar(next: MarketCalendar): void {
    if (calendarsEqual(this.calendar, next)) return;
    this.calendar = next;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // Listener errors are swallowed; the clock is not in the business of
        // policing scheduler/observer bugs.
      }
    }
  }
}

function etDateFromUtc(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = ET_FORMATTER.formatToParts(d);
  let year = '';
  let month = '';
  let day = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function calendarsEqual(a: MarketCalendar, b: MarketCalendar): boolean {
  if (a === b) return true;
  if (a.timezone !== b.timezone) return false;
  if (a.regularHours.open !== b.regularHours.open) return false;
  if (a.regularHours.close !== b.regularHours.close) return false;
  if (a.holidays.size !== b.holidays.size) return false;
  for (const h of a.holidays) if (!b.holidays.has(h)) return false;
  if (a.earlyCloses.size !== b.earlyCloses.size) return false;
  for (const [k, v] of a.earlyCloses) {
    if (b.earlyCloses.get(k) !== v) return false;
  }
  return true;
}
