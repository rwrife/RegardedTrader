import { describe, expect, it } from 'vitest';
import {
  buildTickerEarningsChip,
  formatEventTimeLabel,
  type CalendarEventWire,
} from './calendar-format.js';

describe('formatEventTimeLabel', () => {
  it('returns local label and ET tooltip text', () => {
    const out = formatEventTimeLabel('2026-11-27T18:00:00.000Z');
    expect(out.label.length).toBeGreaterThan(0);
    expect(out.etLabel).toMatch(/ET$/);
  });
});

describe('buildTickerEarningsChip', () => {
  it('builds upcoming earnings chip with estimate and BMO timing', () => {
    const events: CalendarEventWire[] = [
      {
        id: 'e1',
        kind: 'earnings',
        symbol: 'NVDA',
        startUtc: '2026-08-09T12:30:00.000Z',
        endUtc: '2026-08-09T12:30:00.000Z',
        allDay: false,
        title: 'NVIDIA earnings',
        details: { when: 'bmo', epsEstimate: 1.42 },
        sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      },
    ];

    const chip = buildTickerEarningsChip(events, new Date('2026-08-03T16:00:00.000Z'));
    expect(chip?.label).toContain('Earnings in 6d (BMO)');
    expect(chip?.label).toContain('est EPS 1.42');
    expect(chip?.tooltip).toContain('Yahoo');
  });

  it('builds reported chip and marks beat after event passes', () => {
    const events: CalendarEventWire[] = [
      {
        id: 'e1',
        kind: 'earnings',
        symbol: 'NVDA',
        startUtc: '2026-08-01T12:30:00.000Z',
        endUtc: '2026-08-01T12:30:00.000Z',
        allDay: false,
        title: 'NVIDIA earnings',
        details: { epsEstimate: 1.42, epsActual: 1.51 },
        sources: [{ name: 'SEC', url: 'https://www.sec.gov/' }],
        fetchedAt: '2026-08-02T00:00:00.000Z',
      },
    ];
    const chip = buildTickerEarningsChip(events, new Date('2026-08-03T16:00:00.000Z'));
    expect(chip?.label).toContain('Reported 2d ago');
    expect(chip?.label).toContain('EPS 1.51 (beat)');
  });
});
