import React from 'react';
import type { ValidationResult } from '../types.js';

/**
 * One row in the post-validation result list inside `TickerIntake`. Splits
 * the "ok" / "error" branches without leaking the discriminated union to
 * the rest of the form. Extracted from App.tsx in #112.
 */
export function ResultRow({ r }: { r: ValidationResult }): JSX.Element {
  if (r.ok) {
    return (
      <div className="text-[11px]">
        <div>
          <span className="text-up">✓</span>{' '}
          <span className="font-semibold">{r.profile.symbol}</span>{' '}
          <span className="text-fg-secondary">{r.profile.name}</span>{' '}
          <span className="text-fg-muted">· {r.profile.exchange}</span>
          {r.cached && <span className="text-fg-muted"> · cached</span>}
        </div>
        <div className="text-fg-muted">
          {r.profile.sector} / {r.profile.industry}
        </div>
        <div className="text-fg">{r.profile.description}</div>
      </div>
    );
  }
  return (
    <div className="text-[11px]">
      <div className="text-down">
        ✗ {r.symbol}: {r.error}
      </div>
      {r.suggestions && r.suggestions.length > 0 && (
        <div className="text-fg-muted mt-0.5">
          Did you mean: {r.suggestions.map((s) => s.symbol).join(', ')}
        </div>
      )}
    </div>
  );
}
