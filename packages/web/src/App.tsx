import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SAMPLE_TICKERS,
  SAMPLE_CALENDAR,
  SAMPLE_MARKET_STATE,
  findSample,
  type SampleTicker,
  type SampleVerdict,
} from './sample-data';
import { Settings } from './routes/settings.js';
import { Brief } from './routes/brief.js';
import { useLiveQuote } from './hooks/useLiveQuote.js';
import { useHistory } from './hooks/useHistory.js';
import { computeRating } from '@regardedtrader/core/rating';
import { RatingBadge } from './components/RatingBadge.js';
import { CandleChart, type Candle } from './components/CandleChart.js';

// Tiny hash-based router so the dashboard stays a single bundle without
// pulling in react-router. Routes: `#/` (default), `#/settings`, and
// `#/brief/:symbol` (full Orchestrator briefing pipeline, issue #139).
type Route =
  | { kind: 'home' }
  | { kind: 'settings' }
  | { kind: 'brief'; symbol: string };

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (raw.startsWith('settings')) return { kind: 'settings' };
  const briefMatch = raw.match(/^brief\/([^/?#]+)/);
  if (briefMatch) return { kind: 'brief', symbol: decodeURIComponent(briefMatch[1]!).toUpperCase() };
  return { kind: 'home' };
}

type NavTarget = 'home' | 'settings' | { kind: 'brief'; symbol: string };

function useHashRoute(): [Route, (r: NavTarget) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { kind: 'home' } : parseRoute(window.location.hash),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((r: NavTarget): void => {
    if (typeof window === 'undefined') return;
    if (r === 'settings') {
      window.location.hash = '#/settings';
    } else if (r === 'home') {
      window.location.hash = '#/';
    } else {
      window.location.hash = `#/brief/${encodeURIComponent(r.symbol)}`;
    }
  }, []);
  return [route, navigate];
}

const DISCLAIMER =
  'Not financial advice. AI-generated analysis based on public data. Verify everything before trading.';

// ---- M1: ticker intake & validation surface ------------------------------

interface TickerProfile {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  industry: string;
  description: string;
  sources: string[];
  validatedAt: string;
}
interface WatchlistEntry {
  profile: TickerProfile;
  addedAt: string;
}
type ValidationResult =
  | { ok: true; profile: TickerProfile; cached?: boolean }
  | { ok: false; symbol: string; error: string; suggestions?: { symbol: string; name?: string; reason?: string }[] };

type Tab = 'briefing' | 'sentiment' | 'news' | 'recommendation' | 'calendar' | 'chart';

export function App() {
  const [route, navigate] = useHashRoute();
  // Demo mode is on whenever the backend is unreachable or ?demo=1 is set.
  const demoForced = typeof window !== 'undefined' && /[?&]demo=1\b/.test(window.location.search);
  const [demo, setDemo] = useState<boolean>(demoForced || true);
  if (route.kind === 'settings') {
    return <Settings onClose={() => navigate('home')} />;
  }
  if (route.kind === 'brief') {
    return <Brief symbol={route.symbol} onClose={() => navigate('home')} />;
  }
  const [active, setActive] = useState<string>(SAMPLE_TICKERS[0]!.symbol);
  const [tab, setTab] = useState<Tab>('briefing');
  const [query, setQuery] = useState('');

  // Probe the API once to decide if we should drop demo mode.
  useEffect(() => {
    if (demoForced) return;
    fetch('/api/health', { method: 'GET' })
      .then((r) => {
        if (r.ok) setDemo(false);
      })
      .catch(() => {
        /* stay in demo */
      });
  }, [demoForced]);

  const ticker: SampleTicker | undefined = useMemo(() => findSample(active), [active]);

  return (
    <div className="min-h-screen bg-app text-fg">
      <TopBar demo={demo} onOpenSettings={() => navigate('settings')} />

      <div className="max-w-7xl mx-auto px-6 py-4 grid grid-cols-12 gap-6">
        {/* Sidebar: validated watchlist + filter + calendar strip */}
        <aside className="col-span-12 md:col-span-3 space-y-4">
          <TickerIntake demo={demo} />
          <Watchlist
            active={active}
            onPick={setActive}
            query={query}
            setQuery={setQuery}
            demo={demo}
          />
          <CalendarStrip />
        </aside>

        {/* Main column */}
        <main className="col-span-12 md:col-span-9 space-y-4">
          {ticker ? (
            <>
              <QuoteHeader t={ticker} demo={demo} />
              <TabBar tab={tab} setTab={setTab} />
              {tab === 'briefing' && <BriefingTab t={ticker} />}
              {tab === 'sentiment' && <SentimentTab t={ticker} />}
              {tab === 'news' && <NewsTab t={ticker} />}
              {tab === 'recommendation' && <RecommendationTab t={ticker} />}
              {tab === 'calendar' && <CalendarTab t={ticker} />}
              {tab === 'chart' && <ChartTab t={ticker} demo={demo} />}
            </>
          ) : (
            <div className="text-fg-muted text-sm">No ticker selected.</div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ demo, onOpenSettings }: { demo: boolean; onOpenSettings: () => void }) {
  return (
    <header className="border-b border-border-subtle bg-surface">
      <div className="max-w-7xl mx-auto px-6 h-12 flex items-center gap-4 text-xs">
        <div className="flex items-center gap-2 font-semibold">
          <span className="text-up">▲</span>
          <span className="tracking-tight">RegardedTrader</span>
        </div>
        <span className="text-fg-muted">·</span>
        <span className="num text-fg-secondary">local · 127.0.0.1:4317</span>
        <span className="text-fg-muted">·</span>
        <MarketPill />
        {demo && (
          <span className="ml-2 px-1.5 py-0.5 rounded bg-ai/10 text-ai text-[10px] font-mono tracking-wider">
            DEMO DATA
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-fg-muted">
          <span className="num">{new Date().toUTCString().slice(17, 25)} UTC</span>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
            className="px-1.5 py-0.5 rounded border border-border-subtle text-[12px] hover:text-ai hover:border-ai"
          >
            ⚙
          </button>
          <kbd className="px-1.5 py-0.5 rounded border border-border-subtle text-[10px]">⌘K</kbd>
        </div>
      </div>
    </header>
  );
}

function MarketPill() {
  const s = SAMPLE_MARKET_STATE;
  const color =
    s.state === 'open' ? 'text-up' : s.state === 'closed' ? 'text-down' : 'text-fg-secondary';
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color.replace('text-', 'bg-')}`} />
      <span className={color}>{s.label}</span>
      {s.note && <span className="text-fg-muted">· {s.note}</span>}
    </span>
  );
}

function Watchlist({
  active,
  onPick,
  query,
  setQuery,
  demo,
}: {
  active: string;
  onPick: (s: string) => void;
  query: string;
  setQuery: (s: string) => void;
  demo: boolean;
}) {
  const filtered = SAMPLE_TICKERS.filter(
    (t) =>
      !query ||
      t.symbol.toLowerCase().includes(query.toLowerCase()) ||
      t.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="border border-border-subtle bg-surface rounded">
      <div className="p-2 border-b border-border-subtle">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter watchlist…"
          className="w-full bg-surface-2 border border-border-subtle rounded px-2 py-1 text-xs focus:outline-none focus:border-ai"
        />
      </div>
      <ul className="text-xs">
        {filtered.map((t) => (
          <WatchlistRow
            key={t.symbol}
            t={t}
            active={active === t.symbol}
            onPick={onPick}
            demo={demo}
          />
        ))}
      </ul>
    </div>
  );
}

function WatchlistRow({
  t,
  active,
  onPick,
  demo,
}: {
  t: SampleTicker;
  active: boolean;
  onPick: (s: string) => void;
  demo: boolean;
}) {
  // Subscribe each row to live quotes when the backend is reachable. The hook
  // pauses polling when the tab is hidden and adapts cadence to market state,
  // so N rows == N polls but each one is cheap.
  const live = useLiveQuote(t.symbol, { enabled: !demo });
  const price = live.quote?.price ?? t.quote.price;
  const change = live.quote?.change ?? t.quote.change;
  const changePercent = live.quote?.changePercent ?? t.quote.changePercent;
  const up = change >= 0;
  return (
    <li>
      <button
        onClick={() => onPick(t.symbol)}
        className={`w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-surface-2 ${
          active ? 'bg-surface-2' : ''
        }`}
      >
        <span className="font-semibold tracking-tight w-12">{t.symbol}</span>
        <span className="num text-fg-secondary">${price.toFixed(2)}</span>
        <span className={`num ml-auto ${up ? 'text-up' : 'text-down'}`}>
          {up ? '▲' : '▼'} {up ? '+' : ''}
          {changePercent.toFixed(2)}%
        </span>
      </button>
    </li>
  );
}

function CalendarStrip() {
  return (
    <div className="border border-border-subtle bg-surface rounded p-3">
      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-2">
        Next 14 days
      </h3>
      <ul className="space-y-1.5 text-xs">
        {SAMPLE_CALENDAR.map((ev, i) => {
          const dot =
            ev.kind === 'market_holiday'
              ? 'bg-down'
              : ev.kind === 'market_early_close'
                ? 'bg-warn'
                : 'bg-ai';
          return (
            <li key={i} className="flex items-center gap-2">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
              <span className="num text-fg-muted w-8">+{ev.dateOffset}d</span>
              <span className="truncate" title={ev.title}>
                {ev.title}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QuoteHeader({ t, demo }: { t: SampleTicker; demo: boolean }) {
  // Live quote (#81): polls the local server when the backend is reachable;
  // falls back to the static sample data in demo mode.
  const live = useLiveQuote(t.symbol, { enabled: !demo });
  const price = live.quote?.price ?? t.quote.price;
  const change = live.quote?.change ?? t.quote.change;
  const changePercent = live.quote?.changePercent ?? t.quote.changePercent;
  const up = change >= 0;
  const toneText = up ? 'text-up' : 'text-down';
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '';
  // Rating (#82): prefer the live server-computed rating; fall back to a
  // locally-computed one from the sample-data signals so the badge stays
  // visible in demo mode.
  const rating = useMemo(() => {
    if (live.quote?.rating) return live.quote.rating;
    return computeRating({
      symbol: t.symbol,
      changePercent,
      rsi: t.indicators.rsi14,
    });
  }, [live.quote?.rating, t.symbol, t.indicators.rsi14, changePercent]);
  return (
    <div className="border border-border-subtle bg-surface rounded p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-4 flex-wrap">
        <div className="flex items-baseline gap-3">
          <span className="text-xl font-semibold tracking-tight">{t.symbol}</span>
          <span className="text-xs text-fg-muted">{t.name}</span>
        </div>
        <span className={`num text-2xl ${toneText}`}>${price.toFixed(2)}</span>
        <span className={`num text-sm ${toneText}`}>
          {arrow} {sign}
          {change.toFixed(2)} ({sign}
          {changePercent.toFixed(2)}%)
        </span>
        {!demo && (
          <LiveQuoteIndicator
            lastUpdatedAt={live.lastUpdatedAt}
            isLoading={live.isLoading}
            error={live.error}
          />
        )}
        {t.earnings.daysUntil !== null && t.earnings.daysUntil <= 14 && (
          <span className="px-2 py-0.5 rounded bg-warn/10 text-warn text-[10px] font-mono tracking-wider">
            EARNINGS IN {t.earnings.daysUntil}D · {t.earnings.when.toUpperCase()}
          </span>
        )}
        </div>
        {/* Rating badge (#82) — top-right of the price box. */}
        <RatingBadge rating={rating} className="mt-0.5 shrink-0" />
      </div>
      <div className="mt-3 flex gap-5 text-xs text-fg-secondary num">
        <span>
          RSI <span className="text-fg">{t.indicators.rsi14.toFixed(1)}</span>
        </span>
        <span>
          SMA20 <span className="text-fg">{t.indicators.sma20.toFixed(2)}</span>
        </span>
        <span>
          SMA50 <span className="text-fg">{t.indicators.sma50.toFixed(2)}</span>
        </span>
        <span>
          ATR <span className="text-fg">{t.indicators.atr14.toFixed(2)}</span>
        </span>
        <span>
          Vol <span className="text-fg">{(t.quote.volume / 1e6).toFixed(1)}M</span>
        </span>
        <span className="ml-auto">
          Day <span className="text-fg">${t.quote.dayLow.toFixed(2)}</span>
          {' – '}
          <span className="text-fg">${t.quote.dayHigh.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}

function LiveQuoteIndicator({
  lastUpdatedAt,
  isLoading,
  error,
}: {
  lastUpdatedAt: Date | null;
  isLoading: boolean;
  error: string | null;
}) {
  // Re-render once a second so the "updated Xs ago" label stays fresh even
  // when nothing else in the parent changes.
  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (error) {
    // Surface the "please configure a provider" 503 with an actionable hint
    // rather than the generic "live quote error" badge.
    const needsProvider = /no market-data provider/i.test(error);
    if (needsProvider) {
      return (
        <span
          className="text-[10px] font-mono tracking-wider text-down"
          title={error}
          aria-label="market-data provider not configured"
        >
          ⚠ configure provider in Settings
        </span>
      );
    }
    return (
      <span
        className="text-[10px] font-mono tracking-wider text-down"
        title={error}
        aria-label={`live quote error: ${error}`}
      >
        ⚠ live quote error
      </span>
    );
  }
  if (!lastUpdatedAt) {
    return (
      <span className="text-[10px] font-mono tracking-wider text-fg-muted">
        {isLoading ? 'loading…' : 'waiting…'}
      </span>
    );
  }
  const secs = Math.max(0, Math.floor((Date.now() - lastUpdatedAt.getTime()) / 1000));
  return (
    <span
      className={`text-[10px] font-mono tracking-wider ${isLoading ? 'text-ai' : 'text-fg-muted'}`}
      aria-label={`updated ${secs} seconds ago`}
    >
      {isLoading ? '↻ refreshing…' : `updated ${secs}s ago`}
    </span>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'briefing', label: 'Briefing' },
    { id: 'recommendation', label: 'Recommendation' },
    { id: 'chart', label: 'Chart' },
    { id: 'sentiment', label: 'Sentiment' },
    { id: 'news', label: 'News' },
    { id: 'calendar', label: 'Calendar' },
  ];
  return (
    <div className="flex gap-1 border-b border-border-subtle text-xs">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={`px-3 py-2 border-b-2 -mb-px ${
            tab === t.id
              ? 'border-ai text-fg'
              : 'border-transparent text-fg-muted hover:text-fg-secondary'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- Tabs -----------------------------------------------------------------

function AiCard({ children, label = 'AI' }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="relative border border-border-subtle bg-surface rounded p-6 pl-7">
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-ai rounded-l" />
      <div className="absolute left-3 top-3">
        <span className="text-[10px] font-mono tracking-wider px-1.5 py-0.5 rounded bg-ai/10 text-ai">
          {label}
        </span>
      </div>
      <div className="pt-4">{children}</div>
    </div>
  );
}

function Section({ title, tone, body }: { title: string; tone: 'up' | 'down'; body: string }) {
  const cls = tone === 'up' ? 'text-up' : 'text-down';
  return (
    <div>
      <h2 className={`text-sm font-semibold uppercase tracking-wider ${cls}`}>{title}</h2>
      <p className="text-sm leading-relaxed text-fg mt-2">{body}</p>
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-secondary">{title}</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((i, idx) => (
          <li key={idx} className="flex gap-2">
            <span className="text-fg-muted">›</span>
            <span>{i}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BriefingTab({ t }: { t: SampleTicker }) {
  const briefHref = `#/brief/${encodeURIComponent(t.symbol)}`;
  return (
    <AiCard>
      <div className="flex justify-end mb-3">
        <a
          href={briefHref}
          className="text-xs underline text-fg-secondary hover:text-fg"
          aria-label={`Open full briefing pipeline for ${t.symbol}`}
        >
          Open full briefing pipeline →
        </a>
      </div>
      <div className="grid md:grid-cols-2 gap-6">
        <Section title="Bull case" tone="up" body={t.briefing.bullCase} />
        <Section title="Bear case" tone="down" body={t.briefing.bearCase} />
      </div>
      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <ListSection title="Catalysts" items={t.briefing.catalysts} />
        <ListSection title="Risks" items={t.briefing.risks} />
      </div>
      <p className="mt-6 text-[11px] text-fg-muted italic">{DISCLAIMER}</p>
    </AiCard>
  );
}

function verdictColor(action: SampleVerdict['action']) {
  switch (action) {
    case 'BUY':
      return 'text-up';
    case 'SELL':
      return 'text-down';
    case 'AVOID':
      return 'text-down';
    default:
      return 'text-fg-secondary';
  }
}

function VerdictBlock({ title, v }: { title: string; v: SampleVerdict | null }) {
  if (!v) {
    return (
      <div className="border border-border-subtle/60 rounded p-3 text-xs text-fg-muted">
        <div className="font-mono tracking-wider uppercase text-[10px] mb-1">{title}</div>
        <div>— not available (policy or data gate)</div>
      </div>
    );
  }
  const color = verdictColor(v.action);
  return (
    <div className="border border-border-subtle rounded p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono tracking-wider uppercase text-[10px] text-fg-muted">{title}</div>
        <div className={`text-sm font-semibold ${color}`}>
          {v.action} <span className="text-fg-muted text-xs">· {(v.conviction * 100).toFixed(0)}%</span>
        </div>
      </div>
      <p className="text-xs text-fg leading-relaxed">{v.rationale}</p>
      {(v.signals.length > 0 || v.contraSignals.length > 0) && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            {v.signals.map((s, i) => (
              <div key={i} className="flex justify-between gap-2 num">
                <span className="text-fg-muted">{s.name}</span>
                <span className="text-up">+{s.contribution.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div>
            {v.contraSignals.map((s, i) => (
              <div key={i} className="flex justify-between gap-2 num">
                <span className="text-fg-muted">{s.name}</span>
                <span className="text-down">{s.contribution.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecommendationTab({ t }: { t: SampleTicker }) {
  const r = t.recommendation;
  return (
    <AiCard label="REC">
      <div className="grid md:grid-cols-2 gap-3">
        <VerdictBlock title="Equity" v={r.equity} />
        <VerdictBlock title="Covered Call" v={r.options.coveredCall} />
        <VerdictBlock title="Covered Put" v={r.options.coveredPut} />
        <VerdictBlock title="Naked Call" v={r.options.nakedCall} />
        <VerdictBlock title="Naked Put" v={r.options.nakedPut} />
      </div>
      {r.riskFlags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {r.riskFlags.map((f) => (
            <span
              key={f}
              className="px-2 py-0.5 rounded bg-warn/10 text-warn text-[10px] font-mono tracking-wider"
            >
              ⚠ {f}
            </span>
          ))}
        </div>
      )}
      <div className="mt-4">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          30-day verdict history
        </div>
        <div className="flex gap-0.5">
          {r.history.map((v, i) => {
            const c =
              v === 'BUY'
                ? 'bg-up'
                : v === 'SELL'
                  ? 'bg-down'
                  : v === 'AVOID'
                    ? 'bg-down/60'
                    : 'bg-surface-2';
            return <div key={i} className={`h-4 w-2 ${c}`} title={`${30 - i}d ago · ${v}`} />;
          })}
        </div>
      </div>
      <p className="mt-6 text-[11px] text-fg-muted italic">{DISCLAIMER}</p>
    </AiCard>
  );
}

function SentimentTab({ t }: { t: SampleTicker }) {
  const s = t.sentiment;
  const pct = ((s.score + 1) / 2) * 100;
  const color = s.score >= 0.1 ? 'bg-up' : s.score <= -0.1 ? 'bg-down' : 'bg-fg-secondary';
  return (
    <AiCard label="SENTIMENT">
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
            Aggregate · {s.volume.toLocaleString()} mentions · conf {(s.confidence * 100).toFixed(0)}%
          </span>
          <span className={`num text-lg ${s.score >= 0 ? 'text-up' : 'text-down'}`}>
            {s.score >= 0 ? '+' : ''}
            {s.score.toFixed(2)}
          </span>
        </div>
        <div className="h-1.5 bg-surface-2 rounded overflow-hidden relative">
          <div className="absolute inset-y-0 left-1/2 w-px bg-border-subtle" />
          <div className={`h-full ${color}`} style={{ width: `${Math.abs(pct - 50)}%`, marginLeft: pct < 50 ? `${pct}%` : '50%' }} />
        </div>
      </div>

      <div className="mb-4">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          24h sparkline
        </div>
        <Sparkline values={s.sparkline} />
      </div>

      <div className="grid grid-cols-5 gap-2 text-xs">
        {Object.entries(s.bySource).map(([src, b]) => (
          <div key={src} className="border border-border-subtle rounded p-2">
            <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">{src}</div>
            <div className={`num text-sm ${b.score >= 0 ? 'text-up' : 'text-down'}`}>
              {b.score >= 0 ? '+' : ''}
              {b.score.toFixed(2)}
            </div>
            <div className="text-[10px] text-fg-muted num">{b.volume.toLocaleString()} mentions</div>
          </div>
        ))}
      </div>

      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mt-5 mb-2">
        Recent mentions
      </h3>
      <ul className="space-y-2 text-sm">
        {t.mentions.map((m) => (
          <li key={m.id} className="border border-border-subtle/60 rounded p-2">
            <div className="flex items-baseline gap-2 text-[11px] text-fg-muted">
              <span className="font-mono uppercase">{m.source}</span>
              <span>· {m.publishedAtMinutesAgo}m ago</span>
              <span className={`ml-auto num ${m.score >= 0 ? 'text-up' : 'text-down'}`}>
                {m.score >= 0 ? '+' : ''}
                {m.score.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 leading-relaxed">{m.body}</div>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[11px] text-fg-muted italic">{DISCLAIMER}</p>
    </AiCard>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 320;
  const h = 36;
  const min = Math.min(...values, -0.1);
  const max = Math.max(...values, 0.1);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / (max - min)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const zeroY = h - ((0 - min) / (max - min)) * h;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-9">
      <line x1="0" x2={w} y1={zeroY} y2={zeroY} stroke="currentColor" className="text-border-subtle" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke="currentColor" className="text-ai" strokeWidth="1.5" />
    </svg>
  );
}

function NewsTab({ t }: { t: SampleTicker }) {
  return (
    <div className="border border-border-subtle bg-surface rounded">
      <ul>
        {t.news.map((n) => (
          <li key={n.id} className="border-b border-border-subtle last:border-b-0 px-4 py-3">
            <div className="flex items-baseline gap-2 text-[11px] text-fg-muted">
              <span className="font-mono uppercase">{n.source}</span>
              <span>· {n.publishedAtMinutesAgo}m ago</span>
              {n.sentiment && (
                <span
                  className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider ${
                    n.sentiment === 'bull'
                      ? 'bg-up/10 text-up'
                      : n.sentiment === 'bear'
                        ? 'bg-down/10 text-down'
                        : 'bg-surface-2 text-fg-secondary'
                  }`}
                >
                  {n.sentiment.toUpperCase()}
                </span>
              )}
            </div>
            <a href={n.url} className="block mt-1 text-sm hover:text-ai">
              {n.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartTab({ t, demo }: { t: SampleTicker; demo: boolean }) {
  type Range = 30 | 90 | 180;
  const [days, setDays] = useState<Range>(90);
  const history = useHistory(t.symbol, days, { enabled: !demo });

  // Pick the data source: live history when the backend is reachable,
  // otherwise fall back to the sample candles. Sample data is undated, so
  // we synthesize a trailing date series so the X-axis still labels.
  const candles: Candle[] = useMemo(() => {
    if (!demo && history.rows && history.rows.length > 0) {
      const slice = history.rows.slice(-days);
      return slice.map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
    }
    const slice = t.candles.slice(-days);
    const today = new Date();
    return slice.map((c, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (slice.length - 1 - i));
      return { ...c, t: d.toISOString().slice(0, 10) };
    });
  }, [demo, history.rows, days, t.candles]);

  const today = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const change = today && prev ? today.c - prev.c : 0;
  const changePct = today && prev && prev.c !== 0 ? (change / prev.c) * 100 : 0;
  const up = change >= 0;

  // Average volume across the visible window minus today, so today's volume
  // ratio is comparable to a true "recent average".
  const avgVol = useMemo(() => {
    if (candles.length <= 1) return 0;
    const prior = candles.slice(0, -1);
    const sum = prior.reduce((a, c) => a + c.v, 0);
    return sum / prior.length;
  }, [candles]);
  const volRatio = today && avgVol > 0 ? today.v / avgVol : null;

  const fmtVol = (v: number): string => {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return `${v}`;
  };

  const ranges: Range[] = [30, 90, 180];

  return (
    <div className="border border-border-subtle bg-surface rounded p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
          Price & Volume
        </h3>
        <div className="flex items-center gap-1 text-[11px]">
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className={`px-2 py-0.5 rounded border ${
                days === r
                  ? 'border-ai text-ai bg-ai/10'
                  : 'border-border-subtle text-fg-muted hover:text-fg-secondary'
              }`}
              aria-pressed={days === r}
              aria-label={`Show last ${r} days`}
            >
              {r}D
            </button>
          ))}
          {history.isLoading && (
            <span className="ml-2 text-fg-muted">loading…</span>
          )}
          {history.error && !demo && (
            <span
              className="ml-2 text-down"
              title={history.error}
              aria-label={`history fetch error: ${history.error}`}
            >
              ⚠ history error
            </span>
          )}
        </div>
      </div>

      {/* Today's stats strip */}
      {today && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <Stat label="Open" value={`$${today.o.toFixed(2)}`} />
          <Stat label="High" value={`$${today.h.toFixed(2)}`} />
          <Stat label="Low" value={`$${today.l.toFixed(2)}`} />
          <Stat
            label="Close"
            value={`$${today.c.toFixed(2)}`}
            sub={`${up ? '+' : ''}${change.toFixed(2)} (${up ? '+' : ''}${changePct.toFixed(2)}%)`}
            subClass={up ? 'text-up' : 'text-down'}
          />
          <Stat
            label="Volume"
            value={fmtVol(today.v)}
            sub={
              volRatio !== null
                ? `${volRatio.toFixed(2)}× avg`
                : undefined
            }
            subClass={
              volRatio !== null && volRatio >= 1.25
                ? 'text-up'
                : volRatio !== null && volRatio <= 0.75
                  ? 'text-down'
                  : 'text-fg-muted'
            }
          />
        </div>
      )}

      <div className="w-full">
        <CandleChart candles={candles} className="w-full h-[340px]" />
      </div>

      <p className="text-[11px] text-fg-muted italic">{DISCLAIMER}</p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  subClass,
}: {
  label: string;
  value: string;
  sub?: string;
  subClass?: string;
}) {
  return (
    <div className="border border-border-subtle rounded p-2">
      <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
        {label}
      </div>
      <div className="num text-sm text-fg">{value}</div>
      {sub && <div className={`num text-[11px] ${subClass ?? 'text-fg-muted'}`}>{sub}</div>}
    </div>
  );
}

function CalendarTab({ t }: { t: SampleTicker }) {
  const relevant = SAMPLE_CALENDAR.filter((ev) => !('symbol' in ev) || ev.symbol === t.symbol || ev.kind !== 'earnings');
  return (
    <div className="border border-border-subtle bg-surface rounded p-4">
      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-3">
        Upcoming for {t.symbol} + market
      </h3>
      <ul className="space-y-2 text-sm">
        {relevant.map((ev, i) => (
          <li key={i} className="flex items-center gap-3">
            <span className="num text-fg-muted text-xs w-10">+{ev.dateOffset}d</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider ${
                ev.kind === 'earnings'
                  ? 'bg-ai/10 text-ai'
                  : ev.kind === 'market_holiday'
                    ? 'bg-down/10 text-down'
                    : 'bg-warn/10 text-warn'
              }`}
            >
              {ev.kind.replace('market_', '').replace('_', ' ').toUpperCase()}
            </span>
            <span>{ev.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- M1: Ticker intake & validated list ----------------------------------

function TickerIntake({ demo }: { demo: boolean }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [results, setResults] = useState<ValidationResult[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    if (demo) return;
    try {
      const r = await fetch('/api/tickers');
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as { entries: WatchlistEntry[] };
      setEntries(j.entries);
    } catch (e) {
      setErr(`Could not load watchlist: ${(e as Error).message}`);
    }
  }, [demo]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  async function validate(refresh: boolean) {
    const symbols = input
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) return;
    setBusy(true);
    setErr(null);
    setResults([]);
    try {
      const r = await fetch('/api/tickers/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols, refresh }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`${r.status}: ${t}`);
      }
      const j = (await r.json()) as { results: ValidationResult[] };
      setResults(j.results);
      setInput('');
      await refreshList();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(symbol: string) {
    if (demo) return;
    await fetch(`/api/tickers/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
    await refreshList();
  }

  return (
    <div className="border border-border-subtle bg-surface rounded">
      <div className="p-2 border-b border-border-subtle">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          Add tickers
        </div>
        <div className="flex gap-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void validate(false);
            }}
            placeholder="NVDA AAPL META"
            disabled={busy || demo}
            className="flex-1 bg-surface-2 border border-border-subtle rounded px-2 py-1 text-xs focus:outline-none focus:border-ai disabled:opacity-50"
          />
          <button
            onClick={() => void validate(false)}
            disabled={busy || demo || !input.trim()}
            className="px-2 py-1 text-xs bg-ai/10 text-ai rounded border border-ai/30 hover:bg-ai/20 disabled:opacity-40"
            title="Validate and add"
          >
            Add
          </button>
          <button
            onClick={() => void validate(true)}
            disabled={busy || demo || !input.trim()}
            className="px-2 py-1 text-xs bg-surface-2 text-fg-secondary rounded border border-border-subtle hover:text-fg disabled:opacity-40"
            title="Force re-validation, bypass 7-day cache"
          >
            ↻
          </button>
        </div>
        {demo && (
          <div className="mt-1.5 text-[10px] text-fg-muted">
            Demo mode — backend not reachable. Start the server to add real tickers.
          </div>
        )}
        {err && <div className="mt-1.5 text-[10px] text-down">{err}</div>}
        {busy && <div className="mt-1.5 text-[10px] text-fg-muted">Validating…</div>}
      </div>

      {results.length > 0 && (
        <div className="border-b border-border-subtle p-2 space-y-2">
          {results.map((r, i) => (
            <ResultRow key={i} r={r} />
          ))}
          <p className="text-[10px] text-fg-muted italic">{DISCLAIMER}</p>
        </div>
      )}

      <div>
        <div className="px-2 pt-2 text-[10px] font-mono tracking-wider text-fg-muted uppercase">
          Validated ({entries.length})
        </div>
        {entries.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-fg-muted">
            No validated tickers yet.
          </div>
        ) : (
          <ul className="text-xs">
            {entries.map((e) => (
              <li
                key={e.profile.symbol}
                className="px-3 py-2 flex items-baseline gap-2 border-t border-border-subtle/40"
                title={e.profile.description}
              >
                <span className="font-semibold tracking-tight w-12">{e.profile.symbol}</span>
                <span className="text-fg-secondary truncate flex-1">{e.profile.name}</span>
                <span className="text-[10px] text-fg-muted">{e.profile.exchange}</span>
                <button
                  onClick={() => void remove(e.profile.symbol)}
                  className="text-fg-muted hover:text-down text-[10px]"
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ResultRow({ r }: { r: ValidationResult }) {
  if (r.ok) {
    return (
      <div className="text-[11px]">
        <div>
          <span className="text-up">✓</span>{' '}
          <span className="font-semibold">{r.profile.symbol}</span>{' '}
          <span className="text-fg-secondary">{r.profile.name}</span>{' '}
          <span className="text-fg-muted">· {r.profile.exchange}</span>
          {r.cached && <span className="text-fg-muted"> · cached</span>}
        </div>
        <div className="text-fg-muted">
          {r.profile.sector} / {r.profile.industry}
        </div>
        <div className="text-fg">{r.profile.description}</div>
      </div>
    );
  }
  return (
    <div className="text-[11px]">
      <div className="text-down">✗ {r.symbol}: {r.error}</div>
      {r.suggestions && r.suggestions.length > 0 && (
        <div className="text-fg-muted mt-0.5">
          Did you mean: {r.suggestions.map((s) => s.symbol).join(', ')}
        </div>
      )}
    </div>
  );
}
