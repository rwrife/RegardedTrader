import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Plan, buildPlanRequest } from './plan.js';
import type { PlansResponse } from '@regardedtrader/core';

describe('buildPlanRequest (web)', () => {
  it('uppercases the symbol and POSTs JSON to /api/plans', () => {
    const r = buildPlanRequest({ symbol: 'nvda', thesis: 'bull', maxLossUsd: 500 });
    expect(r.url).toBe('/api/plans');
    expect(r.init.method).toBe('POST');
    const headers = r.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(r.init.body))).toEqual({
      symbol: 'NVDA',
      thesis: 'bull',
      maxLossUsd: 500,
    });
  });

  it('includes expiry when provided (trimmed)', () => {
    const r = buildPlanRequest({
      symbol: 'AAPL',
      thesis: 't',
      maxLossUsd: 250,
      expiry: '  2026-07-17  ',
    });
    expect(JSON.parse(String(r.init.body))).toEqual({
      symbol: 'AAPL',
      thesis: 't',
      maxLossUsd: 250,
      expiry: '2026-07-17',
    });
  });

  it('omits empty expiry', () => {
    const r = buildPlanRequest({ symbol: 'AAPL', thesis: 't', maxLossUsd: 250, expiry: '' });
    const body = JSON.parse(String(r.init.body));
    expect(body.expiry).toBeUndefined();
  });

  it('honors apiBase override', () => {
    const r = buildPlanRequest({
      symbol: 'msft',
      thesis: 't',
      maxLossUsd: 100,
      apiBase: 'http://127.0.0.1:4317',
    });
    expect(r.url).toBe('http://127.0.0.1:4317/plans');
  });
});

const samplePlans: PlansResponse = {
  plans: [
    {
      plan: {
        name: 'Bull Call Spread',
        thesis: 'bull',
        legs: [
          {
            action: 'buy',
            qty: 1,
            contract: {
              symbol: 'NVDA',
              underlying: 'NVDA',
              expiry: '2026-07-17',
              strike: 150,
              type: 'call',
              bid: 5,
              ask: 5.2,
              last: 5.1,
              volume: 100,
              openInterest: 200,
              iv: 0.4,
            },
          },
          {
            action: 'sell',
            qty: 1,
            contract: {
              symbol: 'NVDA',
              underlying: 'NVDA',
              expiry: '2026-07-17',
              strike: 160,
              type: 'call',
              bid: 2,
              ask: 2.2,
              last: 2.1,
              volume: 80,
              openInterest: 150,
              iv: 0.38,
            },
          },
        ],
        maxLoss: 300,
        maxGain: 700,
        breakEvens: [153],
        riskGraph: {
          underlying: [140, 150, 153, 160, 170],
          pnl: [-300, -300, 0, 700, 700],
          breakevens: [153],
          maxLoss: -300,
          maxGain: 700,
          netDebit: 300,
        },
      },
      review: { ok: true, violations: [] },
    },
    {
      plan: {
        name: 'Naked Call',
        thesis: 'bull',
        legs: [
          {
            action: 'sell',
            qty: 1,
            contract: {
              symbol: 'NVDA',
              underlying: 'NVDA',
              expiry: '2026-07-17',
              strike: 200,
              type: 'call',
              bid: 1,
              ask: 1.1,
              last: 1.05,
              volume: 50,
              openInterest: 70,
              iv: 0.42,
            },
          },
        ],
        maxLoss: 99999,
        maxGain: 105,
        breakEvens: [201.05],
        riskGraph: {
          underlying: [180, 200, 220],
          pnl: [105, 105, -1895],
          breakevens: [201.05],
          maxLoss: null,
          maxGain: 105,
          netDebit: -105,
        },
      },
      review: {
        ok: false,
        violations: ['max loss exceeds configured cap'],
      },
    },
  ],
};

describe('<Plan />', () => {
  afterEach(() => cleanup());

  it('shows the idle hint before any submission', () => {
    render(<Plan symbol="nvda" fetchImpl={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /NVDA — trade plan/i })).toBeTruthy();
    expect(screen.getByText(/Enter a thesis/i)).toBeTruthy();
    expect(screen.getByText(/Not financial advice/i)).toBeTruthy();
  });

  it('shows a loading state, then renders plan cards + violations', async () => {
    let resolveFetch: (v: Response) => void = () => undefined;
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise<Response>((res) => { resolveFetch = res; }),
    ) as unknown as typeof fetch;

    render(<Plan symbol="NVDA" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Trade thesis'), 'bull into earnings');
    await user.click(screen.getByRole('button', { name: /Build plans/i }));

    expect(screen.getByText(/Generating candidate plans/i)).toBeTruthy();

    resolveFetch(
      new Response(JSON.stringify(samplePlans), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('plan-card').length).toBe(2);
    });
    expect(screen.getByText(/Bull Call Spread/)).toBeTruthy();
    expect(screen.getByText(/Naked Call/)).toBeTruthy();
    // Violation chip rendered for the failing plan
    const violations = screen.getByTestId('risk-violations');
    expect(violations.textContent).toMatch(/exceeds configured cap/);
    // Risk graph SVG rendered for plans with riskGraph series
    expect(screen.getAllByTestId('risk-graph').length).toBe(2);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      symbol: 'NVDA',
      thesis: 'bull into earnings',
      maxLossUsd: 500,
    });
  });

  it('renders an empty-state message when the server returns no plans', async () => {
    const empty: PlansResponse = { plans: [] };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(empty), { status: 200 }),
    ) as unknown as typeof fetch;
    render(<Plan symbol="NVDA" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Trade thesis'), 'bull');
    await user.click(screen.getByRole('button', { name: /Build plans/i }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/No candidate plans/i);
    });
  });

  it('surfaces HTTP errors from the server', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'unknown symbol' }), { status: 400 }),
    ) as unknown as typeof fetch;
    render(<Plan symbol="ZZZ" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Trade thesis'), 'bull');
    await user.click(screen.getByRole('button', { name: /Build plans/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/unknown symbol/);
    });
  });

  it('renders the noCompliantPlans banner when set', async () => {
    const data: PlansResponse = { ...samplePlans, noCompliantPlans: true };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    ) as unknown as typeof fetch;
    render(<Plan symbol="NVDA" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Trade thesis'), 'bull');
    await user.click(screen.getByRole('button', { name: /Build plans/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(
        /No candidate plans passed/i,
      );
    });
  });

  it('refuses to submit without a thesis', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(<Plan symbol="NVDA" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Build plans/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Thesis is required/i);
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
