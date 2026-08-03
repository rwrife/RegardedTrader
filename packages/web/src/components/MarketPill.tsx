import React from 'react';

/**
 * Status-bar pill that shows market open/closed and an optional note (e.g.
 * "early close").
 */
export function MarketPill({
  label,
  note,
  mutedNote = false,
  stale = false,
}: {
  label: string;
  note?: string;
  mutedNote?: boolean;
  stale?: boolean;
}): JSX.Element {
  const low = label.toLowerCase();
  const color =
    low.includes('open')
      ? 'text-up'
      : low.includes('holiday') || low.includes('closed')
        ? 'text-down'
        : 'text-fg-secondary';
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color.replace('text-', 'bg-')}`} />
      {stale && (
        <span
          data-testid="market-stale-dot"
          title="Calendar data may be stale"
          className="inline-block w-1.5 h-1.5 rounded-full bg-warn"
        />
      )}
      <span className={color}>{label}</span>
      {note && <span className={mutedNote ? 'text-fg-muted' : 'text-fg-secondary'}>· {note}</span>}
    </span>
  );
}
