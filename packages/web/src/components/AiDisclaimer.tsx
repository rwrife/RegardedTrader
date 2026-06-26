import React from 'react';
import { DISCLAIMER } from '@regardedtrader/core/constants';

/**
 * Shared "not financial advice" disclaimer (issue #154).
 *
 * Single source of truth: `DISCLAIMER` from `@regardedtrader/core` (issue #77).
 * Every web AI surface should render this component (or pass `DISCLAIMER`
 * through an envelope) so the wording stays in sync with the schema-side
 * disclaimer used by `AiOutputEnvelope`.
 *
 * Defaults to the AI-card footer style described in `docs/design.md`
 * (`text.muted` italic at ~11px). Callers can override via `className` for
 * tighter contexts (e.g. status rails, command palette results).
 */
export interface AiDisclaimerProps {
  /** Tailwind classes to override default footer styling. */
  className?: string;
  /** Optional spacing above the disclaimer (defaults to a small top margin). */
  marginTop?: 'none' | 'sm' | 'md';
}

const MARGIN_CLASS: Record<NonNullable<AiDisclaimerProps['marginTop']>, string> = {
  none: '',
  sm: 'mt-2',
  md: 'mt-6',
};

export function AiDisclaimer({
  className,
  marginTop = 'md',
}: AiDisclaimerProps): JSX.Element {
  const base = 'text-[11px] text-fg-muted italic';
  const cls = className ?? `${MARGIN_CLASS[marginTop]} ${base}`.trim();
  return (
    <p className={cls} data-testid="ai-disclaimer">
      {DISCLAIMER}
    </p>
  );
}

export { DISCLAIMER };
