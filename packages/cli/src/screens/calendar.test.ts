import { describe, expect, it } from 'vitest';
import { parseCalArgs, renderAsciiCalendar } from './calendar.js';

describe('parseCalArgs', () => {
  it('defaults to window mode', () => {
    expect(parseCalArgs([])).toEqual({ kind: 'window' });
  });

  it('parses earnings symbol', () => {
    expect(parseCalArgs(['earnings', 'nvda'])).toEqual({ kind: 'earnings', symbol: 'NVDA' });
  });

  it('errors on unknown subcommand', () => {
    const parsed = parseCalArgs(['wat']);
    expect(parsed.kind).toBe('error');
  });
});

describe('renderAsciiCalendar', () => {
  it('marks holiday and earnings days', () => {
    const lines = renderAsciiCalendar('2026-08-01', 10, [
      {
        id: 'h',
        kind: 'market_holiday',
        symbol: null,
        startUtc: '2026-08-03T00:00:00.000Z',
        endUtc: '2026-08-03T00:00:00.000Z',
        allDay: true,
        title: 'Holiday',
        sources: [{ name: 'NYSE', url: 'https://example.com' }],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'e',
        kind: 'earnings',
        symbol: 'NVDA',
        startUtc: '2026-08-04T00:00:00.000Z',
        endUtc: '2026-08-04T00:00:00.000Z',
        allDay: true,
        title: 'NVDA earnings',
        sources: [{ name: 'Yahoo', url: 'https://example.com' }],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const joined = lines.join('\n');
    expect(joined).toContain(' 3H');
    expect(joined).toContain(' 4E');
  });
});
