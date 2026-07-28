import { type PartialTickerProfile, type TickerProfile } from '../schemas/ticker.js';
import {
  ReconcileConflictError,
  type ReconcileConflict,
  reconcile as reconcileFromSources,
} from './reconcile.js';
import type { TickerSource } from './source.js';

/**
 * Per-source result captured by the resolver. Useful for diagnostics on
 * failure and for tests asserting which sources contributed.
 */
export interface SourceOutcome {
  source: string;
  ok: boolean;
  /** Reason the source did not contribute, if `ok` is false. */
  reason?: 'missing' | 'timeout' | 'error';
  error?: string;
  /** The partial returned by the source, if any. */
  partial?: PartialTickerProfile;
}

export interface TickerResolutionDiagnostics {
  kind: 'no-match' | 'conflict' | 'reconciliation';
  conflicts?: ReconcileConflict[];
  notes?: string[];
}

export class TickerResolutionError extends Error {
  readonly input: string;
  readonly outcomes: SourceOutcome[];
  readonly diagnostics?: TickerResolutionDiagnostics;

  constructor(
    message: string,
    input: string,
    outcomes: SourceOutcome[],
    diagnostics?: TickerResolutionDiagnostics,
  ) {
    super(message);
    this.name = 'TickerResolutionError';
    this.input = input;
    this.outcomes = outcomes;
    this.diagnostics = diagnostics;
  }
}

export interface TickerResolverOptions {
  /** Per-resolve global timeout, in milliseconds. Default 4000. */
  timeoutMs?: number;
  /**
   * Minimum consensus share required when sources disagree on identity fields.
   * Lower values are more permissive. Default 0.55.
   */
  conflictThreshold?: number;
}

const SYMBOL_RE = /^[A-Za-z.\-]{1,10}$/;

function isLikelySymbol(input: string): boolean {
  return SYMBOL_RE.test(input);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Compatibility wrapper for direct unit tests and external callers.
 * New reconciliation logic lives in `tickers/reconcile.ts` and accepts inputs
 * in the form `{ source, partial }`.
 */
export function reconcile(
  partials: ReadonlyArray<{ partial: PartialTickerProfile; weight: number; sourceName: string }>,
  totalWeight: number,
  validatedAt: string,
): TickerProfile {
  return reconcileFromSources(
    partials.map((entry) => ({
      partial: entry.partial,
      source: {
        name: entry.sourceName,
        weight: entry.weight,
      },
    })),
    {
      totalWeight,
      validatedAt,
    },
  );
}

/**
 * Orchestrates a set of `TickerSource`s in parallel with a global timeout,
 * then reconciles their partials into a single `TickerProfile`.
 *
 * Throws `TickerResolutionError` if no source produced a usable partial.
 */
export class TickerResolver {
  private readonly sources: ReadonlyArray<TickerSource>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly conflictThreshold: number;

  constructor(sources: ReadonlyArray<TickerSource>, opts: TickerResolverOptions & { now?: () => Date } = {}) {
    this.sources = sources;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.now = opts.now ?? (() => new Date());
    this.conflictThreshold = opts.conflictThreshold ?? 0.55;
  }

  /**
   * Resolve free-text input (a symbol or a company-name-ish query) into a
   * single `TickerProfile`. Runs every configured source in parallel; the
   * whole call is bounded by `timeoutMs`.
   */
  async resolve(input: string): Promise<TickerProfile> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new TickerResolutionError('empty input', input, [], {
        kind: 'reconciliation',
      });
    }
    if (this.sources.length === 0) {
      throw new TickerResolutionError('no sources configured', input, [], {
        kind: 'reconciliation',
      });
    }

    const symbolMode = isLikelySymbol(trimmed);
    const normalizedSymbol = symbolMode ? trimmed.toUpperCase() : null;

    const totalWeight = this.sources.reduce((s, src) => s + src.weight, 0);
    const outcomes: SourceOutcome[] = [];
    const contributors: { partial: PartialTickerProfile; weight: number; sourceName: string }[] = [];

    const tasks = this.sources.map(async (src): Promise<void> => {
      try {
        const result = await withTimeout<PartialTickerProfile | PartialTickerProfile[] | null>(
          normalizedSymbol !== null ? src.fetch(normalizedSymbol) : src.search(trimmed).then((rs) => rs[0] ?? null),
          this.timeoutMs,
        );
        if (result === null || (Array.isArray(result) && result.length === 0)) {
          outcomes.push({ source: src.name, ok: false, reason: 'missing' });
          return;
        }
        const partial = Array.isArray(result) ? result[0]! : result;
        outcomes.push({ source: src.name, ok: true, partial });
        contributors.push({ partial, weight: src.weight, sourceName: src.name });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const reason: SourceOutcome['reason'] = msg === 'timeout' ? 'timeout' : 'error';
        outcomes.push({ source: src.name, ok: false, reason, error: msg });
      }
    });

    await Promise.all(tasks);

    if (contributors.length === 0) {
      throw new TickerResolutionError(`no source could resolve "${input}"`, input, outcomes, {
        kind: 'no-match',
      });
    }

    try {
      return reconcileFromSources(
        contributors.map((entry) => ({
          partial: entry.partial,
          source: {
            name: entry.sourceName,
            weight: entry.weight,
          },
        })),
        {
          totalWeight,
          validatedAt: this.now().toISOString(),
          conflictThreshold: this.conflictThreshold,
        },
      );
    } catch (err) {
      if (err instanceof ReconcileConflictError) {
        throw new TickerResolutionError(
          `reconciliation conflict: ${err.message}`,
          input,
          outcomes,
          {
            kind: 'conflict',
            conflicts: err.conflicts,
            notes: err.notes,
          },
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new TickerResolutionError(`reconciliation failed: ${msg}`, input, outcomes, {
        kind: 'reconciliation',
      });
    }
  }
}
