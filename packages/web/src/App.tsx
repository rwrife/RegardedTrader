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
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">
          📈 <span className="text-emerald-400">Regarded</span>Trader
        </h1>
        <span className="text-xs text-zinc-500">local · educational · not advice</span>
      </header>

      <form onSubmit={run} className="flex gap-2">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 flex-1 font-mono uppercase"
          placeholder="TICKER"
        />
        <button
          type="submit"
          className="bg-emerald-500 text-zinc-950 font-medium px-4 py-2 rounded disabled:opacity-50"
          disabled={loading}
        >
          {loading ? 'thinking…' : 'briefing'}
        </button>
      </form>

      {err && <div className="text-rose-400 text-sm whitespace-pre-wrap">{err}</div>}

      {data && (
        <div className="space-y-4">
          <div className="border border-zinc-800 rounded p-4">
            <div className="flex items-baseline gap-3">
              <span className="text-xl font-bold">{data.symbol}</span>
              <span className={data.quote.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                ${data.quote.price.toFixed(2)} ({data.quote.changePercent.toFixed(2)}%)
              </span>
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              RSI {data.indicators.rsi14?.toFixed(1) ?? '—'} · SMA20{' '}
              {data.indicators.sma20?.toFixed(2) ?? '—'} · SMA50{' '}
              {data.indicators.sma50?.toFixed(2) ?? '—'}
            </div>
          </div>

          <Section title="Bull case" color="emerald" body={data.bullCase} />
          <Section title="Bear case" color="rose" body={data.bearCase} />

          {data.catalysts.length > 0 && <ListSection title="Catalysts" items={data.catalysts} />}
          {data.risks.length > 0 && <ListSection title="Risks" items={data.risks} />}

          <p className="text-xs text-zinc-500 italic">{data.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, color, body }: { title: string; color: 'emerald' | 'rose'; body: string }) {
  const cls = color === 'emerald' ? 'text-emerald-400' : 'text-rose-400';
  return (
    <div>
      <h2 className={`font-semibold ${cls}`}>{title}</h2>
      <p className="text-sm leading-relaxed">{body}</p>
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h2 className="font-semibold">{title}</h2>
      <ul className="list-disc list-inside text-sm space-y-1">
        {items.map((i, idx) => (
          <li key={idx}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
