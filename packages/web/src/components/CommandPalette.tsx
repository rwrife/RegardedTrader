import React, { useEffect, useMemo, useState } from 'react';

export interface CommandPaletteItem {
  id: string;
  label: string;
  group: 'Watchlist' | 'Views' | 'AI';
  keywords: string[];
  onSelect: () => void;
}

interface ScoredItem {
  item: CommandPaletteItem;
  score: number;
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function scoreItem(item: CommandPaletteItem, query: string): number | null {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const haystack = normalize(`${item.label} ${item.group} ${item.keywords.join(' ')}`);

  let score = 0;
  for (const token of tokens) {
    const idx = haystack.indexOf(token);
    if (idx < 0) return null;
    score += idx;
  }

  if (normalize(item.label).startsWith(normalizedQuery)) score -= 100;
  return score;
}

export function CommandPalette({
  open,
  items,
  onClose,
}: {
  open: boolean;
  items: CommandPaletteItem[];
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const results = useMemo(() => {
    const scored: ScoredItem[] = [];
    for (const item of items) {
      const score = scoreItem(item, query);
      if (score === null) continue;
      scored.push({ item, score });
    }
    scored.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
    return scored.map((entry) => entry.item);
  }, [items, query]);

  useEffect(() => {
    if (active < results.length) return;
    setActive(results.length === 0 ? 0 : results.length - 1);
  }, [active, results.length]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-app/75 pt-20">
      <button
        type="button"
        aria-label="Close command palette"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-[min(44rem,92vw)] rounded border border-ai/40 bg-surface shadow-2xl"
      >
        <div className="border-b border-border-subtle px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const next = results[active];
                if (!next) return;
                next.onSelect();
                onClose();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Type a command…"
            className="w-full bg-surface-2 border border-border-subtle rounded px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ai focus:border-ai"
          />
          <p className="mt-1 text-[10px] text-fg-muted">
            Watchlist tickers, top-level views, and AI actions. Try: <span className="num">plan TSLA</span>
          </p>
        </div>

        <ul className="max-h-80 overflow-auto p-1">
          {results.length === 0 ? (
            <li className="px-2 py-4 text-xs text-fg-muted">No matches.</li>
          ) : (
            results.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    item.onSelect();
                    onClose();
                  }}
                  className={`w-full rounded px-2 py-1.5 text-left text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-ai ${
                    index === active
                      ? 'bg-ai/15 border border-ai/40 text-fg'
                      : 'border border-transparent text-fg-secondary hover:text-fg hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-[10px] uppercase tracking-wider text-fg-muted">{item.group}</span>
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
