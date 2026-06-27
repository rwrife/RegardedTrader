import React from 'react';

/**
 * Two-column "Bull/Bear case" prose block used in the briefing tab.
 * Extracted from App.tsx in #112.
 */
export function Section({
  title,
  tone,
  body,
}: {
  title: string;
  tone: 'up' | 'down';
  body: string;
}): JSX.Element {
  const cls = tone === 'up' ? 'text-up' : 'text-down';
  return (
    <div>
      <h2 className={`text-sm font-semibold uppercase tracking-wider ${cls}`}>{title}</h2>
      <p className="text-sm leading-relaxed text-fg mt-2">{body}</p>
    </div>
  );
}
