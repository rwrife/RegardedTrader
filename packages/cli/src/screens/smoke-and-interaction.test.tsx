import React from 'react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import {
  type AppConfig,
  type Briefing,
  type BriefingTechnical,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type PlansResponse,
  type Quote,
  type ValidationResult,
  type WatchlistEntry,
} from '@regardedtrader/core';
import { spawn } from 'node:child_process';

import { api } from '../api.js';
import { AddScreen } from './add.js';
import { BriefingScreen } from './briefing.js';
import { ConfigScreen } from './config.js';
import { DashboardScreen } from './dashboard.js';
import { MainMenu } from './menu.js';
import { PlanScreen } from './plan.js';
import { QuoteScreen } from './quote.js';
import { TechScreen } from './tech.js';
import { NewsScreen } from './news.js';
import { ListScreen } from './watchlist.js';

vi.mock('../api.js', () => ({
  api: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: () => undefined })),
}));

vi.mock('@regardedtrader/core', async () => {
  const actual = await vi.importActual<typeof import('@regardedtrader/core')>('@regardedtrader/core');
  return {
    ...actual,
    loadConfig: vi.fn(async () => ({ ...actual.DEFAULT_CONFIG })),
    saveConfig: vi.fn(async () => '/tmp/regardedtrader-config.json'),
    configPath: vi.fn(() => '/tmp/regardedtrader-config.json'),
  };
});

const apiMock = vi.mocked(api);
const loadConfigMock = vi.mocked(loadConfig);
const saveConfigMock = vi.mocked(saveConfig);
const spawnMock = vi.mocked(spawn);

const SERVER_URL = 'http://127.0.0.1:4317';

const profile = {
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  exchange: 'NASDAQ',
  sector: 'Technology',
  industry: 'Semiconductors',
  description: 'Designs GPUs and accelerated computing platforms.',
  sources: ['https://example.com/nvda'],
  validatedAt: '2026-08-01T00:00:00.000Z',
};

const quoteFixture: Quote = {
  symbol: 'NVDA',
  price: 123.45,
  change: 1.23,
  changePercent: 1,
  volume: 1_000_000,
  asOf: '2026-08-01T00:00:00.000Z',
};

const briefingFixture: Briefing = {
  symbol: 'NVDA',
  asOf: '2026-08-01T00:00:00.000Z',
  quote: quoteFixture,
  indicators: {
    rsi14: 58,
    sma20: 120,
    sma50: 118,
    ema12: 121,
    ema26: 119,
    macd: 1.1,
    macdSignal: 0.9,
    atr14: 4.2,
    bbMiddle: null,
    bbUpper: null,
    bbLower: null,
    stochK: null,
    stochD: null,
  },
  bullCase: 'Momentum remains strong with healthy breadth.',
  bearCase: 'Valuation is elevated ahead of macro catalysts.',
  catalysts: ['Earnings', 'Product launch'],
  risks: ['Macro slowdown'],
  news: [],
  disclaimer: 'Not financial advice.',
  sourcesUsed: ['quotes', 'indicators'],
};

const techFixture: BriefingTechnical = {
  trend: 'Uptrend',
  momentum: 'Positive',
  volatility: 'Moderate',
  keyLevels: [120, 125],
  commentary: 'Momentum is constructive above the 20-day average.',
  sourcesUsed: ['ohlcv'],
  disclaimer: 'Not financial advice.',
};

const newsFixture = {
  symbol: 'NVDA',
  asOf: '2026-08-01T00:00:00.000Z',
  summary: 'Coverage skews bullish into earnings.',
  headlines: [
    {
      id: 'h1',
      title: 'NVIDIA raises guidance',
      url: 'https://example.com/nvda-news',
      source: 'Reuters',
      publishedAt: '2026-08-01T00:00:00.000Z',
      relevance: 5,
      materiality: 5,
      rationale: 'Direct outlook update.',
    },
  ],
  sourcesUsed: ['https://example.com/nvda-news'],
  disclaimer: 'Not financial advice.',
};

const plansFixture: PlansResponse = {
  plans: [
    {
      plan: {
        name: 'Long call',
        thesis: 'Bullish continuation',
        legs: [
          {
            action: 'buy',
            qty: 1,
            contract: {
              symbol: 'NVDA260918C00125000',
              underlying: 'NVDA',
              expiry: '2026-09-18',
              strike: 125,
              type: 'call',
              bid: 5,
              ask: 5.4,
              last: 5.2,
              volume: 100,
              openInterest: 500,
              iv: 0.42,
              delta: 0.52,
              gamma: 0.03,
              theta: -0.08,
              vega: 0.11,
            },
          },
        ],
        maxLoss: 540,
        maxGain: null,
        breakEvens: [130.4],
        notes: 'Defined risk debit trade.',
      },
      review: {
        ok: true,
        violations: [],
      },
    },
  ],
};

const watchlistEntries: WatchlistEntry[] = [{ profile, addedAt: '2026-08-01T00:00:00.000Z' }];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function typeText(
  stdin: { write: (input: string) => void },
  text: string,
): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

describe('CLI screens smoke + interactions (#157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const cfg: AppConfig = { ...DEFAULT_CONFIG };
    loadConfigMock.mockResolvedValue(cfg);
    saveConfigMock.mockResolvedValue('/tmp/regardedtrader-config.json');

    apiMock.mockImplementation(async (_serverUrl, path) => {
      if (path === '/tickers/validate') {
        const result: ValidationResult = { ok: true, profile, cached: false };
        return { results: [result] };
      }
      if (typeof path === 'string' && path.startsWith('/briefing/')) {
        return briefingFixture;
      }
      if (path === '/plans') {
        return plansFixture;
      }
      if (typeof path === 'string' && path.startsWith('/quote/')) {
        return quoteFixture;
      }
      if (typeof path === 'string' && path.startsWith('/technician/')) {
        return techFixture;
      }
      if (typeof path === 'string' && path.startsWith('/news/')) {
        return newsFixture;
      }
      if (path === '/tickers') {
        return { entries: watchlistEntries };
      }
      throw new Error(`Unexpected API path in test: ${String(path)}`);
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('smoke: add screen renders validated ticker output', async () => {
    const app = render(
      <AddScreen symbols={['NVDA']} refresh={false} serverUrl={SERVER_URL} onDone={() => {}} />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('NVDA');
      expect(app.lastFrame()).toContain('NVIDIA Corporation');
    });

    app.unmount();
  });

  it('smoke: briefing screen renders summary sections', async () => {
    const app = render(<BriefingScreen symbol="nvda" serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('NVDA briefing');
      expect(app.lastFrame()).toContain('Bull case');
      expect(app.lastFrame()).toContain('Bear case');
    });

    app.unmount();
  });

  it('interaction: config screen add-provider flow persists config via keyboard submits', async () => {
    const app = render(<ConfigScreen onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('RegardedTrader config');
    });

    // menu -> pick-kind -> preset -> id -> baseUrl -> model -> key
    for (let i = 0; i < 7; i += 1) {
      app.stdin.write('\r');
      await tick();
    }

    await vi.waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledTimes(1);
      expect(app.lastFrame()).toContain('Added "openai" and set active.');
    });

    const saved = saveConfigMock.mock.calls[0]?.[0];
    expect(saved?.providers.openai?.kind).toBe('openai-compatible');
    expect(saved?.activeProvider).toBe('openai');

    app.unmount();
  });

  it('smoke: dashboard screen renders connection line and launch hint', async () => {
    const app = render(<DashboardScreen serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('Opening dashboard');
      expect(app.lastFrame()).toContain(SERVER_URL);
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    app.unmount();
  });

  it('smoke: main menu renders command list', async () => {
    const app = render(<MainMenu serverUrl={SERVER_URL} />);
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('RegardedTrader');
      expect(app.lastFrame()).toContain('Briefing');
      expect(app.lastFrame()).toContain('Config');
    });
    app.unmount();
  });

  it('interaction: plan screen submits thesis + budget to /plans request body', async () => {
    const app = render(<PlanScreen symbol="NVDA" serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('Describe your thesis');
    });

    await typeText(app.stdin, 'bullish continuation into earnings');
    app.stdin.write('\r');
    await tick();

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('Max loss budget');
    });

    app.stdin.write('\r'); // submit default 500

    await vi.waitFor(() => {
      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(app.lastFrame()).toContain('candidate plans');
    });

    const call = apiMock.mock.calls[0];
    expect(call?.[1]).toBe('/plans');
    const body = JSON.parse(String(call?.[2]?.body)) as {
      symbol: string;
      thesis: string;
      maxLossUsd: number;
    };
    expect(body.symbol).toBe('NVDA');
    expect(body.thesis).toContain('continuation into earnings');
    expect(body.maxLossUsd).toBe(500);

    app.unmount();
  });

  it('smoke: quote screen renders quote snapshot', async () => {
    const app = render(<QuoteScreen symbol="nvda" serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('NVDA');
      expect(app.lastFrame()).toContain('$123.45');
    });

    app.unmount();
  });

  it('smoke: tech screen renders AI commentary block', async () => {
    const app = render(<TechScreen symbol="NVDA" serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('Technician · NVDA');
      expect(app.lastFrame()).toContain('Momentum:');
      expect(app.lastFrame()).toContain('Commentary');
    });

    app.unmount();
  });

  it('smoke: news screen renders ranked headlines and disclaimer', async () => {
    const app = render(<NewsScreen symbol="NVDA" serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('NewsScout · NVDA');
      expect(app.lastFrame()).toContain('NVIDIA raises guidance');
      expect(app.lastFrame()).toContain('Not financial advice');
    });

    app.unmount();
  });

  it('smoke: watchlist list screen renders entries from /tickers', async () => {
    const app = render(<ListScreen serverUrl={SERVER_URL} onDone={() => {}} />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('watchlist (1)');
      expect(app.lastFrame()).toContain('NVDA');
      expect(app.lastFrame()).toContain('NVIDIA Corporation');
    });

    app.unmount();
  });
});
