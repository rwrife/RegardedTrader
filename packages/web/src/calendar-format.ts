export interface CalendarSourceWire {
  name: string;
  url: string;
}

export interface CalendarEventWire {
  id: string;
  kind: string;
  symbol: string | null;
  startUtc: string;
  endUtc: string;
  allDay: boolean;
  title: string;
  details?: {
    closeTimeEt?: string;
    epsEstimate?: number;
    epsActual?: number;
    when?: 'bmo' | 'amc' | 'during';
  };
  sources: CalendarSourceWire[];
  fetchedAt: string;
}

export interface TimeLabel {
  label: string;
  etLabel: string;
}

export interface EarningsChipView {
  label: string;
  tooltip: string;
}

const LOCAL_WITH_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const ET_WITH_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function asDate(iso: string): Date | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function dayDiff(now: Date, target: Date): number {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - now.getTime()) / dayMs);
}

function whenLabel(when?: 'bmo' | 'amc' | 'during'): string {
  if (when === 'bmo') return 'BMO';
  if (when === 'amc') return 'AMC';
  if (when === 'during') return 'DURING';
  return '';
}

export function formatEventTimeLabel(iso: string): TimeLabel {
  const d = asDate(iso);
  if (!d) return { label: 'Unknown time', etLabel: 'Unknown ET' };
  return {
    label: LOCAL_WITH_TIME.format(d),
    etLabel: `${ET_WITH_TIME.format(d)} ET`,
  };
}

function sourcesTooltip(sources: ReadonlyArray<CalendarSourceWire>): string {
  if (sources.length === 0) return 'Sources: unavailable';
  return `Sources:\n${sources.map((s) => `- ${s.name}: ${s.url}`).join('\n')}`;
}

function scoreLabel(estimate?: number, actual?: number): string {
  if (typeof actual !== 'number') return '';
  if (typeof estimate !== 'number') return `EPS ${actual.toFixed(2)}`;
  const verdict = actual > estimate ? 'beat' : actual < estimate ? 'miss' : 'inline';
  return `EPS ${actual.toFixed(2)} (${verdict})`;
}

export function buildTickerEarningsChip(
  events: ReadonlyArray<CalendarEventWire>,
  now: Date = new Date(),
): EarningsChipView | null {
  const earnings = events
    .filter((ev) => ev.kind === 'earnings')
    .map((ev) => ({ ev, at: asDate(ev.startUtc) }))
    .filter((x): x is { ev: CalendarEventWire; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (earnings.length === 0) return null;

  const upcoming = earnings.find((x) => x.at.getTime() > now.getTime());
  if (upcoming) {
    const inDays = Math.max(0, dayDiff(now, upcoming.at));
    const when = whenLabel(upcoming.ev.details?.when);
    const estimate =
      typeof upcoming.ev.details?.epsEstimate === 'number'
        ? ` · est EPS ${upcoming.ev.details.epsEstimate.toFixed(2)}`
        : '';
    const { label, etLabel } = formatEventTimeLabel(upcoming.ev.startUtc);
    return {
      label: `Earnings in ${inDays}d${when ? ` (${when})` : ''}${estimate}`,
      tooltip: `${label} (local)\n${etLabel}\n${sourcesTooltip(upcoming.ev.sources)}`,
    };
  }

  const last = earnings[earnings.length - 1]!;
  const ago = Math.max(0, -dayDiff(now, last.at));
  const eps = scoreLabel(last.ev.details?.epsEstimate, last.ev.details?.epsActual);
  const { label, etLabel } = formatEventTimeLabel(last.ev.startUtc);
  return {
    label: `Reported ${ago}d ago${eps ? ` · ${eps}` : ''}`,
    tooltip: `${label} (local)\n${etLabel}\n${sourcesTooltip(last.ev.sources)}`,
  };
}
