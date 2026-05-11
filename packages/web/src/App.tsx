import React, { useState } from 'react';

interface Briefing {
  symbol: string;
  quote: { price: number; change: number; changePercent: number };
  indicators: { rsi14: number | null; sma20: number | null; sma50: number | null };
  bullCase: string;
  bearCase: string;
  catalysts: string[];
  risks: string[];
  disclaimer: string;
}

export function App() {
  const [symbol, setSymbol] = useState('NVDA');
  const [data, setData] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const res = await fetch(`/api/briefing/${encodeURIComponent(symbol.toUpperCase())}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-app text-fg">
      {/* Top status bar */}
      <header className="border-b border-border-subtle bg-surface">
        <div className="max-w-6xl mx-auto px-6 h-12 flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 font-semibold">
            <span className="text-up">▲</span>
            <span className="tracking-tight">RegardedTrader</span>
          </div>
          <span className="text-fg-muted">·</span>
          <span className="num text-fg-secondary">local · 127.0.0.1:4317</span>
          <div className="ml-auto flex items-center gap-3 text-fg-muted">
            <span className="num">{new Date().toUTCString().slice(17, 25)} UTC</span>
            <kbd className="px-1.5 py-0.5 rounded border border-border-subtle text-[10px]">
              ⌘K
            </kbd>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <form onSubmit={run} className="flex gap-2">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="flex-1 bg-surface-2 border border-border-subtle rounded px-3 py-2 num uppercase tracking-wider focus:outline-none focus:border-ai"
            placeholder="TICKER"
            aria-label="Ticker symbol"
          />
          <button
            type="submit"
            className="bg-ai text-app font-medium px-4 py-2 rounded disabled:opacity-50 hover:brightness-110"
            disabled={loading}
          >
            {loading ? 'thinking…' : 'briefing'}
          </button>
        </form>

        {err && (
          <div className="border border-down/40 bg-down-soft/40 rounded px-4 py-3 text-sm">
            <span className="text-down mr-2">●</span>
            {err}
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <QuoteHeader symbol={data.symbol} quote={data.quote} indicators={data.indicators} />
            <AiCard>
              <div className="grid md:grid-cols-2 gap-6">
                <Section title="Bull case" tone="up" body={data.bullCase} />
                <Section title="Bear case" tone="down" body={data.bearCase} />
              </div>
              <div className="grid md:grid-cols-2 gap-6 mt-6">
                {data.catalysts.length > 0 && (
                  <ListSection title="Catalysts" items={data.catalysts} />
                )}
                {data.risks.length > 0 && <ListSection title="Risks" items={data.risks} />}
              </div>
              <p className="mt-6 text-[11px] text-fg-muted italic">{data.disclaimer}</p>
            </AiCard>
          </div>
        )}
      </main>
    </div>
  );
}

function QuoteHeader({
  symbol,
  quote,
  indicators,
}: {
  symbol: string;
  quote: Briefing['quote'];
  indicators: Briefing['indicators'];
}) {
  const up = quote.change >= 0;
  const toneText = up ? 'text-up' : 'text-down';
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '';
  return (
    <div className="border border-border-subtle bg-surface rounded p-4 flex items-baseline gap-6">
      <div className="flex items-baseline gap-3">
        <span className="text-xl font-semibold tracking-tight">{symbol}</span>
        <span className={`num text-2xl ${toneText}`}>${quote.price.toFixed(2)}</span>
        <span className={`num text-sm ${toneText}`}>
          {arrow} {sign}
          {quote.change.toFixed(2)} ({sign}
          {quote.changePercent.toFixed(2)}%)
        </span>
      </div>
      <div className="ml-auto flex gap-4 text-xs text-fg-secondary num">
        <span>
          RSI <span className="text-fg">{indicators.rsi14?.toFixed(1) ?? '—'}</span>
        </span>
        <span>
          SMA20 <span className="text-fg">{indicators.sma20?.toFixed(2) ?? '—'}</span>
        </span>
        <span>
          SMA50 <span className="text-fg">{indicators.sma50?.toFixed(2) ?? '—'}</span>
        </span>
      </div>
    </div>
  );
}

function AiCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative border border-border-subtle bg-surface rounded p-6 pl-7">
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-ai rounded-l" />
      <div className="absolute left-3 top-3">
        <span className="text-[10px] font-mono tracking-wider px-1.5 py-0.5 rounded bg-ai/10 text-ai">
          AI
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
      <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-secondary">
        {title}
      </h2>
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
