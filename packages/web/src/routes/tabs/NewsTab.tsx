import React from 'react';
import type { SampleTicker } from '../../sample-data.js';

/**
 * Headlines list, color-coded by sentiment tag. Not an AI surface — these
 * are raw headlines from the NewsScout feed, so no `<AiDisclaimer />`.
 * Extracted from App.tsx in #112.
 */
export function NewsTab({ t }: { t: SampleTicker }): JSX.Element {
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
