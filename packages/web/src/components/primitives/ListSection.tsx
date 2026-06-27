import React from 'react';

/**
 * Title + bulleted list, used for "Catalysts" / "Risks" in the briefing
 * tab. Extracted from App.tsx in #112.
 */
export function ListSection({
  title,
  items,
}: {
  title: string;
  items: string[];
}): JSX.Element {
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
