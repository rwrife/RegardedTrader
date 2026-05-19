// Deterministic seeded sample data for the dashboard demo mode.
// Use this until the real polling/recommender/sentiment/calendar backends ship
// (issues #19, #30, #44, #55). The shapes here are intentionally close to the
// final wire formats so swapping to live data is mostly a fetch swap.

export interface SampleQuote {
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  marketCap: string;
  dayLow: number;
  dayHigh: number;
}

export interface SampleIndicators {
  rsi14: number;
  sma20: number;
  sma50: number;
  ema12: number;
  ema26: number;
  atr14: number;
}

export interface SampleNewsItem {
  id: string;
  source: string;
  title: string;
  url: string;
  publishedAtMinutesAgo: number;
  sentiment?: 'bull' | 'bear' | 'neutral';
}

export interface SampleMention {
  id: string;
  source: 'reddit' | 'stocktwits' | 'hn' | 'cnn' | 'googleNewsOpinion';
  body: string;
  url: string;
  publishedAtMinutesAgo: number;
  score: number; // -1..+1
  meta: { upvotes?: number; comments?: number };
}

export interface SampleSentiment {
  score: number; // -1..+1
  confidence: number; // 0..1
  volume: number;
  bySource: Record<string, { score: number; volume: number }>;
  sparkline: number[]; // 24h of scores
}

export interface SampleVerdict {
  action: 'BUY' | 'HOLD' | 'SELL' | 'AVOID';
  conviction: number;
  rationale: string;
  signals: { name: string; value: string; contribution: number }[];
  contraSignals: { name: string; value: string; contribution: number }[];
}

export interface SampleRecommendation {
  equity: SampleVerdict;
  options: {
    coveredCall: SampleVerdict | null;
    coveredPut: SampleVerdict | null;
    nakedCall: SampleVerdict | null;
    nakedPut: SampleVerdict | null;
  };
  riskFlags: string[];
  history: ('BUY' | 'HOLD' | 'SELL' | 'AVOID')[]; // last 30 days
}

export interface SampleBriefing {
  bullCase: string;
  bearCase: string;
  catalysts: string[];
  risks: string[];
}

export interface SampleEarnings {
  daysUntil: number | null; // negative if past
  when: 'bmo' | 'amc' | 'during';
  epsEstimate?: number;
  epsActual?: number;
}

export interface SampleTicker {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  candles: { o: number; h: number; l: number; c: number; v: number }[]; // last 90 sessions
  quote: SampleQuote;
  indicators: SampleIndicators;
  briefing: SampleBriefing;
  news: SampleNewsItem[];
  mentions: SampleMention[];
  sentiment: SampleSentiment;
  recommendation: SampleRecommendation;
  earnings: SampleEarnings;
}

// ---- deterministic RNG (mulberry32) so the sample is stable across renders ---

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genCandles(seed: number, start: number, drift = 0.0008, vol = 0.018) {
  const r = rng(seed);
  let p = start;
  const out: { o: number; h: number; l: number; c: number; v: number }[] = [];
  // Pick a plausible average daily volume per fixture (seed-derived so it
  // stays stable across renders). Real numbers come from the server when the
  // backend is reachable; this is just sample data for demo mode.
  const avgVol = 5_000_000 + Math.floor(r() * 60_000_000);
  for (let i = 0; i < 90; i++) {
    const o = p;
    const dailyDrift = drift + (r() - 0.5) * 0.0005;
    const c = +(o * (1 + dailyDrift + (r() - 0.5) * vol)).toFixed(2);
    const h = +(Math.max(o, c) * (1 + r() * vol * 0.5)).toFixed(2);
    const l = +(Math.min(o, c) * (1 - r() * vol * 0.5)).toFixed(2);
    // Volume tends to spike on bigger moves; scale by |c-o|/o relative to vol.
    const moveRatio = Math.abs(c - o) / Math.max(o, 0.01) / Math.max(vol, 1e-6);
    const v = Math.max(
      1,
      Math.floor(avgVol * (0.6 + r() * 0.8 + moveRatio * 0.6)),
    );
    out.push({ o, h, l, c, v });
    p = c;
  }
  return out;
}

function genSparkline(seed: number, base = 0.2, amp = 0.5) {
  const r = rng(seed);
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < 48; i++) {
    v = Math.max(-1, Math.min(1, v + (r() - 0.5) * amp * 0.4));
    out.push(+v.toFixed(3));
  }
  return out;
}

// ----- per-ticker fixtures ----------------------------------------------------

export const SAMPLE_TICKERS: SampleTicker[] = [
  ((): SampleTicker => {
    const candles = genCandles(101, 92.5, 0.0022, 0.022);
    const close = candles[candles.length - 1]!.c;
    const prev = candles[candles.length - 2]!.c;
    return {
      symbol: 'NVDA',
      name: 'NVIDIA Corporation',
      exchange: 'NASDAQ',
      sector: 'Technology',
      candles,
      quote: {
        price: close,
        change: +(close - prev).toFixed(2),
        changePercent: +(((close - prev) / prev) * 100).toFixed(2),
        volume: 38_421_900,
        marketCap: '$2.91T',
        dayLow: +(close * 0.985).toFixed(2),
        dayHigh: +(close * 1.018).toFixed(2),
      },
      indicators: {
        rsi14: 67.3,
        sma20: +(close * 0.972).toFixed(2),
        sma50: +(close * 0.94).toFixed(2),
        ema12: +(close * 0.984).toFixed(2),
        ema26: +(close * 0.962).toFixed(2),
        atr14: +(close * 0.024).toFixed(2),
      },
      briefing: {
        bullCase:
          'Datacenter GPU demand remains uncapped through 2026 hyperscaler capex cycles. Blackwell ramp is ahead of plan and gross-margin guide held at 73-75% despite supply mix.',
        bearCase:
          'Valuation prices in ~40% revenue CAGR with zero hyperscaler share loss. Custom silicon (MTIA, Trainium2, TPU v6) is starting to absorb a measurable slice of training compute.',
        catalysts: [
          'GTC 2026 — Blackwell Ultra sampling update',
          'May 21 earnings — guide vs. ~$36B consensus',
          'China H20 export-control resolution',
        ],
        risks: [
          'Hyperscaler digestion phase in 2H26',
          'Gross-margin pressure if HBM4 supply tightens',
          'Geopolitical tail on Taiwan packaging',
        ],
      },
      news: [
        { id: 'n1', source: 'Reuters', title: 'NVIDIA confirms Blackwell Ultra production ramp on schedule for Q3', url: '#', publishedAtMinutesAgo: 22, sentiment: 'bull' },
        { id: 'n2', source: 'Bloomberg', title: 'Microsoft to absorb 23% of H100 H2 allocation, internal memo says', url: '#', publishedAtMinutesAgo: 84, sentiment: 'bull' },
        { id: 'n3', source: 'CNBC', title: 'Analyst trims NVDA target to $1,180 citing custom-silicon share gains', url: '#', publishedAtMinutesAgo: 167, sentiment: 'bear' },
        { id: 'n4', source: 'WSJ', title: 'Commerce Department weighs new chip-export carve-outs', url: '#', publishedAtMinutesAgo: 245, sentiment: 'neutral' },
      ],
      mentions: [
        { id: 'm1', source: 'reddit', body: 'Loaded calls on the dip. Blackwell numbers next print will be a beat.', url: '#', publishedAtMinutesAgo: 5, score: 0.78, meta: { upvotes: 412, comments: 88 } },
        { id: 'm2', source: 'stocktwits', body: 'IV is reasonable for once. Selling 950 puts 21 DTE.', url: '#', publishedAtMinutesAgo: 18, score: 0.42, meta: {} },
        { id: 'm3', source: 'reddit', body: 'Anyone else worried about MTIA pulling training workloads next year?', url: '#', publishedAtMinutesAgo: 42, score: -0.31, meta: { upvotes: 198, comments: 54 } },
        { id: 'm4', source: 'hn', body: 'Long thread on CUDA moat vs. Triton — the moat is narrower than NVDA bulls admit.', url: '#', publishedAtMinutesAgo: 105, score: -0.12, meta: { upvotes: 287, comments: 142 } },
        { id: 'm5', source: 'cnn', body: 'NVIDIA shares advanced as analysts upgraded ahead of next week earnings.', url: '#', publishedAtMinutesAgo: 198, score: 0.55, meta: {} },
      ],
      sentiment: {
        score: 0.34,
        confidence: 0.71,
        volume: 1284,
        bySource: {
          reddit: { score: 0.41, volume: 720 },
          stocktwits: { score: 0.52, volume: 312 },
          hn: { score: -0.05, volume: 41 },
          cnn: { score: 0.18, volume: 9 },
          googleNewsOpinion: { score: 0.27, volume: 202 },
        },
        sparkline: genSparkline(202, 0.25, 0.45),
      },
      recommendation: {
        equity: {
          action: 'BUY',
          conviction: 0.71,
          rationale:
            'Multiple confirmations: RSI in healthy momentum band (67), 20/50-SMA both rising, sentiment +0.34 driven by social volume, no earnings risk within 7d. Beat-prone setup into the print.',
          signals: [
            { name: 'rsi14', value: '67.3', contribution: 0.42 },
            { name: 'sentiment.30m', value: '+0.34', contribution: 0.31 },
            { name: 'sma20>sma50', value: 'true', contribution: 0.22 },
            { name: 'news.pulse.bull', value: '3 of 4', contribution: 0.18 },
          ],
          contraSignals: [
            { name: 'iv.atm', value: '52%', contribution: -0.14 },
            { name: 'hn.sentiment', value: '-0.05', contribution: -0.07 },
          ],
        },
        options: {
          coveredCall: {
            action: 'HOLD',
            conviction: 0.46,
            rationale: 'High IV is attractive for premium capture, but earnings 10d out caps the strike you can comfortably hold.',
            signals: [{ name: 'iv.atm', value: '52%', contribution: 0.34 }],
            contraSignals: [{ name: 'earnings.daysUntil', value: '10', contribution: -0.28 }],
          },
          coveredPut: {
            action: 'AVOID',
            conviction: 0.62,
            rationale: 'Stock is in an uptrend; covered puts forgo upside without compensating premium.',
            signals: [],
            contraSignals: [{ name: 'sma20>sma50', value: 'true', contribution: -0.41 }],
          },
          nakedCall: null,
          nakedPut: null,
        },
        riskFlags: ['earnings within 14d', 'elevated iv'],
        history: ['HOLD','HOLD','HOLD','BUY','BUY','HOLD','HOLD','BUY','BUY','BUY','BUY','HOLD','BUY','BUY','BUY','BUY','BUY','HOLD','HOLD','BUY','BUY','BUY','BUY','BUY','BUY','HOLD','HOLD','BUY','BUY','BUY'],
      },
      earnings: { daysUntil: 10, when: 'amc', epsEstimate: 0.83 },
    };
  })(),

  ((): SampleTicker => {
    const candles = genCandles(202, 188.4, 0.0006, 0.013);
    const close = candles[candles.length - 1]!.c;
    const prev = candles[candles.length - 2]!.c;
    return {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      sector: 'Technology',
      candles,
      quote: {
        price: close,
        change: +(close - prev).toFixed(2),
        changePercent: +(((close - prev) / prev) * 100).toFixed(2),
        volume: 52_904_300,
        marketCap: '$3.04T',
        dayLow: +(close * 0.992).toFixed(2),
        dayHigh: +(close * 1.006).toFixed(2),
      },
      indicators: {
        rsi14: 48.6,
        sma20: +(close * 1.004).toFixed(2),
        sma50: +(close * 0.998).toFixed(2),
        ema12: +(close * 1.001).toFixed(2),
        ema26: +(close * 0.999).toFixed(2),
        atr14: +(close * 0.013).toFixed(2),
      },
      briefing: {
        bullCase:
          'Services growth held above 15% YoY for the eighth consecutive quarter. Vision Pro 2 cycle is rumored for September with materially lower BOM.',
        bearCase:
          'iPhone unit growth still flat ex-FX. China revenue contraction continued in the most recent quarter. AI narrative remains a follower, not leader.',
        catalysts: ['WWDC keynote', 'India production milestones', 'Services margin re-rating'],
        risks: ['China demand', 'Antitrust ruling in App Store case', 'FX drag'],
      },
      news: [
        { id: 'n1', source: 'Reuters', title: 'Apple to expand India iPhone output by 40% next FY', url: '#', publishedAtMinutesAgo: 41, sentiment: 'bull' },
        { id: 'n2', source: 'Bloomberg', title: 'Apple Intelligence rollout slipping to October in EU', url: '#', publishedAtMinutesAgo: 132, sentiment: 'bear' },
        { id: 'n3', source: 'CNBC', title: 'Services revenue trajectory keeps margin expansion intact, analyst says', url: '#', publishedAtMinutesAgo: 280, sentiment: 'bull' },
      ],
      mentions: [
        { id: 'm1', source: 'reddit', body: 'AAPL is a bond at this point. Boring is fine.', url: '#', publishedAtMinutesAgo: 12, score: 0.08, meta: { upvotes: 156, comments: 41 } },
        { id: 'm2', source: 'stocktwits', body: 'Iron condor 180/195 next month, IV is cheap.', url: '#', publishedAtMinutesAgo: 33, score: 0.12, meta: {} },
        { id: 'm3', source: 'googleNewsOpinion', body: 'Apple AI strategy: late, but the install base buys time.', url: '#', publishedAtMinutesAgo: 88, score: 0.04, meta: {} },
      ],
      sentiment: {
        score: 0.05,
        confidence: 0.58,
        volume: 612,
        bySource: {
          reddit: { score: 0.06, volume: 342 },
          stocktwits: { score: 0.11, volume: 188 },
          hn: { score: -0.12, volume: 33 },
          cnn: { score: 0.03, volume: 4 },
          googleNewsOpinion: { score: 0.04, volume: 45 },
        },
        sparkline: genSparkline(303, 0.05, 0.25),
      },
      recommendation: {
        equity: {
          action: 'HOLD',
          conviction: 0.52,
          rationale:
            'Range-bound between SMA20 and SMA50, RSI neutral, sentiment near zero. No tradable edge until WWDC or a clear China data point.',
          signals: [{ name: 'iv.atm', value: '18%', contribution: 0.16 }],
          contraSignals: [
            { name: 'rsi14', value: '48.6', contribution: -0.04 },
            { name: 'sentiment.30m', value: '+0.05', contribution: -0.02 },
          ],
        },
        options: {
          coveredCall: {
            action: 'BUY',
            conviction: 0.64,
            rationale: 'Low realized vol + cheap IV + range-bound action = clean covered-call setup. Sell 30Δ 21 DTE.',
            signals: [
              { name: 'iv.percentile', value: '14%', contribution: 0.41 },
              { name: 'range.30d', value: 'tight', contribution: 0.28 },
            ],
            contraSignals: [],
          },
          coveredPut: { action: 'HOLD', conviction: 0.4, rationale: 'No clear edge.', signals: [], contraSignals: [] },
          nakedCall: null,
          nakedPut: null,
        },
        riskFlags: [],
        history: ['HOLD','HOLD','BUY','HOLD','HOLD','SELL','HOLD','HOLD','HOLD','HOLD','BUY','BUY','HOLD','HOLD','HOLD','HOLD','SELL','HOLD','HOLD','HOLD','HOLD','HOLD','BUY','HOLD','HOLD','HOLD','HOLD','HOLD','HOLD','HOLD'],
      },
      earnings: { daysUntil: 38, when: 'amc' },
    };
  })(),

  ((): SampleTicker => {
    const candles = genCandles(303, 242.8, -0.0014, 0.028);
    const close = candles[candles.length - 1]!.c;
    const prev = candles[candles.length - 2]!.c;
    return {
      symbol: 'TSLA',
      name: 'Tesla, Inc.',
      exchange: 'NASDAQ',
      sector: 'Consumer Discretionary',
      candles,
      quote: {
        price: close,
        change: +(close - prev).toFixed(2),
        changePercent: +(((close - prev) / prev) * 100).toFixed(2),
        volume: 88_120_500,
        marketCap: '$612B',
        dayLow: +(close * 0.971).toFixed(2),
        dayHigh: +(close * 1.024).toFixed(2),
      },
      indicators: {
        rsi14: 28.4,
        sma20: +(close * 1.06).toFixed(2),
        sma50: +(close * 1.11).toFixed(2),
        ema12: +(close * 1.034).toFixed(2),
        ema26: +(close * 1.07).toFixed(2),
        atr14: +(close * 0.041).toFixed(2),
      },
      briefing: {
        bullCase:
          'FSD v13 customer wide rollout, Cybercab unveil, energy storage backlog up 3x YoY. Robotaxi opt-in could re-rate the multiple.',
        bearCase:
          'Auto deliveries declined YoY two quarters in a row. China BYD price pressure persists. FSD adoption rate still <20%.',
        catalysts: ['Cybercab event', 'FSD v13 rollout', 'Q2 deliveries data'],
        risks: ['Margin compression', 'CEO attention split', 'Demand destruction in EU'],
      },
      news: [
        { id: 'n1', source: 'Reuters', title: 'Tesla cuts Model Y prices in China by 4% amid weak demand', url: '#', publishedAtMinutesAgo: 14, sentiment: 'bear' },
        { id: 'n2', source: 'Bloomberg', title: 'Cybercab event date pushed to October, sources say', url: '#', publishedAtMinutesAgo: 92, sentiment: 'bear' },
        { id: 'n3', source: 'CNBC', title: 'FSD v13 demo videos show meaningful intervention-rate drop', url: '#', publishedAtMinutesAgo: 198, sentiment: 'bull' },
        { id: 'n4', source: 'WSJ', title: 'Energy storage segment to break out as standalone reporting line', url: '#', publishedAtMinutesAgo: 312, sentiment: 'bull' },
      ],
      mentions: [
        { id: 'm1', source: 'reddit', body: 'Bought puts at 270. Easiest short of the year.', url: '#', publishedAtMinutesAgo: 7, score: -0.82, meta: { upvotes: 1204, comments: 412 } },
        { id: 'm2', source: 'stocktwits', body: 'Oversold bounce setup. RSI 28 + earnings 3 weeks out.', url: '#', publishedAtMinutesAgo: 21, score: 0.34, meta: {} },
        { id: 'm3', source: 'reddit', body: 'China price cut #4 this year. Margins are cooked.', url: '#', publishedAtMinutesAgo: 48, score: -0.71, meta: { upvotes: 612, comments: 198 } },
        { id: 'm4', source: 'hn', body: 'FSD v13 numbers are real progress. The market is mispricing the optionality.', url: '#', publishedAtMinutesAgo: 132, score: 0.42, meta: { upvotes: 184, comments: 88 } },
        { id: 'm5', source: 'cnn', body: 'Tesla shares slid as another price cut weighed on margin outlook.', url: '#', publishedAtMinutesAgo: 175, score: -0.61, meta: {} },
        { id: 'm6', source: 'googleNewsOpinion', body: 'The Tesla story has fundamentally shifted from cars to robotics. The market has not caught up.', url: '#', publishedAtMinutesAgo: 240, score: 0.38, meta: {} },
      ],
      sentiment: {
        score: -0.42,
        confidence: 0.81,
        volume: 3120,
        bySource: {
          reddit: { score: -0.58, volume: 2104 },
          stocktwits: { score: -0.21, volume: 612 },
          hn: { score: 0.18, volume: 88 },
          cnn: { score: -0.44, volume: 28 },
          googleNewsOpinion: { score: -0.09, volume: 288 },
        },
        sparkline: genSparkline(404, -0.3, 0.6),
      },
      recommendation: {
        equity: {
          action: 'SELL',
          conviction: 0.58,
          rationale:
            'Trend is broken (price below SMA20 and SMA50), sentiment deeply negative, and the China price-cut cadence is accelerating. RSI 28 hints at a tactical bounce but we do not fade trends on oversold alone.',
          signals: [
            { name: 'sentiment.30m', value: '-0.42', contribution: -0.38 },
            { name: 'price<sma50', value: 'true', contribution: -0.31 },
            { name: 'news.pulse.bear', value: '3 of 4', contribution: -0.22 },
          ],
          contraSignals: [
            { name: 'rsi14', value: '28.4', contribution: 0.18 },
            { name: 'iv.atm', value: '64%', contribution: 0.08 },
          ],
        },
        options: {
          coveredCall: {
            action: 'BUY',
            conviction: 0.7,
            rationale: 'Sell the rip. Far OTM calls capture rich premium without giving up much upside the trend will not deliver anyway.',
            signals: [
              { name: 'iv.atm', value: '64%', contribution: 0.49 },
              { name: 'trend.down', value: 'true', contribution: 0.28 },
            ],
            contraSignals: [],
          },
          coveredPut: {
            action: 'HOLD',
            conviction: 0.4,
            rationale: 'Bearish but oversold; wait for a bounce before selling puts under support.',
            signals: [],
            contraSignals: [{ name: 'rsi14', value: '28.4', contribution: -0.22 }],
          },
          nakedCall: null,
          nakedPut: null,
        },
        riskFlags: ['oversold rebound risk', 'earnings within 21d'],
        history: ['HOLD','HOLD','SELL','SELL','HOLD','SELL','SELL','HOLD','HOLD','SELL','SELL','SELL','SELL','HOLD','SELL','SELL','SELL','HOLD','HOLD','SELL','SELL','SELL','SELL','SELL','HOLD','SELL','SELL','SELL','SELL','SELL'],
      },
      earnings: { daysUntil: 21, when: 'amc', epsEstimate: 0.61 },
    };
  })(),

  ((): SampleTicker => {
    const candles = genCandles(404, 461.2, 0.0009, 0.009);
    const close = candles[candles.length - 1]!.c;
    const prev = candles[candles.length - 2]!.c;
    return {
      symbol: 'SPY',
      name: 'SPDR S&P 500 ETF',
      exchange: 'NYSE',
      sector: 'Index ETF',
      candles,
      quote: {
        price: close,
        change: +(close - prev).toFixed(2),
        changePercent: +(((close - prev) / prev) * 100).toFixed(2),
        volume: 68_412_700,
        marketCap: '$520B AUM',
        dayLow: +(close * 0.995).toFixed(2),
        dayHigh: +(close * 1.004).toFixed(2),
      },
      indicators: {
        rsi14: 56.1,
        sma20: +(close * 0.998).toFixed(2),
        sma50: +(close * 0.989).toFixed(2),
        ema12: +(close * 1.0).toFixed(2),
        ema26: +(close * 0.994).toFixed(2),
        atr14: +(close * 0.011).toFixed(2),
      },
      briefing: {
        bullCase: 'Broad index, low realized vol, breadth improving. CPI prints have cooled four months running.',
        bearCase: 'Concentration in mag-7 means a single bad earnings print can pull the index 1.5%.',
        catalysts: ['Fed meeting', 'CPI print', 'NFP'],
        risks: ['Concentration', 'Election volatility', 'Credit spread widening'],
      },
      news: [
        { id: 'n1', source: 'Reuters', title: 'S&P 500 closes at fresh record on cooler-than-expected CPI', url: '#', publishedAtMinutesAgo: 36, sentiment: 'bull' },
        { id: 'n2', source: 'Bloomberg', title: 'Fed minutes show consensus tilting toward earlier cuts', url: '#', publishedAtMinutesAgo: 122, sentiment: 'bull' },
      ],
      mentions: [
        { id: 'm1', source: 'stocktwits', body: 'Just stay long the index. Boring works.', url: '#', publishedAtMinutesAgo: 12, score: 0.18, meta: {} },
        { id: 'm2', source: 'reddit', body: 'SPY 470 calls expiry Friday. Hedge or YOLO, you decide.', url: '#', publishedAtMinutesAgo: 41, score: 0.05, meta: { upvotes: 88, comments: 22 } },
      ],
      sentiment: {
        score: 0.18,
        confidence: 0.62,
        volume: 244,
        bySource: {
          reddit: { score: 0.08, volume: 120 },
          stocktwits: { score: 0.21, volume: 88 },
          hn: { score: 0.0, volume: 4 },
          cnn: { score: 0.32, volume: 12 },
          googleNewsOpinion: { score: 0.26, volume: 20 },
        },
        sparkline: genSparkline(505, 0.15, 0.18),
      },
      recommendation: {
        equity: {
          action: 'HOLD',
          conviction: 0.55,
          rationale: 'Broad-market ETF in a slow grind higher. Trend intact, RSI neutral. No edge in trading; collect dividends.',
          signals: [{ name: 'breadth', value: 'improving', contribution: 0.21 }],
          contraSignals: [{ name: 'concentration.mag7', value: '32%', contribution: -0.14 }],
        },
        options: {
          coveredCall: { action: 'HOLD', conviction: 0.5, rationale: 'IV is low; not enough premium to justify capping upside.', signals: [], contraSignals: [{ name: 'iv.percentile', value: '11%', contribution: -0.28 }] },
          coveredPut: { action: 'HOLD', conviction: 0.45, rationale: 'No edge.', signals: [], contraSignals: [] },
          nakedCall: null,
          nakedPut: null,
        },
        riskFlags: [],
        history: Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 'BUY' : 'HOLD')) as ('BUY' | 'HOLD' | 'SELL' | 'AVOID')[],
      },
      earnings: { daysUntil: null, when: 'amc' },
    };
  })(),
];

export const SAMPLE_CALENDAR = [
  { dateOffset: 0, kind: 'market_open' as const, title: 'Regular session 09:30–16:00 ET' },
  { dateOffset: 3, kind: 'market_early_close' as const, title: 'Early close 13:00 ET (day before Memorial Day)' },
  { dateOffset: 4, kind: 'market_holiday' as const, title: 'Memorial Day — markets closed' },
  { dateOffset: 10, kind: 'earnings' as const, symbol: 'NVDA', title: 'NVDA earnings — AMC' },
  { dateOffset: 21, kind: 'earnings' as const, symbol: 'TSLA', title: 'TSLA earnings — AMC' },
  { dateOffset: 38, kind: 'earnings' as const, symbol: 'AAPL', title: 'AAPL earnings — AMC' },
];

export const SAMPLE_MARKET_STATE: {
  state: 'open' | 'pre' | 'post' | 'closed';
  label: string;
  note?: string;
} = {
  state: 'open',
  label: 'Open',
  note: 'Early close on Fri (13:00 ET)',
};

export function findSample(symbol: string): SampleTicker | undefined {
  return SAMPLE_TICKERS.find((t) => t.symbol === symbol.toUpperCase());
}
