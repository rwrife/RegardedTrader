import React, { useEffect, useState } from 'react';
import type { HeadlineBundle } from '@regardedtrader/core';
import type { SampleTicker } from '../../sample-data.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

type NewsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; bundle: HeadlineBundle };

export function buildNewsUrl(symbol: string): string {
  return `/api/news/${encodeURIComponent(symbol.toUpperCase())}`;
}

/**
 * News rail parity for issue #75.
 * - demo=true: show deterministic sample headlines
 * - demo=false: fetch ranked HeadlineBundle from GET /api/news/:symbol
 */
export function NewsTab({ t, demo }: { t: SampleTicker; demo: boolean }): JSX.Element {
  const [state, setState] = useState<NewsState>(() =>
    demo ? { kind: 'error', message: '' } : { kind: 'loading' },
  );

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    fetch(buildNewsUrl(t.symbol))
      .then(async (res) => {
        const text = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: 'error', message: text || `HTTP ${res.status}` });
          return;
        }
        setState({ kind: 'ok', bundle: JSON.parse(text) as HeadlineBundle });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [demo, t.symbol]);

  if (demo || state.kind === 'error') {
    return (
      <div className="border border-border-subtle bg-surface rounded">
        {state.kind === 'error' && !demo && (
          <div className="px-4 py-2 text-xs text-amber-300 border-b border-border-subtle">
            NewsScout unavailable: {state.message}
          </div>
        )}
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

  if (state.kind === 'loading') {
    return (
      <div className="border border-border-subtle bg-surface rounded px-4 py-3 text-sm text-fg-muted">
        Loading ranked headlines…
      </div>
    );
  }

  return (
    <div className="border border-border-subtle bg-surface rounded">
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="text-sm">{state.bundle.summary}</div>
      </div>
      <ul>
        {state.bundle.headlines.map((n) => (
          <li key={n.id} className="border-b border-border-subtle last:border-b-0 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-fg-muted">
              <span className="font-mono uppercase">{n.source}</span>
              <span className="font-mono text-ai">{n.id}</span>
              <span>R {n.relevance}/5</span>
              <span>M {n.materiality}/5</span>
            </div>
            <a href={n.url} className="block mt-1 text-sm hover:text-ai">
              {n.title}
            </a>
            <div className="mt-1 text-xs text-fg-muted">{n.rationale}</div>
          </li>
        ))}
      </ul>
      <div className="px-4 py-3">
        <AiDisclaimer marginTop="none" className="italic opacity-70" />
      </div>
    </div>
  );
}
