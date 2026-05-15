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

export interface MarketClockOptions {
  /** Override the calendar (mostly for tests). */
  readonly calendar?: MarketCalendar;
  /** Override the time source (mostly for tests). */
  readonly now?: () => Date;
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
  private readonly calendar: MarketCalendar;
  private readonly now: () => Date;

  constructor(options: MarketClockOptions = {}) {
    this.calendar = options.calendar ?? loadDefaultCalendar();
    this.now = options.now ?? (() => new Date());
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
}
