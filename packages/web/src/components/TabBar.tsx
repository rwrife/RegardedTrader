import React from 'react';
import type { Tab } from '../types.js';

/**
 * Horizontal tab bar above the main column. The active tab gets the AI
 * accent underline. Extracted from App.tsx in #112.
 */
export function TabBar({
  tab,
  setTab,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
}): JSX.Element {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'briefing', label: 'Briefing' },
    { id: 'recommendation', label: 'Recommendation' },
    { id: 'chart', label: 'Chart' },
    { id: 'tech', label: 'Tech' },
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
