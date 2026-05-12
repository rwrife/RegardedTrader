import React, { useEffect, useMemo, useState } from 'react';
import {
  SAMPLE_TICKERS,
  SAMPLE_CALENDAR,
  SAMPLE_MARKET_STATE,
  findSample,
  type SampleTicker,
  type SampleVerdict,
} from './sample-data';

const DISCLAIMER =
  'Not financial advice. AI-generated analysis based on public data. Verify everything before trading.';

type Tab = 'briefing' | 'sentiment' | 'news' | 'recommendation' | 'calendar';

export function App() {
  // Demo mode is on whenever the backend is unreachable or ?demo=1 is set.
  const demoForced = typeof window !== 'undefined' && /[?&]demo=1\b/.test(window.location.search);
  const [demo, setDemo] = useState<boolean>(demoForced || true);
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
      <TopBar demo={demo} />

      <div className="max-w-7xl mx-auto px-6 py-4 grid grid-cols-12 gap-6">
        {/* Sidebar: watchlist + calendar strip */}
        <aside className="col-span-12 md:col-span-3 space-y-4">
          <Watchlist
            active={active}
            onPick={setActive}
            query={query}
            setQuery={setQuery}
          />
          <CalendarStrip />
        </aside>

        {/* Main column */}
        <main className="col-span-12 md:col-span-9 space-y-4">
          {ticker ? (
            <>
              <QuoteHeader t={ticker} />
              <TabBar tab={tab} setTab={setTab} />
              {tab === 'briefing' && <BriefingTab t={ticker} />}
              {tab === 'sentiment' && <SentimentTab t={ticker} />}
              {tab === 'news' && <NewsTab t={ticker} />}
              {tab === 'recommendation' && <RecommendationTab t={ticker} />}
              {tab === 'calendar' && <CalendarTab t={ticker} />}
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

function TopBar({ demo }: { demo: boolean }) {
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
}: {
  active: string;
  onPick: (s: string) => void;
  query: string;
  setQuery: (s: string) => void;
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
        {filtered.map((t) => {
          const up = t.quote.change >= 0;
          return (
            <li key={t.symbol}>
              <button
                onClick={() => onPick(t.symbol)}
                className={`w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-surface-2 ${
                  active === t.symbol ? 'bg-surface-2' : ''
                }`}
              >
                <span className="font-semibold tracking-tight w-12">{t.symbol}</span>
                <span className="num text-fg-secondary">${t.quote.price.toFixed(2)}</span>
                <span className={`num ml-auto ${up ? 'text-up' : 'text-down'}`}>
                  {up ? '▲' : '▼'} {up ? '+' : ''}
                  {t.quote.changePercent.toFixed(2)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
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

function QuoteHeader({ t }: { t: SampleTicker }) {
  const up = t.quote.change >= 0;
  const toneText = up ? 'text-up' : 'text-down';
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '';
  return (
    <div className="border border-border-subtle bg-surface rounded p-4">
      <div className="flex items-baseline gap-4 flex-wrap">
        <div className="flex items-baseline gap-3">
          <span className="text-xl font-semibold tracking-tight">{t.symbol}</span>
          <span className="text-xs text-fg-muted">{t.name}</span>
        </div>
        <span className={`num text-2xl ${toneText}`}>${t.quote.price.toFixed(2)}</span>
        <span className={`num text-sm ${toneText}`}>
          {arrow} {sign}
          {t.quote.change.toFixed(2)} ({sign}
          {t.quote.changePercent.toFixed(2)}%)
        </span>
        {t.earnings.daysUntil !== null && t.earnings.daysUntil <= 14 && (
          <span className="px-2 py-0.5 rounded bg-warn/10 text-warn text-[10px] font-mono tracking-wider">
            EARNINGS IN {t.earnings.daysUntil}D · {t.earnings.when.toUpperCase()}
          </span>
        )}
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

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'briefing', label: 'Briefing' },
    { id: 'recommendation', label: 'Recommendation' },
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
  return (
    <AiCard>
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
