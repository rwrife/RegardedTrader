import React from 'react';

/**
 * Card wrapper for AI-generated content. Adds the left-edge accent stripe and
 * an "AI" badge as described in `docs/design.md`. Extracted from App.tsx in
 * #112.
 */
export function AiCard({
  children,
  label = 'AI',
}: {
  children: React.ReactNode;
  label?: string;
}): JSX.Element {
  return (
    <div className="relative border border-border-subtle bg-surface rounded p-6 pl-7">
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-ai rounded-l" />
      <div className="absolute left-3 top-3">
        <span className="text-[10px] font-mono tracking-wider px-1.5 py-0.5 rounded bg-ai/10 text-ai">
          {label}
        </span>
      </div>
      <div className="pt-4">{children}</div>
    </div>
  );
}
