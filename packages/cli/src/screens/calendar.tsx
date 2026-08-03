import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { CalendarEvent } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

type ParsedCalArgs =
  | { kind: 'window' }
  | { kind: 'earnings'; symbol: string }
  | { kind: 'refresh' }
  | { kind: 'status' }
  | { kind: 'error'; message: string };

export function parseCalArgs(args: readonly string[]): ParsedCalArgs {
  const [sub, symbol] = args;
  if (!sub) return { kind: 'window' };
  const normalized = sub.toLowerCase();
  if (normalized === 'status') return { kind: 'status' };
  if (normalized === 'refresh') return { kind: 'refresh' };
  if (normalized === 'earnings') {
    const sym = (symbol ?? '').trim().toUpperCase();
    if (!sym) return { kind: 'error', message: 'Usage: regard cal earnings <SYM> [--past] [--upcoming]' };
    return { kind: 'earnings', symbol: sym };
  }
  return { kind: 'error', message: `Unknown subcommand: regard cal ${sub}` };
}

interface CalendarWindowResponse {
  fromEt: string;
  toEtExclusive: string;
  days: number;
  events: CalendarEvent[];
}

interface CalendarStatusResponse {
  stale: boolean;
  holidaysStale: boolean;
  earningsStale: boolean;
  marketState: string;
  sources: Record<
    'nyse' | 'fed' | 'sec' | 'yahoo' | 'nasdaq',
    { lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null }
  >;
}

const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
});

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function etDate(iso: string): string {
  return iso.slice(0, 10);
}

function monthKey(dateEt: string): string {
  return dateEt.slice(0, 7);
}

function addDays(dateEt: string, days: number): string {
  const d = new Date(`${dateEt}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayMarker(events: CalendarEvent[]): string {
  const hasHoliday = events.some((ev) => ev.kind === 'market_holiday' || ev.kind === 'market_early_close');
  const hasEarnings = events.some((ev) => ev.kind === 'earnings');
  if (hasHoliday && hasEarnings) return '*';
  if (hasHoliday) return 'H';
  if (hasEarnings) return 'E';
  return ' ';
}

export function renderAsciiCalendar(
  fromEt: string,
  days: number,
  events: ReadonlyArray<CalendarEvent>,
): string[] {
  const perDate = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = etDate(ev.startUtc);
    const list = perDate.get(key) ?? [];
    list.push(ev);
    perDate.set(key, list);
  }

  const endExclusive = addDays(fromEt, days);
  const monthStarts = new Set<string>();
  for (let d = fromEt; d < endExclusive; d = addDays(d, 1)) {
    monthStarts.add(monthKey(d));
  }

  const out: string[] = [];
  for (const ym of monthStarts) {
    const [yStr, mStr] = ym.split('-');
    const year = Number(yStr);
    const month = Number(mStr);
    const label = `${MONTH_NAMES[month - 1] ?? mStr} ${year}`;
    out.push(label);
    out.push('Su Mo Tu We Th Fr Sa');

    const firstWeekday = new Date(`${ym}-01T00:00:00.000Z`).getUTCDay();
    let row = '   '.repeat(firstWeekday);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateEt = `${ym}-${String(day).padStart(2, '0')}`;
      const inRange = dateEt >= fromEt && dateEt < endExclusive;
      const marker = inRange ? dayMarker(perDate.get(dateEt) ?? []) : ' ';
      const cell = `${String(day).padStart(2, ' ')}${marker}`;
      row += cell;
      if ((firstWeekday + day) % 7 === 0 || day === daysInMonth) {
        out.push(row.trimEnd());
        row = '';
      }
    }
    out.push('');
  }
  return out;
}

export function CalendarScreen({
  args,
  serverUrl,
  from,
  days,
  past,
  upcoming,
  holidays,
  earnings,
  onDone,
}: {
  args: readonly string[];
  serverUrl: string;
  from?: string;
  days?: number;
  past?: boolean;
  upcoming?: boolean;
  holidays?: boolean;
  earnings?: boolean;
  onDone?: () => void;
}) {
  const parsed = useMemo(() => parseCalArgs(args), [args.join('\u0000')]);
  const { exit } = useApp();
  const [err, setErr] = useState<string | null>(parsed.kind === 'error' ? parsed.message : null);
  const [window, setWindow] = useState<CalendarWindowResponse | null>(null);
  const [earningEvents, setEarningEvents] = useState<CalendarEvent[] | null>(null);
  const [status, setStatus] = useState<CalendarStatusResponse | null>(null);
  const [refreshMsg, setRefreshMsg] = useState<string[] | null>(null);
  const [finished, setFinished] = useState(parsed.kind === 'error');

  useEffect(() => {
    if (parsed.kind === 'error') {
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    const done = () => {
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
    };

    if (parsed.kind === 'window') {
      const q = new URLSearchParams({
        from: from ?? 'today',
        days: String(days ?? 14),
      });
      api<CalendarWindowResponse>(serverUrl, `/calendar/events?${q.toString()}`)
        .then(setWindow)
        .catch((e) => setErr(String(e)))
        .finally(done);
      return;
    }

    if (parsed.kind === 'earnings') {
      const includeUpcoming = upcoming || !past;
      const q = new URLSearchParams({
        past: String(!!past),
        upcoming: String(!!includeUpcoming),
      });
      api<{ symbol: string; events: CalendarEvent[] }>(
        serverUrl,
        `/calendar/earnings/${encodeURIComponent(parsed.symbol)}?${q.toString()}`,
      )
        .then((r) => setEarningEvents(r.events))
        .catch((e) => setErr(String(e)))
        .finally(done);
      return;
    }

    if (parsed.kind === 'status') {
      api<CalendarStatusResponse>(serverUrl, '/calendar/status')
        .then(setStatus)
        .catch((e) => setErr(String(e)))
        .finally(done);
      return;
    }

    api<{
      holidays?: { ok: boolean; events: number; staleSources: string[] };
      earnings?: { ok: boolean; events: number; staleSources: string[] };
      skipped?: Array<{ kind: string; retryAfterMs: number }>;
    }>(serverUrl, '/calendar/refresh', {
      method: 'POST',
      body: JSON.stringify({
        holidays: !!holidays,
        earnings: !!earnings,
      }),
    })
      .then((r) => {
        const lines: string[] = [];
        if (r.holidays) {
          lines.push(
            `holidays: ${r.holidays.ok ? 'ok' : 'error'} (${r.holidays.events} upserts)` +
              (r.holidays.staleSources.length ? ` stale=${r.holidays.staleSources.join(',')}` : ''),
          );
        }
        if (r.earnings) {
          lines.push(
            `earnings: ${r.earnings.ok ? 'ok' : 'error'} (${r.earnings.events} upserts)` +
              (r.earnings.staleSources.length ? ` stale=${r.earnings.staleSources.join(',')}` : ''),
          );
        }
        if (r.skipped?.length) {
          for (const s of r.skipped) {
            lines.push(`${s.kind}: rate-limited, retry in ${Math.ceil(s.retryAfterMs / 1000)}s`);
          }
        }
        if (lines.length === 0) lines.push('No refresh executed.');
        setRefreshMsg(lines);
      })
      .catch((e) => setErr(String(e)))
      .finally(done);
  }, [parsed, serverUrl, from, days, past, upcoming, holidays, earnings, exit, onDone]);

  const calendarLines = useMemo(() => {
    if (!window) return [];
    return renderAsciiCalendar(window.fromEt, window.days, window.events);
  }, [window]);

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && finished && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (!finished) {
    return (
      <Text>
        <Spinner type="dots" /> loading calendar…
      </Text>
    );
  }

  if (window) {
    const sortedEvents = [...window.events].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    return (
      <Box flexDirection="column">
        <Text bold>
          calendar ({window.fromEt} → {window.toEtExclusive}, {window.days}d)
        </Text>
        {calendarLines.map((line, idx) => (
          <Text key={`${idx}-${line}`}>{line}</Text>
        ))}
        <Text dimColor>Legend: H=market holiday/early close, E=earnings, *=both</Text>
        <Text bold>Events</Text>
        {sortedEvents.length === 0 ? (
          <Text dimColor>No events in range.</Text>
        ) : (
          sortedEvents.map((ev) => (
            <Text key={ev.id}>
              {etDate(ev.startUtc)} {ET_WEEKDAY.format(new Date(ev.startUtc))} | {ev.kind.padEnd(18)} |{' '}
              {(ev.symbol ?? 'MKT').padEnd(6)} | {ev.title}
            </Text>
          ))
        )}
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (earningEvents) {
    return (
      <Box flexDirection="column">
        <Text bold>earnings events</Text>
        {earningEvents.length === 0 ? (
          <Text dimColor>No matching earnings events.</Text>
        ) : (
          earningEvents.map((ev) => (
            <Text key={ev.id}>
              {etDate(ev.startUtc)} | {(ev.details?.when ?? '—').padEnd(6)} | est{' '}
              {typeof ev.details?.epsEstimate === 'number' ? ev.details.epsEstimate.toFixed(2) : '—'} | act{' '}
              {typeof ev.details?.epsActual === 'number' ? ev.details.epsActual.toFixed(2) : '—'} |{' '}
              {ev.sources.map((s) => s.name).join(',')}
            </Text>
          ))
        )}
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (status) {
    return (
      <Box flexDirection="column">
        <Text bold>calendar status</Text>
        <Text>
          marketState={status.marketState} stale={String(status.stale)} holidaysStale=
          {String(status.holidaysStale)} earningsStale={String(status.earningsStale)}
        </Text>
        {(Object.keys(status.sources) as Array<keyof CalendarStatusResponse['sources']>).map((id) => {
          const src = status.sources[id];
          return (
            <Text key={id}>
              {id.padEnd(6)} ok={src.lastSuccessAt ?? 'never'} err={src.lastErrorAt ?? '—'}{' '}
              {src.lastError ? `(${src.lastError})` : ''}
            </Text>
          );
        })}
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {(refreshMsg ?? ['No refresh output.']).map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
