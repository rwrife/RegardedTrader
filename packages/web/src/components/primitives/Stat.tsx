import React from 'react';

/**
 * Compact label/value tile used in the chart tab's "Today's stats" strip.
 * Extracted from App.tsx in #112.
 */
export function Stat({
  label,
  value,
  sub,
  subClass,
}: {
  label: string;
  value: string;
  sub?: string;
  subClass?: string;
}): JSX.Element {
  return (
    <div className="border border-border-subtle rounded p-2">
      <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">{label}</div>
      <div className="num text-sm text-fg">{value}</div>
      {sub && <div className={`num text-[11px] ${subClass ?? 'text-fg-muted'}`}>{sub}</div>}
    </div>
  );
}
